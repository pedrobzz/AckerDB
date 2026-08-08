import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { STUDIO_PATH_PREFIX } from "../src/origin.ts";
import {
  MAX_BUFFERED_FRAME_BYTES,
  proxyWebSocketHandlers,
  type ProxiedSocketData,
} from "../src/launcher/proxy.ts";
import { startStudio, type RunningStudio } from "../src/launcher/server.ts";

const INDEX_HTML = "<!doctype html><html><body>studio-index</body></html>";
const APP_JS = "console.log('studio-asset');";

let distDir: string;
let upstream: Server<undefined>;
const running: RunningStudio[] = [];

beforeAll(() => {
  distDir = mkdtempSync(join(tmpdir(), "ackerdb-studio-dist-"));
  writeFileSync(join(distDir, "index.html"), INDEX_HTML);
  mkdirSync(join(distDir, "assets"));
  writeFileSync(join(distDir, "assets", "app.js"), APP_JS);

  // A stand-in application: the routes a real one answers on GET (a query, an
  // Admin API address, a liveness probe) plus the not_found every other path
  // gets — which is exactly what the proxy must let through untouched.
  upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === "/_ws") {
        if (server.upgrade(request)) return undefined as unknown as Response;
        return new Response("not a websocket", { status: 400 });
      }
      if (url.pathname === "/admin/system/info" || url.pathname === "/api/echo") {
        return Response.json(
          {
            method: request.method,
            path: url.pathname + url.search,
            body: request.method === "POST" ? await request.text() : null,
            authorization: request.headers.get("authorization"),
          },
          { headers: { "x-upstream": "yes" } },
        );
      }
      if (url.pathname === "/api/stream") {
        return new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(new TextEncoder().encode("data: one\n\n"));
              await Bun.sleep(10);
              controller.enqueue(new TextEncoder().encode("data: two\n\n"));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return Response.json({ outcome: "not_found", path: url.pathname }, { status: 404 });
    },
    websocket: {
      message(ws, message) {
        ws.send(message);
      },
    },
  });
});

afterAll(() => {
  upstream.stop(true);
  rmSync(distDir, { recursive: true, force: true });
});

afterEach(() => {
  while (running.length > 0) running.pop()!.stop();
});

function studio(options: { target?: string } = {}): RunningStudio {
  const started = startStudio({
    target: options.target ?? `http://127.0.0.1:${upstream.port}`,
    port: 0,
    distDir,
  });
  running.push(started);
  return started;
}

/** The Studio origin, without the SPA prefix the running URL carries. */
function origin(studio: RunningStudio): string {
  return new URL(studio.url).origin;
}

/** One HTTP/1.1 request with the request target written verbatim, response and all. */
async function rawRequest(studio: RunningStudio, target: string): Promise<string> {
  const { promise, resolve } = Promise.withResolvers<string>();
  let received = "";
  const socket = await Bun.connect({
    hostname: "127.0.0.1",
    port: studio.port,
    socket: {
      data: (_socket, chunk) => {
        received += chunk.toString();
      },
      close: () => resolve(received),
    },
  });
  socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
  return promise;
}

function deadPort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

const HTML = { accept: "text/html,application/xhtml+xml" } as const;

test("startStudio refuses a missing bundle and a non-http target", () => {
  expect(() =>
    startStudio({ target: "http://127.0.0.1:1", port: 0, distDir: join(distDir, "absent") }))
    .toThrow("Studio bundle is missing");
  expect(() => startStudio({ target: "ftp://127.0.0.1:1", port: 0, distDir }))
    .toThrow("http or https");
  expect(() => startStudio({ target: "not a url", port: 0, distDir }))
    .toThrow("is not a URL");
});

test("the printed URL is the origin plus the SPA prefix", () => {
  const started = studio();
  expect(new URL(started.url).pathname).toBe(STUDIO_PATH_PREFIX);
});

describe("the SPA prefix", () => {
  test("serves the shell, the bundled assets, and every client-side route under it", async () => {
    const started = studio();
    const index = await fetch(started.url, { headers: HTML });
    expect(await index.text()).toBe(INDEX_HTML);

    const asset = await fetch(new URL("assets/app.js", started.url));
    expect(await asset.text()).toBe(APP_JS);
    expect(asset.headers.get("content-type")).toContain("javascript");

    const route = await fetch(new URL("database/users", started.url), { headers: HTML });
    expect(await route.text()).toBe(INDEX_HTML);
  });

  test("a browser landing on the bare origin is redirected into it", async () => {
    const started = studio();
    const landing = await fetch(origin(started), { headers: HTML, redirect: "manual" });
    expect(landing.status).toBe(302);
    expect(landing.headers.get("location")).toBe(STUDIO_PATH_PREFIX);
  });

  test("a path traversal never escapes the bundle directory", async () => {
    // `fetch` normalizes `..` out of a path before it is sent, so the escape
    // has to be hidden from URL parsing and sent raw: `..%2f` is one ordinary
    // segment until the launcher decodes it. The target is a real readable file
    // one directory above the bundle, so a passing guard is the only reason it
    // is not served.
    const outside = join(distDir, "..", "ackerdb-studio-outside.txt");
    writeFileSync(outside, "SECRET-OUTSIDE-THE-BUNDLE");
    try {
      const started = studio();
      const escaped = await rawRequest(
        started,
        `${STUDIO_PATH_PREFIX}assets/..%2f..%2fackerdb-studio-outside.txt`,
      );
      // Not a bundled file, so it is an ordinary SPA route — never the host disk.
      expect(escaped).toContain(INDEX_HTML);
      expect(escaped).not.toContain("SECRET-OUTSIDE-THE-BUNDLE");
    } finally {
      rmSync(outside, { force: true });
    }
  });

  test("refuses a method the bundle has no answer for instead of proxying it", async () => {
    const started = studio();
    const posted = await fetch(new URL("assets/app.js", started.url), { method: "POST" });
    expect(posted.status).toBe(405);
    expect(posted.headers.get("allow")).toBe("GET, HEAD");
  });
});

