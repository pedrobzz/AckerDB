/** Shared row-limit clamp for the Admin MCP's query-shaped tools. */
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

export function clampLimit(limit: number | null): number {
  if (limit === null) return DEFAULT_LIMIT;
  if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}
