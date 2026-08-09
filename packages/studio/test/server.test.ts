import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { STUDIO_PATH_PREFIX } from "../src/origin.ts";
import {
  MAX_UNDELIVERED_BYTES,
  UPSTREAM_ANSWER_TIMEOUT_MS,
  proxyWebSocketHandlers,
  upstreamUrl,
  type ProxiedSocketData,
} from "../src/launcher/proxy.ts";
import { startStudio, type RunningStudio } from "../src/launcher/server.ts";

const INDEX_HTML = "<!doctype html><html><body>studio-index</body></html>";
const APP_JS = "console.log('studio-asset');";

let distDir: string;
let upstream: Server<undefined>;
/**
 * One Studio for every test that needs a live application. Ephemeral ports are
 * reused quickly, and `fetch` keeps connections alive per origin, so a server
 * per test occasionally hands the next one a socket into a listener that has
 * already stopped — a stall that says nothing about the launcher.
 */
let live: RunningStudio;
/** A target that accepts every connection and answers none of them. */
let silent: Server<undefined>;
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
            cookie: request.headers.get("cookie"),
            contentLength: request.headers.get("content-length"),
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
      return Response.json(
        { outcome: "not_found", path: url.pathname, host: "no-such-host-was-dialled" },
        { status: 404 },
      );
    },
    websocket: {
      message(ws, message) {
        ws.send(message);
      },
    },
  });

  silent = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Promise<Response>(() => {}),
  });

  live = startStudio({
    target: `http://127.0.0.1:${upstream.port}`,
    port: 0,
    distDir,
  });
});

afterAll(() => {
  live.stop();
  silent.stop(true);
  upstream.stop(true);
  rmSync(distDir, { recursive: true, force: true });
});

afterEach(() => {
  while (running.length > 0) running.pop()!.stop();
});

/** A Studio pointed somewhere other than the live application, stopped after the test. */
function studioTargeting(target: string, answerTimeoutMs?: number): RunningStudio {
  const started = startStudio({
    target,
    port: 0,
    distDir,
    ...(answerTimeoutMs === undefined ? {} : { answerTimeoutMs }),
  });
  running.push(started);
  return started;
}

/** The Studio origin, without the SPA prefix the running URL carries. */
function origin(studio: RunningStudio): string {
  return new URL(studio.url).origin;
}

/**
 * One HTTP/1.1 request with the request target written verbatim, response and
 * all. Written by hand because `fetch` normalizes a path before it is sent, and
 * the paths worth testing here are exactly the ones it would normalize away.
 */
async function rawRequest(
  studio: RunningStudio,
  target: string,
  extraHeaders: readonly string[] = [],
  body?: string,
): Promise<string> {
  const { promise, resolve } = Promise.withResolvers<string>();
  let received = "";
  // A proxied response carries no content-length — the launcher drops it,
  // because fetch already decoded the body — so completeness is either the
  // declared length or the chunked terminator, and a close settles the rest.
  const complete = (): boolean => {
    const headerEnd = received.indexOf("\r\n\r\n");
    if (headerEnd === -1) return false;
    const body = received.slice(headerEnd + 4);
    const length = /content-length: (\d+)/i.exec(received.slice(0, headerEnd));
    if (length !== null) return body.length >= Number(length[1]);
    return body.endsWith("0\r\n\r\n");
  };
  const request = [
    `${body === undefined ? "GET" : "POST"} ${target} HTTP/1.1`,
    "Host: 127.0.0.1",
    ...extraHeaders,
    "Connection: close",
    "",
    body ?? "",
  ].join("\r\n");
  // Written from `open`, not after `Bun.connect` resolves: bytes handed to a
  // socket that has not opened yet are dropped, which shows up as a request
  // the server never sees and a test that hangs one time in five.
  const socket = await Bun.connect({
    hostname: "127.0.0.1",
    port: studio.port,
    socket: {
      open: (opened) => {
        opened.write(request);
      },
      data: (_socket, chunk) => {
        received += chunk.toString();
        if (complete()) resolve(received);
      },
      close: () => resolve(received),
    },
  });
  try {
    return await promise;
  } finally {
    socket.end();
  }
}

function deadPort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

const HTML = { accept: "text/html,application/xhtml+xml" } as const;

