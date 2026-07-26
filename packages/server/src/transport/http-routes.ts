/** Canonical paths owned by AckerDB's listener rather than application endpoints. */
export const ACKERDB_HTTP_ROUTES = Object.freeze({
  live: "/live",
  ready: "/ready",
  status: "/status",
  websocket: "/ws",
  call: "/api/call",
  sse: "/api/sse",
  sseAck: "/api/sse/ack",
} as const);

const builtinPaths = new Set<string>(Object.values(ACKERDB_HTTP_ROUTES));

export function isAckerDBHttpRoute(path: string): boolean {
  return builtinPaths.has(path);
}
