/** Canonical paths owned by AckerDB's listener rather than application endpoints. */
export const ACKERDB_HTTP_ROUTES = Object.freeze({
  live: "/live",
  ready: "/ready",
  status: "/status",
  websocket: "/ws",
  call: "/api/call",
  sse: "/api/sse",
  sseAck: "/api/sse/ack",
  realtime: "/api/realtime",
  realtimeConfig: "/api/realtime/config",
} as const);

const builtinPaths = new Set<string>(Object.values(ACKERDB_HTTP_ROUTES));
const realtimeSessionPrefix = `${ACKERDB_HTTP_ROUTES.realtime}/`;

export function isAckerDBHttpRoute(path: string): boolean {
  return builtinPaths.has(path) || path.startsWith(realtimeSessionPrefix);
}