describe("everything outside the prefix", () => {
  test("reaches the application even when the browser asks for HTML", async () => {
    // The shadowing failure this rule exists to prevent: queries and Admin API
    // addresses answer GET, so a navigation to one must not open the shell.
    const started = studio();
    const info = await fetch(`${origin(started)}/admin/system/info`, { headers: HTML });
    expect(info.headers.get("x-upstream")).toBe("yes");
    expect(await info.json()).toMatchObject({ method: "GET", path: "/admin/system/info" });
  });

  test("an unknown path comes back as the application's visible 404", async () => {
    const started = studio();
    const missing = await fetch(`${origin(started)}/logs`, { headers: HTML });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ outcome: "not_found", path: "/logs" });
  });

  test("a POST to the origin root is the application's, so an MCP endpoint there survives", async () => {
    const started = studio();
    const posted = await fetch(`${origin(started)}/`, { method: "POST", body: "{}" });
    expect(posted.status).toBe(404);
    expect(await posted.json()).toEqual({ outcome: "not_found", path: "/" });
  });

  test("carries method, query, body, and credential through unchanged", async () => {
    const started = studio();
    const posted = await fetch(`${origin(started)}/api/echo?limit=2`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer admin" },
      body: JSON.stringify({ hello: "studio" }),
    });
    expect(posted.status).toBe(200);
    expect(await posted.json()).toEqual({
      method: "POST",
      path: "/api/echo?limit=2",
      body: JSON.stringify({ hello: "studio" }),
      authorization: "Bearer admin",
    });
  });

  test("streams SSE responses through unbuffered", async () => {
    const started = studio();
    const response = await fetch(`${origin(started)}/api/stream`, { method: "POST" });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toBe("data: one\n\ndata: two\n\n");
  });

  test("bridges WebSockets in both directions", async () => {
    const started = studio();
    const socket = new WebSocket(`${origin(started).replace("http:", "ws:")}/_ws`);
    const opened = new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("studio websocket failed to open"));
    });
    const echoed = new Promise<string>((resolve) => {
      socket.onmessage = (event) => resolve(String(event.data));
    });
    await opened;
    socket.send("ping-through-studio");
    expect(await echoed).toBe("ping-through-studio");
    socket.close();
  });
});

describe("while the application is down", () => {
  test("the shell still opens, so the operator reads a diagnosis and not a dead port", async () => {
    const port = deadPort();
    const started = studio({ target: `http://127.0.0.1:${port}` });
    const index = await fetch(started.url, { headers: HTML });
    expect(index.status).toBe(200);
    expect(await index.text()).toBe(INDEX_HTML);

    const proxied = await fetch(`${origin(started)}/admin/system/info`, { method: "POST" });
    expect(proxied.status).toBe(502);
    expect(await proxied.text()).toContain(`http://127.0.0.1:${port}`);
  });

  test("a proxied WebSocket closes with 1011 rather than hanging open", async () => {
    const started = studio({ target: `http://127.0.0.1:${deadPort()}` });
    const socket = new WebSocket(`${origin(started).replace("http:", "ws:")}/_ws`);
    const closed = await new Promise<{ code: number }>((resolve) => {
      socket.onclose = (event) => resolve({ code: event.code });
    });
    expect(closed.code).toBe(1011);
  });
});

test("client frames waiting on a connecting upstream are bounded", () => {
  // The bridge's one owned buffer: driven directly, because the window it
  // exists for is milliseconds wide and cannot be held open from a socket.
  const closed: number[] = [];
  const data: ProxiedSocketData = {
    upstream: { readyState: WebSocket.CONNECTING } as WebSocket,
    buffered: [],
    bufferedBytes: 0,
  };
  const ws = {
    data,
    close: (code?: number) => closed.push(code ?? 1005),
  } as unknown as Parameters<NonNullable<typeof proxyWebSocketHandlers.message>>[0];

  const frame = Buffer.alloc(64 * 1024);
  for (let sent = 0; sent < MAX_BUFFERED_FRAME_BYTES; sent += frame.byteLength) {
    proxyWebSocketHandlers.message(ws, frame);
  }
  expect(closed).toEqual([]);
  expect(data.bufferedBytes).toBe(MAX_BUFFERED_FRAME_BYTES);

  proxyWebSocketHandlers.message(ws, frame);
  expect(closed).toEqual([1011]);
  expect(data.bufferedBytes).toBe(MAX_BUFFERED_FRAME_BYTES);
});
