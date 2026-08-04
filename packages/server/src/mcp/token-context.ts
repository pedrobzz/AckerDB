import type { Database } from "bun:sqlite";
import { stableEncode, type Identity } from "@ackerdb/core";
import type { Principal } from "../auth/credentials.ts";
import type { ReadRecorder, WriteCollector } from "../database/access.ts";
import type { Engine } from "../database/engine.ts";
import { AckerDBError } from "../shared/errors.ts";
import type { MutationCtx, QueryCtx, TxCtx } from "../app/functions.ts";
import {
  mcpTokenVaultOwner,
  type CreatedMcpToken,
  type McpTokenCreateInput,
  type McpTokenDescriptor,
  type McpTokenLimits,
  type McpTokenUpdateInput,
} from "./token-vault.ts";
import type { McpScopeDescriptor } from "./scopes.ts";
import { stageMcpTokenInvalidation } from "./token-invalidation.ts";
import { markOneTimeResult } from "../runtime/one-time-result.ts";
import type { Schema } from "../schema/definition.ts";

export type {
  CreatedMcpToken,
  McpTokenCreateInput,
  McpTokenDescriptor,
  McpTokenUpdateInput,
};

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
  update(
    ctx: MutationCtx<S> | TxCtx<S>,
    tokenId: string,
    input: McpTokenUpdateInput,
  ): void;
  revoke(
    ctx: MutationCtx<S> | TxCtx<S>,
    tokenId: string,
  ): void;
} & ([Scope] extends [never] ? object : {
  updateScopes(
    ctx: MutationCtx<S> | TxCtx<S>,
    tokenId: string,
    scopes: readonly Scope[],
  ): void;
});

/** Explicitly privileged administration for backend-managed integrations. */
export interface SystemMcpTokenOperations<
  S extends Schema = Schema,
  Scope extends string = never,
> {
  create(
    ctx: MutationCtx<S> | TxCtx<S>,
    identity: Identity,
    input: McpTokenCreateInput<Scope>,
  ): CreatedMcpToken<Scope>;
  list(
    ctx: QueryCtx<S> | MutationCtx<S> | TxCtx<S>,
    identity: Identity,
  ): readonly McpTokenDescriptor<Scope>[];
  revoke(
    ctx: MutationCtx<S> | TxCtx<S>,
    identity: Identity,
    tokenId: string,
  ): void;
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

function invocationCapability(ctx: object): McpTokenContextCapability {
  const found = capabilities.get(ctx);
  if (found === undefined) {
    throw new AckerDBError("unauthorized", "MCP token operations require a AckerDB invocation context");
  }
  return found;
}

function ownerCapability(ctx: object, write: boolean): McpTokenContextCapability & {
  readonly principal: Principal & { readonly kind: "user"; readonly identity: Identity };
} {
  const found = invocationCapability(ctx);
  if (found.principal.kind !== "user") {
    throw new AckerDBError("unauthorized", "MCP token administration requires an external user identity");
  }
  if (write && found.writes === null) {
    throw new AckerDBError("validation", "MCP token writes require a mutation or transaction");
  }
  return found as McpTokenContextCapability & {
    readonly principal: Principal & { readonly kind: "user"; readonly identity: Identity };
  };
}

function systemCapability(ctx: object, write: boolean): McpTokenContextCapability & {
  readonly principal: Principal & { readonly kind: "system" };
} {
  const found = invocationCapability(ctx);
  if (found.principal.kind !== "system") {
    throw new AckerDBError("unauthorized", "system MCP token administration requires system authority");
  }
  if (write && found.writes === null) {
    throw new AckerDBError("validation", "MCP token writes require a mutation or transaction");
  }
  return found as McpTokenContextCapability & {
    readonly principal: Principal & { readonly kind: "system" };
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
      const owner = ownerCapability(ctx, true);
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
      const owner = ownerCapability(ctx, false);
      owner.reads?.add(ownerKey(owner.principal.identity, mcp));
      return owner.engine[mcpTokenVaultOwner].list(
        owner.connection,
        owner.principal.identity,
        mcp,
        scopeDescriptor,
      );
    },
    update(
      ctx: MutationCtx<S> | TxCtx<S>,
      tokenId: string,
      input: McpTokenUpdateInput,
    ): void {
      const owner = ownerCapability(ctx, true);
      owner.engine[mcpTokenVaultOwner].update(
        owner.principal.identity,
        mcp,
        tokenId,
        input,
        owner.limits,
        owner.now(),
      );
      owner.writes!.keys.add(ownerKey(owner.principal.identity, mcp));
    },
    revoke(
      ctx: MutationCtx<S> | TxCtx<S>,
      tokenId: string,
    ): void {
      const owner = ownerCapability(ctx, true);
      owner.engine[mcpTokenVaultOwner].revoke(owner.principal.identity, mcp, tokenId);
      owner.writes!.keys.add(ownerKey(owner.principal.identity, mcp));
      stageMcpTokenInvalidation(owner.writes!, { reason: "revoked", mcp, tokenId });
    },
    ...(scopeDescriptor === undefined ? {} : {
      updateScopes(
        ctx: MutationCtx<S> | TxCtx<S>,
        tokenId: string,
        scopes: readonly Scope[],
      ): void {
        const owner = ownerCapability(ctx, true);
        const reduced = owner.engine[mcpTokenVaultOwner].updateScopes(
          owner.principal.identity,
          mcp,
          tokenId,
          scopes,
          scopeDescriptor,
          owner.now(),
        );
        owner.writes!.keys.add(ownerKey(owner.principal.identity, mcp));
        if (reduced) {
          stageMcpTokenInvalidation(owner.writes!, {
            reason: "scopes_reduced",
            mcp,
            tokenId,
          });
        }
      },
    }),
  };
  return Object.freeze(operations) as McpTokenOperations<S, Scope>;
}

export function createSystemMcpTokenOperations<
  S extends Schema,
  Scope extends string = never,
>(
  mcp: string,
  scopeDescriptor: McpScopeDescriptor<Scope> | undefined,
): SystemMcpTokenOperations<S, Scope> {
  return Object.freeze({
    create(
      ctx: MutationCtx<S> | TxCtx<S>,
      identity: Identity,
      input: McpTokenCreateInput<Scope>,
    ): CreatedMcpToken<Scope> {
      const system = systemCapability(ctx, true);
      const created = system.engine[mcpTokenVaultOwner].create(
        identity,
        mcp,
        input,
        scopeDescriptor,
        system.limits,
        system.now(),
      );
      system.writes!.keys.add(ownerKey(identity, mcp));
      markOneTimeResult(system.writes!);
      return created;
    },
    list(
      ctx: QueryCtx<S> | MutationCtx<S> | TxCtx<S>,
      identity: Identity,
    ): readonly McpTokenDescriptor<Scope>[] {
      const system = systemCapability(ctx, false);
      system.reads?.add(ownerKey(identity, mcp));
      return system.engine[mcpTokenVaultOwner].list(
        system.connection,
        identity,
        mcp,
        scopeDescriptor,
      );
    },
    revoke(
      ctx: MutationCtx<S> | TxCtx<S>,
      identity: Identity,
      tokenId: string,
    ): void {
      const system = systemCapability(ctx, true);
      system.engine[mcpTokenVaultOwner].revoke(identity, mcp, tokenId);
      system.writes!.keys.add(ownerKey(identity, mcp));
      stageMcpTokenInvalidation(system.writes!, { reason: "revoked", mcp, tokenId });
    },
  });
}
