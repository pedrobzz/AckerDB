/**
 * Same-origin proxying to the application server: HTTP — streamed SSE bodies
 * included — and WebSocket. The SPA only ever talks to the origin it was
 * served from, so there is no CORS negotiation and no URL-injection surface;
 * this module is the single path from that origin to the application.
 *
 * **A down application is an answer, not a crash.** HTTP gets a 502 naming the
 * target, a WebSocket closes with 1011, and Studio keeps serving — an operator
 * who typed the wrong port reads a diagnosis instead of finding a dead port.
 *
 * **Sharing an origin is paid for here.** The application's documents land in
 * the origin holding an Admin Credential, its cookies would ride a hop they
 * were never scoped for, and a request path can name a host of its own if it is
 * resolved rather than assigned. Each of the three is closed below, at the one
 * place every byte crosses.
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
  // Cookies are scoped by host and ignore the port, so an ambient cookie set by
  // any other service on this host would ride out to a remote `--url` target,
  // and that target's `Set-Cookie` would land on every local service sharing
  // the host. AckerDB authenticates with bearer credentials and sets no
  // cookies, so forwarding them buys nothing and crosses a trust boundary in
  // both directions.
  "cookie",
  "set-cookie",
] as const;

/**
 * The one budget a bridged connection may hold in undelivered frames, in either
 * direction: the queue waiting on the upstream handshake, Bun's own outbound
 * backpressure toward the browser, and the bytes the upstream socket has
 * accepted but not yet written.
 *
 * One number, because a proxy has one job — move frames — and every place it
 * can hold them is the same hazard: an unowned per-connection buffer growing
 * behind a consumer that stopped reading. Saturation closes the bridge with
 * 1011 rather than queueing or silently dropping, so a stalled peer is a
 * bounded outcome instead of memory nobody accounts for. It matches the
 * application server's own per-connection WebSocket budget.
 */
export const MAX_UNDELIVERED_BYTES = 4 * 1024 * 1024;

/**
 * How long the application has to *begin* answering — response headers for a
 * request, an open frame for a socket — before the proxy gives up on it.
 *
 * One number for both, because it answers one question. It is deliberately not
 * a limit on an answer's length: SSE streams and live tails are unbounded by
 * design, so the deadline is cleared the moment headers arrive and can never
 * truncate a body. What it bounds is the target that accepts a connection and
 * then says nothing, which fires no event at all — the silent version of the
 * dead port Studio exists to replace, and the shape that would otherwise leave
 * one abandoned request behind per probe attempt.
 */
export const UPSTREAM_ANSWER_TIMEOUT_MS = 10_000;

/**
 * The policy every proxied response carries.
 *
 * Studio deliberately serves the application on its own origin, which means an
 * application document rendered here would execute in the origin holding the
 * operator's Admin Credential. `sandbox` puts every proxied document in an
 * opaque origin of its own with scripting off, so nothing the application
 * returns can read Studio's storage. It is a document directive: the SPA's own
 * `fetch` and WebSocket calls to these same routes are untouched, and the
 * shell — served from the bundle, never proxied — keeps its full origin.
 */
const PROXIED_DOCUMENT_POLICY = "sandbox";

function withoutHopByHop(headers: Headers): Headers {
  const filtered = new Headers(headers);
  for (const header of HOP_BY_HOP_HEADERS) filtered.delete(header);
  return filtered;
}

/**
 * The target URL for one request, with the path assigned rather than resolved.
 *
 * Resolving `pathname` against the target as a *relative reference* would let a
 * request path beginning with `//` name a host: `//elsewhere.example/x` is a
 * scheme-relative URL, and the proxy would dial that host with the caller's
 * headers and body. Assigning the components confines every request to the one
 * origin `acker studio` was pointed at, whatever the path says.
 *
 * Exported because that confinement is the module's security invariant and is
 * proven here rather than through a socket: the only wire form that expresses
 * the hazard is a `//`-prefixed request target, which HTTP servers may reject
 * before any handler sees it, so a live test would be measuring the parser's
 * tolerance instead of this rule.
 */
export function upstreamUrl(request: Request, target: URL): URL {
  const url = new URL(request.url);
  const upstream = new URL(target);
  upstream.pathname = url.pathname;
  upstream.search = url.search;
  return upstream;
}

