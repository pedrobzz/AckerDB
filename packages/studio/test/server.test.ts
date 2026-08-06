import { afterEach, beforeAll, afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { startStudio, type RunningStudio } from "../src/server.ts";

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

  upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === "/ws") {
        if (server.upgrade(request)) return undefined as unknown as Response;
        return new Response("not a websocket", { status: 400 });
      }
      if (url.pathname === "/api/echo") {
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
      return new Response("upstream 404", { status: 404 });
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

test("startStudio refuses a missing bundle and a non-http target", () => {
  expect(() => startStudio({ target: "http://127.0.0.1:1", port: 0, distDir: join(distDir, "absent") }))
    .toThrow("Studio bundle is missing");
  expect(() => startStudio({ target: "ftp://127.0.0.1:1", port: 0, distDir }))
    .toThrow("http or https");
  expect(() => startStudio({ target: "not a url", port: 0, distDir }))
    .toThrow("is not a URL");
});

test("serves the SPA for navigations and bundled files for asset paths", async () => {
  const { url } = studio();
  const index = await fetch(url, { headers: { accept: "text/html" } });
  expect(await index.text()).toBe(INDEX_HTML);

  const asset = await fetch(new URL("/assets/app.js", url));
  expect(await asset.text()).toBe(APP_JS);
  expect(asset.headers.get("content-type")).toContain("javascript");

  // Client-side routes belong to the SPA: unknown paths still open the shell.
  const route = await fetch(new URL("/tables/users", url), { headers: { accept: "text/html" } });
  expect(await route.text()).toBe(INDEX_HTML);
});

test("a path traversal never escapes the bundle directory", async () => {
  const { url } = studio();
  const response = await fetch(new URL("/assets/%2e%2e/%2e%2e/etc/passwd", url), {
    headers: { accept: "text/html" },
  });
  // Not a dist file, so it falls through to the SPA shell — never the host disk.
  expect(await response.text()).toBe(INDEX_HTML);
});

test("proxies API requests to the app server with same-origin semantics", async () => {
  const { url } = studio();
  const posted = await fetch(new URL("/api/echo?limit=2", url), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer admin" },
    body: JSON.stringify({ hello: "studio" }),
  });
  expect(posted.status).toBe(200);
  expect(posted.headers.get("x-upstream")).toBe("yes");
  expect(await posted.json()).toEqual({
    method: "POST",
    path: "/api/echo?limit=2",
    body: JSON.stringify({ hello: "studio" }),
    authorization: "Bearer admin",
  });

  // A GET that does not ask for HTML is an API call, not a navigation.
  const fetched = await fetch(new URL("/api/echo", url), {
    headers: { accept: "application/json" },
  });
  expect((await fetched.json()).method).toBe("GET");

  const missing = await fetch(new URL("/api/absent", url));
  expect(missing.status).toBe(404);
  expect(await missing.text()).toBe("upstream 404");
});

test("streams SSE responses through unbuffered", async () => {
  const { url } = studio();
  const response = await fetch(new URL("/api/stream", url), { method: "POST" });
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  expect(await response.text()).toBe("data: one\n\ndata: two\n\n");
});

test("answers 502 while the app server is down instead of failing to serve", async () => {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const downPort = probe.port!;
  probe.stop(true);

  const { url } = studio({ target: `http://127.0.0.1:${downPort}` });
  // The SPA still opens — no boot-order requirement on the app server.
  const index = await fetch(url, { headers: { accept: "text/html" } });
  expect(await index.text()).toBe(INDEX_HTML);

  const proxied = await fetch(new URL("/api/echo", url), { method: "POST" });
  expect(proxied.status).toBe(502);
  expect(await proxied.text()).toContain(`http://127.0.0.1:${downPort}`);
});

test("bridges WebSockets in both directions", async () => {
  const { url } = studio();
  const socket = new WebSocket(new URL("/ws", url).href.replace("http:", "ws:"));
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

test("closes a proxied WebSocket when the app server is unreachable", async () => {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const downPort = probe.port!;
  probe.stop(true);

  const { url } = studio({ target: `http://127.0.0.1:${downPort}` });
  const socket = new WebSocket(new URL("/ws", url).href.replace("http:", "ws:"));
  const closed = await new Promise<{ code: number }>((resolve) => {
    socket.onclose = (event) => resolve({ code: event.code });
  });
  expect(closed.code).toBe(1011);
});
