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
import type { McpScopeDescriptor } from "./mcp-scopes.ts";
import { markOneTimeResult } from "./one-time-result.ts";
import type { Schema } from "./schema.ts";

export type { CreatedMcpToken, McpTokenCreateInput, McpTokenDescriptor };

export type McpTokenOperations<
  S extends Schema = Schema,
  Scope extends string = never,
> = {
  create(
    ctx: MutationCtx<S> | TxCtx<S>,
    input: McpTokenCreateInput<Scope>,
  ): CreatedMcpToken<Scope>;
  list(
    ctx: QueryCtx<S> | MutationCtx<S> | TxCtx<S>,
  ): readonly McpTokenDescriptor<Scope>[];
} & ([Scope] extends [never] ? object : {
  updateScopes(
    ctx: MutationCtx<S> | TxCtx<S>,
    tokenId: string,
    scopes: readonly Scope[],
  ): void;
});

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

/** Expose reserved Engine state only while one exact Runtime invocation is active. */
export async function withMcpTokenContext<T extends object, R>(
  context: T,
  capability: McpTokenContextCapability,
  work: (ctx: T) => R | Promise<R>,
): Promise<Awaited<R>> {
  const ctx = Object.freeze(context);
  capabilities.set(ctx, capability);
  try {
    return await work(ctx);
  } finally {
    capabilities.delete(ctx);
  }
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
    throw new DbzzError("validation", "MCP token writes require a mutation or transaction");
  }
  return found as McpTokenContextCapability & {
    readonly principal: Principal & { readonly kind: "user"; readonly identity: Identity };
  };
}

function ownerKey(identity: Identity, mcp: string): string {
  return `internal:mcp-tokens:${stableEncode([identity, mcp])}`;
}

export function createMcpTokenOperations<S extends Schema, Scope extends string = never>(
  mcp: string,
  scopeDescriptor: McpScopeDescriptor<Scope> | undefined,
): McpTokenOperations<S, Scope> {
  const operations = {
    create(
      ctx: MutationCtx<S> | TxCtx<S>,
      input: McpTokenCreateInput<Scope>,
    ): CreatedMcpToken<Scope> {
      const owner = capability(ctx, true);
      const created = owner.engine[mcpTokenVaultOwner].create(
        owner.principal.identity,
        mcp,
        input,
        scopeDescriptor,
        owner.limits,
        owner.now(),
      );
      owner.writes!.keys.add(ownerKey(owner.principal.identity, mcp));
      markOneTimeResult(owner.writes!);
      return created;
    },
    list(
      ctx: QueryCtx<S> | MutationCtx<S> | TxCtx<S>,
    ): readonly McpTokenDescriptor<Scope>[] {
      const owner = capability(ctx, false);
      owner.reads?.add(ownerKey(owner.principal.identity, mcp));
      return owner.engine[mcpTokenVaultOwner].list(
        owner.connection,
        owner.principal.identity,
        mcp,
        scopeDescriptor,
      );
    },
    ...(scopeDescriptor === undefined ? {} : {
      updateScopes(
        ctx: MutationCtx<S> | TxCtx<S>,
        tokenId: string,
        scopes: readonly Scope[],
      ): void {
        const owner = capability(ctx, true);
        owner.engine[mcpTokenVaultOwner].updateScopes(
          owner.principal.identity,
          mcp,
          tokenId,
          scopes,
          scopeDescriptor,
          owner.now(),
        );
        owner.writes!.keys.add(ownerKey(owner.principal.identity, mcp));
      },
    }),
  };
  return Object.freeze(operations) as McpTokenOperations<S, Scope>;
}