describe("origin confinement", () => {
  const target = new URL("http://127.0.0.1:3211");
  const dialled = (path: string) =>
    upstreamUrl(new Request(`http://127.0.0.1:4680${path}`), target).href;

  test("a request path never changes the origin dialled", () => {
    // `new URL("//elsewhere.example/x", target)` resolves to that host, so a
    // proxy that resolved rather than assigned would send the caller's headers
    // and body there. Every one of these stays on the configured application.
    expect(dialled("//elsewhere.example/steal")).toBe("http://127.0.0.1:3211//elsewhere.example/steal");
    expect(dialled("//elsewhere.example/steal?x=1"))
      .toBe("http://127.0.0.1:3211//elsewhere.example/steal?x=1");
    expect(dialled("/%2f%2felsewhere.example/steal"))
      .toBe("http://127.0.0.1:3211/%2f%2felsewhere.example/steal");
  });

  test("the path and query reach the application exactly as they arrived", () => {
    expect(dialled("/admin/system/info")).toBe("http://127.0.0.1:3211/admin/system/info");
    expect(dialled("/api/messages/list?limit=2&after=a%20b"))
      .toBe("http://127.0.0.1:3211/api/messages/list?limit=2&after=a%20b");
  });
});

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
  expect(new URL(live.url).pathname).toBe(STUDIO_PATH_PREFIX);
});

describe("the SPA prefix", () => {
  test("serves the shell, the bundled assets, and every client-side route under it", async () => {
    const started = live;
    const index = await fetch(started.url, { headers: HTML });
    expect(await index.text()).toBe(INDEX_HTML);

    const asset = await fetch(new URL("assets/app.js", started.url));
    expect(await asset.text()).toBe(APP_JS);
    expect(asset.headers.get("content-type")).toContain("javascript");

    const route = await fetch(new URL("database/users", started.url), { headers: HTML });
    expect(await route.text()).toBe(INDEX_HTML);
  });

  test("a browser landing on the bare origin is redirected into it", async () => {
    const started = live;
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
      const started = live;
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
    const started = live;
    const posted = await fetch(new URL("assets/app.js", started.url), { method: "POST" });
    expect(posted.status).toBe(405);
    expect(posted.headers.get("allow")).toBe("GET, HEAD");
  });
});

