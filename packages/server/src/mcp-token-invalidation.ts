import type { WriteCollector } from "./db.ts";

export type McpTokenInvalidationReason = "revoked" | "scopes_reduced";

export interface McpTokenInvalidation {
  readonly reason: McpTokenInvalidationReason;
  readonly mcp: string;
  readonly tokenId: string;
}

type McpTokenInvalidationListener = (
  invalidation: McpTokenInvalidation,
) => void;

const staged = new WeakMap<WriteCollector, McpTokenInvalidation[]>();

/** Stage transaction-local authority changes as data; only the commit owner can publish them. */
export function stageMcpTokenInvalidation(
  writes: WriteCollector,
  invalidation: McpTokenInvalidation,
): void {
  let invalidations = staged.get(writes);
  if (invalidations === undefined) staged.set(writes, (invalidations = []));
  invalidations.push(Object.freeze({ ...invalidation }));
}

/** Consume one committed transaction's staged authority changes exactly once. */
export function takeMcpTokenInvalidations(
  writes: WriteCollector,
): readonly McpTokenInvalidation[] {
  const invalidations = staged.get(writes);
  if (invalidations === undefined) return [];
  staged.delete(writes);
  return invalidations;
}

/** Runtime-owned exact-authority cancellation registry for live MCP HTTP leases. */
export class McpTokenInvalidationBoundary {
  private readonly listeners = new Map<
    string,
    Map<string, Set<McpTokenInvalidationListener>>
  >();

  subscribe(
    mcp: string,
    tokenId: string,
    listener: McpTokenInvalidationListener,
  ): () => void {
    let tokens = this.listeners.get(mcp);
    if (tokens === undefined) this.listeners.set(mcp, (tokens = new Map()));
    let listeners = tokens.get(tokenId);
    if (listeners === undefined) tokens.set(tokenId, (listeners = new Set()));
    listeners.add(listener);

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      listeners!.delete(listener);
      if (listeners!.size === 0) tokens!.delete(tokenId);
      if (tokens!.size === 0) this.listeners.delete(mcp);
    };
  }

  publish(invalidation: McpTokenInvalidation): void {
    const listeners = this.listeners
      .get(invalidation.mcp)
      ?.get(invalidation.tokenId);
    if (listeners === undefined) return;
    for (const listener of [...listeners]) {
      try {
        listener(invalidation);
      } catch {
        // One lease cannot prevent fail-closed cancellation of the others.
      }
    }
  }
}
