import type { Database } from "bun:sqlite";
import { stableEncode } from "@dbzz/core";
import type { Principal } from "./auth.ts";
import type { Identity } from "./dbz.ts";
import type { ReadRecorder, WriteCollector } from "./db.ts";
import type { Engine } from "./engine.ts";
import { DbzzError } from "./errors.ts";
import type { MutationCtx, QueryCtx, TxCtx } from "./functions.ts";
import {
  mcpTokenVaultOwner,
  type CreatedMcpToken,
  type McpTokenCreateInput,
  type McpTokenDescriptor,
  type McpTokenLimits,
} from "./mcp-token-vault.ts";
import { markOneTimeResult } from "./one-time-result.ts";
import type { Schema } from "./schema.ts";

export type { CreatedMcpToken, McpTokenCreateInput, McpTokenDescriptor };

export interface McpTokenOperations<S extends Schema = Schema> {
  create(ctx: MutationCtx<S> | TxCtx<S>, input: McpTokenCreateInput): CreatedMcpToken;
  list(ctx: QueryCtx<S> | MutationCtx<S> | TxCtx<S>): readonly McpTokenDescriptor[];
}

interface McpTokenContextCapability {
  readonly engine: Engine;
  readonly connection: Database;
  readonly principal: Principal;
  readonly reads: ReadRecorder | null;
  readonly writes: WriteCollector | null;
  readonly limits: McpTokenLimits;
  readonly now: () => number;
}

const capabilities = new WeakMap<object, McpTokenContextCapability>();

/** Bind reserved Engine state to one exact Runtime-created invocation context. */
export function bindMcpTokenContext<T extends object>(
  ctx: T,
  capability: McpTokenContextCapability,
): T {
  capabilities.set(ctx, capability);
  return ctx;
}

function capability(ctx: object, write: boolean): McpTokenContextCapability & {
  readonly principal: Principal & { readonly kind: "user"; readonly identity: Identity };
} {
  const found = capabilities.get(ctx);
  if (found === undefined) {
    throw new DbzzError("unauthorized", "MCP token operations require a DBZZ invocation context");
  }
  if (found.principal.kind !== "user") {
    throw new DbzzError("unauthorized", "MCP token administration requires an external user identity");
  }
  if (write && found.writes === null) {
    throw new DbzzError("validation", "MCP token creation requires a mutation or transaction");
  }
  return found as McpTokenContextCapability & {
    readonly principal: Principal & { readonly kind: "user"; readonly identity: Identity };
  };
}

function ownerKey(identity: Identity, mcp: string): string {
  return `internal:mcp-tokens:${stableEncode([identity, mcp])}`;
}

export function createMcpTokenOperations<S extends Schema>(mcp: string): McpTokenOperations<S> {
  return Object.freeze({
    create(ctx: MutationCtx<S> | TxCtx<S>, input: McpTokenCreateInput): CreatedMcpToken {
      const owner = capability(ctx, true);
      const created = owner.engine[mcpTokenVaultOwner].create(
        owner.principal.identity,
        mcp,
        input,
        owner.limits,
        owner.now(),
      );
      owner.writes!.keys.add(ownerKey(owner.principal.identity, mcp));
      markOneTimeResult(owner.writes!);
      return created;
    },
    list(ctx: QueryCtx<S> | MutationCtx<S> | TxCtx<S>): readonly McpTokenDescriptor[] {
      const owner = capability(ctx, false);
      owner.reads?.add(ownerKey(owner.principal.identity, mcp));
      return owner.engine[mcpTokenVaultOwner].list(
        owner.connection,
        owner.principal.identity,
        mcp,
      );
    },
  });
}
