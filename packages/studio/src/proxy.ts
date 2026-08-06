/**
 * Same-origin proxying to the app server: HTTP (including streamed SSE bodies)
 * and WebSocket. The SPA always talks to its own origin, so no CORS and no
 * URL-injection mechanism exist; this module is the only path to the target.
 *
 * A down target is an answer, not a crash: HTTP gets a 502 and a WebSocket
 * closes with 1011, until the app server comes up and the client reconnects.
 */
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";

/** Headers that describe one hop, never forwarded in either direction. */
const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
] as const;

function withoutHopByHop(headers: Headers): Headers {
  const filtered = new Headers(headers);
  for (const header of HOP_BY_HOP_HEADERS) filtered.delete(header);
  return filtered;
}

function upstreamUrl(request: Request, target: URL): URL {
  const url = new URL(request.url);
  const proxied = new URL(url.pathname + url.search, target);
  return proxied;
}

export async function proxyHttp(request: Request, target: URL): Promise<Response> {
  const headers = withoutHopByHop(request.headers);
  // fetch derives Host from the target URL; the Studio origin's must not leak.
  headers.delete("host");
  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl(request, target), {
      method: request.method,
      headers,
      body: request.body,
      redirect: "manual",
    });
  } catch {
    return new Response(
      `AckerDB Studio could not reach the app server at ${target.origin} — start it and retry`,
      { status: 502 },
    );
  }
  const responseHeaders = withoutHopByHop(upstream.headers);
  // fetch already decoded the body; the original framing headers would lie.
  responseHeaders.delete("content-encoding");
  responseHeaders.delete("content-length");
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

/**
 * Hard per-socket bound on client frames held while the upstream connects: a
 * slow or unreachable app server plus a chatty client must cost a bounded
 * buffer, then a typed 1013 close — never unbounded memory per connection.
 */
export const MAX_BUFFERED_UPSTREAM_BYTES = 1_048_576;

/** A CONNECTING upstream gets this long before the bridge closes with 1011. */
export const UPSTREAM_CONNECT_DEADLINE_MS = 15_000;

export interface ProxiedSocketData {
  readonly upstream: WebSocket;
  /** Client frames sent while the upstream socket is still connecting. */
  readonly buffered: (string | Uint8Array)[];
  bufferedBytes: number;
}

/** 1005/1006 are reserved close statuses a close frame may not carry. */
function forwardClose(socket: { close(code?: number, reason?: string): void }, code: number, reason: string): void {
  try {
    if (code === 1005 || code === 1006) socket.close();
    else socket.close(code, reason);
  } catch {
    socket.close();
  }
}

/**
 * Upgrade the incoming request and bridge it to a fresh upstream socket.
 * Returns the response Bun expects from `fetch` for an upgraded request.
 */
export function proxyWebSocket(
  request: Request,
  server: Server<ProxiedSocketData>,
  target: URL,
): Response | undefined {
  const url = upstreamUrl(request, target);
  url.protocol = target.protocol === "https:" ? "wss:" : "ws:";
  const protocols = request.headers.get("sec-websocket-protocol");
  const upstream = new WebSocket(
    url,
    protocols === null ? [] : protocols.split(",").map((name) => name.trim()),
  );
  upstream.binaryType = "arraybuffer";
  const data: ProxiedSocketData = { upstream, buffered: [], bufferedBytes: 0 };
  if (server.upgrade(request, { data })) return undefined;
  upstream.close();
  return new Response("expected a WebSocket upgrade", { status: 400 });
}

export const proxyWebSocketHandlers: WebSocketHandler<ProxiedSocketData> = {
  open(ws: ServerWebSocket<ProxiedSocketData>) {
    const { upstream, buffered } = ws.data;
    const flush = () => {
      while (buffered.length > 0) upstream.send(buffered.shift()!);
      ws.data.bufferedBytes = 0;
    };
    // A connect that never resolves must not hold the bridge (and its
    // buffer) open past the deadline.
    const deadline = setTimeout(() => {
      if (upstream.readyState === WebSocket.CONNECTING) {
        upstream.close();
        forwardClose(ws, 1011, "app server connect timed out");
      }
    }, UPSTREAM_CONNECT_DEADLINE_MS);
    deadline.unref?.();
    upstream.onopen = () => {
      clearTimeout(deadline);
      flush();
    };
    upstream.onmessage = (event) => {
      ws.send(
        typeof event.data === "string" ? event.data : new Uint8Array(event.data as ArrayBuffer),
      );
    };
    upstream.onclose = (event) => {
      clearTimeout(deadline);
      forwardClose(ws, event.code, event.reason);
    };
    upstream.onerror = () => {
      clearTimeout(deadline);
      forwardClose(ws, 1011, "app server unreachable");
    };
    if (upstream.readyState === WebSocket.OPEN) flush();
  },
  message(ws, message) {
    const { upstream } = ws.data;
    const frame = typeof message === "string" ? message : new Uint8Array(message);
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(frame);
      return;
    }
    if (upstream.readyState !== WebSocket.CONNECTING) return;
    ws.data.bufferedBytes += typeof frame === "string"
      ? Buffer.byteLength(frame)
      : frame.byteLength;
    if (ws.data.bufferedBytes > MAX_BUFFERED_UPSTREAM_BYTES) {
      ws.data.buffered.length = 0;
      ws.data.bufferedBytes = 0;
      upstream.close();
      forwardClose(ws, 1013, "app server connect backlog exceeded");
      return;
    }
    ws.data.buffered.push(frame);
  },
  close(ws) {
    const { upstream, buffered } = ws.data;
    buffered.length = 0;
    ws.data.bufferedBytes = 0;
    if (
      upstream.readyState === WebSocket.OPEN ||
      upstream.readyState === WebSocket.CONNECTING
    ) {
      upstream.close(1000, "studio client disconnected");
    }
  },
};
