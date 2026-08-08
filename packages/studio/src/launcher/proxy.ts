/**
 * Same-origin proxying to the application server: HTTP — streamed SSE bodies
 * included — and WebSocket. The SPA only ever talks to the origin it was
 * served from, so there is no CORS negotiation and no URL-injection surface;
 * this module is the single path from that origin to the application.
 *
 * **A down application is an answer, not a crash.** HTTP gets a 502 naming the
 * target, a WebSocket closes with 1011, and Studio keeps serving — an operator
 * who typed the wrong port reads a diagnosis instead of finding a dead port.
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

/**
 * How many bytes of client frames may wait while the upstream socket is still
 * connecting. The window is milliseconds wide, so a client that fills this is
 * not waiting — it is a per-connection buffer with no owner, which is the one
 * shape a proxy must never grow.
 */
export const MAX_BUFFERED_FRAME_BYTES = 1024 * 1024;

function withoutHopByHop(headers: Headers): Headers {
  const filtered = new Headers(headers);
  for (const header of HOP_BY_HOP_HEADERS) filtered.delete(header);
  return filtered;
}

function upstreamUrl(request: Request, target: URL): URL {
  const url = new URL(request.url);
  return new URL(url.pathname + url.search, target);
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
      `AckerDB Studio could not reach the application server at ${target.origin} — start it and retry`,
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

export interface ProxiedSocketData {
  readonly upstream: WebSocket;
  /** Client frames sent while the upstream socket is still connecting. */
  readonly buffered: (string | Uint8Array)[];
  /** Bytes held in {@link ProxiedSocketData.buffered}, against the bound above. */
  bufferedBytes: number;
}

/** 1005/1006 are reserved close statuses a close frame may not carry. */
function forwardClose(
  socket: { close(code?: number, reason?: string): void },
  code: number,
  reason: string,
): void {
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
    const { upstream } = ws.data;
    const flush = () => {
      const { buffered } = ws.data;
      while (buffered.length > 0) upstream.send(buffered.shift()!);
      ws.data.bufferedBytes = 0;
    };
    upstream.onopen = flush;
    upstream.onmessage = (event) => {
      ws.send(
        typeof event.data === "string" ? event.data : new Uint8Array(event.data as ArrayBuffer),
      );
    };
    upstream.onclose = (event) => forwardClose(ws, event.code, event.reason);
    upstream.onerror = () => forwardClose(ws, 1011, "application server unreachable");
    // The upstream connect races this upgrade, and a refused connection wins
    // it whenever the application is down on loopback. Reading the state here
    // is what turns that race into the same 1011 the handlers above produce —
    // without it the client socket waits on events that already fired.
    if (upstream.readyState === WebSocket.OPEN) flush();
    else if (upstream.readyState !== WebSocket.CONNECTING) {
      forwardClose(ws, 1011, "application server unreachable");
    }
  },
  message(ws, message) {
    const { upstream, buffered } = ws.data;
    const frame = typeof message === "string" ? message : new Uint8Array(message);
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(frame);
      return;
    }
    if (upstream.readyState !== WebSocket.CONNECTING) return;
    const size = typeof frame === "string" ? Buffer.byteLength(frame) : frame.byteLength;
    if (ws.data.bufferedBytes + size > MAX_BUFFERED_FRAME_BYTES) {
      forwardClose(ws, 1011, "buffered too much while the application server was connecting");
      return;
    }
    ws.data.bufferedBytes += size;
    buffered.push(frame);
  },
  close(ws) {
    const { upstream } = ws.data;
    if (
      upstream.readyState === WebSocket.OPEN ||
      upstream.readyState === WebSocket.CONNECTING
    ) {
      upstream.close(1000, "studio client disconnected");
    }
  },
};