describe("everything outside the prefix", () => {
  test("reaches the application even when the browser asks for HTML", async () => {
    // The shadowing failure this rule exists to prevent: queries and Admin API
    // addresses answer GET, so a navigation to one must not open the shell.
    const started = live;
    const info = await fetch(`${origin(started)}/admin/system/info`, { headers: HTML });
    expect(info.headers.get("x-upstream")).toBe("yes");
    expect(await info.json()).toMatchObject({ method: "GET", path: "/admin/system/info" });
  });

  test("an unknown path comes back as the application's visible 404", async () => {
    const started = live;
    const missing = await fetch(`${origin(started)}/logs`, { headers: HTML });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ outcome: "not_found", path: "/logs" });
  });

  test("a POST to the origin root is the application's, so an MCP endpoint there survives", async () => {
    const started = live;
    const posted = await fetch(`${origin(started)}/`, { method: "POST", body: "{}" });
    expect(posted.status).toBe(404);
    expect(await posted.json()).toMatchObject({ outcome: "not_found", path: "/" });
  });

  test("the hop strips ambient cookies and sandboxes every proxied document", async () => {
    // Two header rules on one response, read off the wire because that is what
    // they are about. Cookies are host-scoped and ignore the port, so
    // forwarding them would carry another local service's cookie out to a
    // remote `--url` target and land that target's Set-Cookie on every local
    // service sharing the host. And Studio's storage holds an Admin Credential
    // while the application shares the origin, so an application document must
    // render in an opaque origin with no scripting.
    const setter = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => Response.json(
        { cookie: request.headers.get("cookie") },
        { headers: { "set-cookie": "upstream=1; Path=/" } },
      ),
    });
    try {
      const started = studioTargeting(`http://127.0.0.1:${setter.port}`);
      const answered = await rawRequest(started, "/api/echo", [
        "Cookie: session=someone-elses",
        "Accept: text/html",
      ]);
      expect(answered).toContain('"cookie":null');
      expect(answered.toLowerCase()).not.toContain("set-cookie");
      expect(answered.toLowerCase()).toContain("content-security-policy: sandbox");
    } finally {
      setter.stop(true);
    }
  });

  test("the shell keeps its own origin, so Studio's own code is not sandboxed", async () => {
    const shell = await rawRequest(live, STUDIO_PATH_PREFIX, ["Accept: text/html"]);
    expect(shell.toLowerCase()).not.toContain("content-security-policy");
  });

  test("a scheme-relative path cannot name a host of its own", async () => {
    // `new URL("//elsewhere.example/x", target)` resolves to that host, so a
    // proxy that resolved rather than assigned would dial it with the caller's
    // headers and body. Driven over a raw socket because `fetch` normalizes the
    // doubled slash away before the request is ever sent.
    const escaped = await rawRequest(live, "//elsewhere.example/steal?x=1");
    expect(escaped).toContain("not_found");
    expect(escaped).toContain("/elsewhere.example/steal");
  });

  test("a forwarded body carries no framing of its own", async () => {
    // The body is forwarded as a stream, so the caller's `Content-Length` no
    // longer describes what goes out. Left in place it is a request declaring
    // two lengths, and the application answers 400 — only sometimes, because
    // whether the runtime honours the length or chunks the stream depends on
    // timing. Under listener churn this reproduced seven times in two hundred
    // requests against Studio and never once straight at the application.
    const posted = await rawRequest(live, "/api/echo", [
      "Content-Type: application/json",
      "Content-Length: 18",
    ], '{"hello":"studio"}');
    expect(posted).toContain(" 200 ");
    // The body arrives whole and the length the caller declared does not.
    expect(posted).toContain('"body":"{\\"hello\\":\\"studio\\"}"');
    expect(posted).toContain('"contentLength":null');
  });

  test("carries method, query, body, and credential through unchanged", async () => {
    const started = live;
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
      cookie: null,
      contentLength: null,
    });
  });

  test("a target that accepts and never answers becomes the unreachable diagnosis", async () => {
    const started = studioTargeting(`http://127.0.0.1:${silent.port}`, 120);
    const answered = await fetch(`${origin(started)}/api/echo`);
    expect(answered.status).toBe(502);
    expect(await answered.text()).toContain("could not reach the application server");
  });

  test("the deadline covers getting an answer, never carrying one", async () => {
    // Headers arrive at once and the body follows well past the deadline: the
    // timer is cleared by then, which is what lets SSE and live tails run
    // through the same code path unbounded.
    const slow = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      // The first chunk is what puts headers on the wire; the tail arrives
      // long after the deadline would have fired.
      fetch: () => new Response(
        new ReadableStream({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode("early"));
            await Bun.sleep(400);
            controller.enqueue(new TextEncoder().encode("-late"));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/plain" } },
      ),
    });
    try {
      const started = studioTargeting(`http://127.0.0.1:${slow.port}`, 100);
      const answered = await fetch(`${origin(started)}/api/echo`);
      expect(answered.status).toBe(200);
      expect(await answered.text()).toBe("early-late");
    } finally {
      slow.stop(true);
    }
  });

  test("a WebSocket handshake the application never completes closes with 1011", async () => {
    const started = studioTargeting(`http://127.0.0.1:${silent.port}`, 120);
    const socket = new WebSocket(`${origin(started).replace("http:", "ws:")}/_ws`);
    const closed = await new Promise<number>((resolve) => {
      socket.onclose = (event) => resolve(event.code);
    });
    expect(closed).toBe(1011);
  });

  test("streams SSE responses through unbuffered", async () => {
    const started = live;
    const response = await fetch(`${origin(started)}/api/stream`, { method: "POST" });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toBe("data: one\n\ndata: two\n\n");
  });

  test("bridges WebSockets in both directions", async () => {
    const started = live;
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
    const started = studioTargeting(`http://127.0.0.1:${port}`);
    const index = await fetch(started.url, { headers: HTML });
    expect(index.status).toBe(200);
    expect(await index.text()).toBe(INDEX_HTML);

    const proxied = await fetch(`${origin(started)}/admin/system/info`, { method: "POST" });
    expect(proxied.status).toBe(502);
    expect(await proxied.text()).toContain(`http://127.0.0.1:${port}`);
  });

  test("a proxied WebSocket closes with 1011 rather than hanging open", async () => {
    const started = studioTargeting(`http://127.0.0.1:${deadPort()}`);
    const socket = new WebSocket(`${origin(started).replace("http:", "ws:")}/_ws`);
    const closed = await new Promise<{ code: number }>((resolve) => {
      socket.onclose = (event) => resolve({ code: event.code });
    });
    expect(closed.code).toBe(1011);
  });
});

