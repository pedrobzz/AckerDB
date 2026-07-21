/** Canonical paths owned by DBZZ's listener rather than application endpoints. */
export const DBZZ_HTTP_ROUTES = Object.freeze({
  live: "/live",
  ready: "/ready",
  status: "/status",
  websocket: "/ws",
  call: "/api/call",
  sse: "/api/sse",
  sseAck: "/api/sse/ack",
} as const);

const builtinPaths = new Set<string>(Object.values(DBZZ_HTTP_ROUTES));

export function isDbzzHttpRoute(path: string): boolean {
  return builtinPaths.has(path);
}