export async function proxyHttp(request: Request, target: URL): Promise<Response> {
  const headers = withoutHopByHop(request.headers);
  // fetch derives Host from the target URL; the Studio origin's must not leak.
  headers.delete("host");
  // The deadline covers getting an answer, never carrying one: it is cleared as
  // soon as headers arrive, so a stream it is not watching can run as long as
  // the application keeps it open.
  const answer = new AbortController();
  const deadline = setTimeout(() => answer.abort(), UPSTREAM_ANSWER_TIMEOUT_MS);
  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl(request, target), {
      method: request.method,
      headers,
      body: request.body,
      redirect: "manual",
      signal: answer.signal,
    });
  } catch {
    return new Response(
      `AckerDB Studio could not reach the application server at ${target.origin} — start it and retry`,
      { status: 502 },
    );
  } finally {
    clearTimeout(deadline);
  }
  const responseHeaders = withoutHopByHop(upstream.headers);
  // fetch already decoded the body; the original framing headers would lie.
  responseHeaders.delete("content-encoding");
  responseHeaders.delete("content-length");
  responseHeaders.set("content-security-policy", PROXIED_DOCUMENT_POLICY);
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
  /** Armed while the upstream handshake is outstanding; cleared once it settles. */
  handshakeDeadline?: ReturnType<typeof setTimeout>;
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
    const settled = () => {
      if (ws.data.handshakeDeadline !== undefined) clearTimeout(ws.data.handshakeDeadline);
      ws.data.handshakeDeadline = undefined;
    };
    const flush = () => {
      settled();
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
    upstream.onclose = (event) => {
      settled();
      forwardClose(ws, event.code, event.reason);
    };
    upstream.onerror = () => {
      settled();
      forwardClose(ws, 1011, "application server unreachable");
    };
    // The upstream connect races this upgrade, and a refused connection wins it
    // whenever the application is down on loopback. Reading the state here is
    // what turns that race into the same 1011 the handlers above produce —
    // without it the client socket waits on events that already fired.
    if (upstream.readyState === WebSocket.OPEN) {
      flush();
      return;
    }
    if (upstream.readyState !== WebSocket.CONNECTING) {
      forwardClose(ws, 1011, "application server unreachable");
      return;
    }
    const deadline = setTimeout(() => {
      if (upstream.readyState !== WebSocket.CONNECTING) return;
      upstream.close();
      forwardClose(ws, 1011, "the application server did not complete the handshake");
    }, UPSTREAM_ANSWER_TIMEOUT_MS);
    deadline.unref?.();
    ws.data.handshakeDeadline = deadline;
  },
  message(ws, message) {
    const { upstream, buffered } = ws.data;
    const frame = typeof message === "string" ? message : new Uint8Array(message);
    // The frame being accepted counts against the budget, always: checking only
    // what is already held would let one oversized frame through whenever the
    // queue happens to be empty.
    const size = typeof frame === "string" ? Buffer.byteLength(frame) : frame.byteLength;
    if (upstream.readyState === WebSocket.OPEN) {
      // The upstream socket queues whatever it is handed, so the budget is
      // checked before handing it anything: an application that stopped reading
      // must close this bridge, not grow inside it.
      if (upstream.bufferedAmount + size > MAX_UNDELIVERED_BYTES) {
        forwardClose(ws, 1011, "the application server stopped reading");
        return;
      }
      upstream.send(frame);
      return;
    }
    if (upstream.readyState !== WebSocket.CONNECTING) return;
    if (ws.data.bufferedBytes + size > MAX_UNDELIVERED_BYTES) {
      forwardClose(ws, 1011, "buffered too much while the application server was connecting");
      return;
    }
    ws.data.bufferedBytes += size;
    buffered.push(frame);
  },
  close(ws) {
    const { upstream } = ws.data;
    if (ws.data.handshakeDeadline !== undefined) clearTimeout(ws.data.handshakeDeadline);
    ws.data.handshakeDeadline = undefined;
    if (
      upstream.readyState === WebSocket.OPEN ||
      upstream.readyState === WebSocket.CONNECTING
    ) {
      upstream.close(1000, "studio client disconnected");
    }
  },
};