/** A client socket the bridge's handler table can be driven against directly. */
function bridged(readyState: number): {
  readonly ws: Parameters<NonNullable<typeof proxyWebSocketHandlers.message>>[0];
  readonly data: ProxiedSocketData;
  readonly closed: number[];
} {
  const closed: number[] = [];
  const data: ProxiedSocketData = {
    upstream: { readyState, bufferedAmount: 0, close: () => {}, send: () => {} } as unknown as WebSocket,
    answerTimeoutMs: UPSTREAM_ANSWER_TIMEOUT_MS,
    buffered: [],
    bufferedBytes: 0,
  };
  const ws = {
    data,
    send: () => {},
    close: (code?: number) => closed.push(code ?? 1005),
  } as unknown as Parameters<NonNullable<typeof proxyWebSocketHandlers.message>>[0];
  return { ws, data, closed };
}

test("an upstream that never finishes its handshake is closed rather than left open", () => {
  // The bridge owns this deadline because a target that accepts the socket and
  // never completes fires neither open nor close: there is no event to wait on.
  const connecting = bridged(WebSocket.CONNECTING);
  proxyWebSocketHandlers.open!(connecting.ws as never);
  expect(connecting.data.handshakeDeadline).toBeDefined();
  expect(UPSTREAM_ANSWER_TIMEOUT_MS).toBeGreaterThan(0);
  proxyWebSocketHandlers.close!(connecting.ws as never, 1000, "");
  expect(connecting.data.handshakeDeadline).toBeUndefined();

  // An upstream that is already open arms nothing; there is nothing to wait for.
  const open = bridged(WebSocket.OPEN);
  proxyWebSocketHandlers.open!(open.ws as never);
  expect(open.data.handshakeDeadline).toBeUndefined();
  expect(open.closed).toEqual([]);
});

test("a frame larger than the budget is refused even when nothing is queued", () => {
  // Checking only what is already held would let one oversized frame through
  // whenever the queue happens to be empty, in either direction.
  const connecting = bridged(WebSocket.CONNECTING);
  proxyWebSocketHandlers.message(connecting.ws, Buffer.alloc(MAX_UNDELIVERED_BYTES + 1));
  expect(connecting.closed).toEqual([1011]);
  expect(connecting.data.bufferedBytes).toBe(0);

  const open = bridged(WebSocket.OPEN);
  let sent = 0;
  (open.data.upstream as unknown as { bufferedAmount: number; send: (f: unknown) => void })
    .bufferedAmount = 0;
  (open.data.upstream as unknown as { send: (f: unknown) => void }).send = () => {
    sent += 1;
  };
  proxyWebSocketHandlers.message(open.ws, Buffer.alloc(MAX_UNDELIVERED_BYTES + 1));
  expect(open.closed).toEqual([1011]);
  expect(sent).toBe(0);
});

test("an application that stopped reading closes the bridge instead of growing it", () => {
  const open = bridged(WebSocket.OPEN);
  const upstream = open.data.upstream as unknown as {
    bufferedAmount: number;
    send: (frame: unknown) => void;
  };
  upstream.bufferedAmount = MAX_UNDELIVERED_BYTES;
  let sent = 0;
  upstream.send = () => {
    sent += 1;
  };
  proxyWebSocketHandlers.message(open.ws, Buffer.alloc(1));
  expect(open.closed).toEqual([1011]);
  expect(sent).toBe(0);
});

test("client frames waiting on a connecting upstream are bounded", () => {
  // The bridge's one owned buffer: driven directly, because the window it
  // exists for is milliseconds wide and cannot be held open from a socket.
  const { ws, data, closed } = bridged(WebSocket.CONNECTING);
  const frame = Buffer.alloc(64 * 1024);
  for (let sent = 0; sent < MAX_UNDELIVERED_BYTES; sent += frame.byteLength) {
    proxyWebSocketHandlers.message(ws, frame);
  }
  expect(closed).toEqual([]);
  expect(data.bufferedBytes).toBe(MAX_UNDELIVERED_BYTES);

  proxyWebSocketHandlers.message(ws, frame);
  expect(closed).toEqual([1011]);
  expect(data.bufferedBytes).toBe(MAX_UNDELIVERED_BYTES);
});
