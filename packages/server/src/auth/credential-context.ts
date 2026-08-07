/**
 * `credentials`: issuance and administration of identity credentials from
 * application functions.
 *
 * An authenticated user issues credentials for its agents. Each one is an
 * Identity whose grant is a subset of the issuer's at issuance
 * (`issueChildScopes`) and is intersected with the issuer's current grant at
 * use. `systemCredentials` is the explicitly privileged surface: it may issue
 * standalone identities (no parent) whose grants come straight from the
 * vocabulary, which is how an administrative `["*", "_*"]` credential is
 * minted without any identity holding that authority first.
 *
 * Revocations and grant changes are staged on the write set and published
 * after commit as account invalidations on the one generic auth-invalidation
 * path (`issuer: ackerdb:credentials`, subject = token id), so live sessions
 * and leases re-authorize immediately.
 */
import type { Database } from "bun:sqlite";
import { stableEncode, type Identity } from "@ackerdb/core";
import type { ExternalAccount, Principal } from "./credentials.ts";
import type { ReadRecorder, WriteCollector } from "../database/access.ts";
import type { Engine } from "../database/engine.ts";
import { AckerDBError } from "../shared/errors.ts";
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { MutationCtx, QueryCtx, TxCtx } from "../app/functions.ts";
import {
  credentialVaultOwner,
  normalizeGrantPatterns,
  type CreatedCredential,
  type CredentialCreateInput,
  type CredentialDescriptor,
  type CredentialLimits,
  type CredentialUpdateInput,
} from "./credential-vault.ts";
import { CREDENTIAL_ISSUER } from "./credential-token.ts";
import { issueChildScopes } from "./child-credentials.ts";
import { markOneTimeResult } from "../runtime/one-time-result.ts";

export type {
  CreatedCredential,
  CredentialCreateInput,
  CredentialDescriptor,
  CredentialUpdateInput,
};

/** Any mutation or transaction context, whatever its exact schema. */
export type WriteContext = MutationCtx<any, object, object> | TxCtx<any, object, object>;
/** Any invocation context that can read, whatever its exact schema. */
export type ReadContext = QueryCtx<any, object, object> | WriteContext;

export interface CredentialOperations {
  create(ctx: WriteContext, input: CredentialCreateInput): CreatedCredential;
  list(ctx: ReadContext): readonly CredentialDescriptor[];
  update(ctx: WriteContext, tokenId: string, input: CredentialUpdateInput): void;
  updateScopes(ctx: WriteContext, tokenId: string, scopes: readonly string[]): void;
  revoke(ctx: WriteContext, tokenId: string): void;
}

/** Explicitly privileged administration for backend-managed and standalone identities. */
export interface SystemCredentialOperations {
  create(
    ctx: WriteContext,
    parentIdentity: Identity | null,
    input: CredentialCreateInput,
  ): CreatedCredential;
  list(ctx: ReadContext, parentIdentity: Identity | null): readonly CredentialDescriptor[];
  updateScopes(
    ctx: WriteContext,
    parentIdentity: Identity | null,
    tokenId: string,
    scopes: readonly string[],
  ): void;
  revoke(ctx: WriteContext, parentIdentity: Identity | null, tokenId: string): void;
}

export interface CredentialContextCapability {
  readonly engine: Engine;
  readonly connection: Database;
  readonly principal: Principal;
  readonly reads: ReadRecorder | null;
  readonly writes: WriteCollector | null;
  readonly limits: CredentialLimits;
  /** Application scopes plus the framework's; grants expand against it. */
  readonly vocabulary: readonly string[];
  readonly now: () => number;
}

const capabilities = new WeakMap<object, CredentialContextCapability>();
const NO_INVALIDATIONS: readonly ExternalAccount[] = Object.freeze([]);

/**
 * Stage transaction-local authority changes on the write set, where the
 * savepoint journal already covers them: a nested revoke that rolls back must
 * not invalidate anything. One change carries every token id it reaches — a
 * credential and its delegates — because a live descendant matches on its own
 * subject and would otherwise keep an authority its source no longer has.
 */
function stageCredentialInvalidations(
  writes: WriteCollector,
  tokenIds: readonly string[],
): void {
  for (const tokenId of tokenIds) writes.credentialInvalidations.push(tokenId);
}

/** Consume one committed transaction's staged authority changes exactly once. */
export function takeCredentialInvalidations(
  writes: WriteCollector,
): readonly ExternalAccount[] {
  const tokenIds = writes.credentialInvalidations;
  if (tokenIds.length === 0) return NO_INVALIDATIONS;
  const accounts = tokenIds.map((subject) =>
    Object.freeze({ issuer: CREDENTIAL_ISSUER, subject }));
  tokenIds.length = 0;
  return Object.freeze(accounts);
}

/** Expose reserved Engine state only while one exact Runtime invocation is active. */
export async function withCredentialContext<T extends object, R>(
  context: T,
  capability: CredentialContextCapability,
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

function invocationCapability(ctx: object): CredentialContextCapability {
  const found = capabilities.get(ctx);
  if (found === undefined) {
    throw new AckerDBError(
      "unauthorized",
      "credential operations require an AckerDB invocation context",
    );
  }
  return found;
}

type OwnerCapability = CredentialContextCapability & {
  readonly principal: Principal & { readonly kind: "user"; readonly identity: Identity };
};

function ownerCapability(ctx: object, write: boolean): OwnerCapability {
  const found = invocationCapability(ctx);
  if (found.principal.kind !== "user") {
    throw new AckerDBError(
      "unauthorized",
      "credential administration requires a user identity",
    );
  }
  if (write && found.writes === null) {
    throw new AckerDBError("validation", "credential writes require a mutation or transaction");
  }
  return found as OwnerCapability;
}

function systemCapability(ctx: object, write: boolean): CredentialContextCapability {
  const found = invocationCapability(ctx);
  if (found.principal.kind !== "system") {
    throw new AckerDBError(
      "unauthorized",
      "system credential administration requires system authority",
    );
  }
  if (write && found.writes === null) {
    throw new AckerDBError("validation", "credential writes require a mutation or transaction");
  }
  return found;
}

function ownerKey(parentIdentity: Identity | null): string {
  return `internal:credentials:${stableEncode([parentIdentity])}`;
}

/**
 * The subset invariant at issuance: whatever the issuer asks for must expand
 * inside the grant the issuer itself currently holds.
 */
function delegable(owner: OwnerCapability, scopes: unknown, where: string): void {
  issueChildScopes(
    owner.principal.scopes,
    normalizeGrantPatterns(scopes, owner.vocabulary, where),
    owner.vocabulary,
  );
}

/** Credential issuance and administration for the calling user identity. */
export const credentials: CredentialOperations = Object.freeze({
  create(ctx: WriteContext, input: CredentialCreateInput): CreatedCredential {
    const owner = ownerCapability(ctx, true);
    if (input !== null && typeof input === "object" && input.scopes !== undefined) {
      delegable(owner, input.scopes, "credential scopes");
    }
    const created = owner.engine[credentialVaultOwner].create(
      owner.principal.identity,
      input,
      owner.vocabulary,
      owner.limits,
      owner.now(),
    );
    owner.writes!.keys.add(ownerKey(owner.principal.identity));
    markOneTimeResult(owner.writes!);
    return created;
  },
  list(ctx: ReadContext): readonly CredentialDescriptor[] {
    const owner = ownerCapability(ctx, false);
    owner.reads?.add(ownerKey(owner.principal.identity));
    return owner.engine[credentialVaultOwner].list(owner.connection, owner.principal.identity);
  },
  update(ctx: WriteContext, tokenId: string, input: CredentialUpdateInput): void {
    const owner = ownerCapability(ctx, true);
    owner.engine[credentialVaultOwner].update(
      owner.principal.identity,
      tokenId,
      input,
      owner.limits,
      owner.now(),
    );
    owner.writes!.keys.add(ownerKey(owner.principal.identity));
  },
  updateScopes(ctx: WriteContext, tokenId: string, scopes: readonly string[]): void {
    const owner = ownerCapability(ctx, true);
    delegable(owner, scopes, "credential scopes");
    // Any grant change re-authorizes live holders: narrowing must revoke
    // authority immediately, and widening is only visible after re-auth.
    const reached = owner.engine[credentialVaultOwner].updateScopes(
      owner.principal.identity,
      tokenId,
      scopes,
      owner.vocabulary,
      owner.now(),
    );
    owner.writes!.keys.add(ownerKey(owner.principal.identity));
    stageCredentialInvalidations(owner.writes!, reached);
  },
  revoke(ctx: WriteContext, tokenId: string): void {
    const owner = ownerCapability(ctx, true);
    const revoked = owner.engine[credentialVaultOwner].revoke(
      owner.principal.identity,
      tokenId,
    );
    owner.writes!.keys.add(ownerKey(owner.principal.identity));
    stageCredentialInvalidations(owner.writes!, revoked);
  },
});

/** System-authority credential administration, including standalone identities. */
export const systemCredentials: SystemCredentialOperations = Object.freeze({
  create(
    ctx: WriteContext,
    parentIdentity: Identity | null,
    input: CredentialCreateInput,
  ): CreatedCredential {
    const system = systemCapability(ctx, true);
    const created = system.engine[credentialVaultOwner].create(
      parentIdentity,
      input,
      system.vocabulary,
      system.limits,
      system.now(),
    );
    system.writes!.keys.add(ownerKey(parentIdentity));
    markOneTimeResult(system.writes!);
    return created;
  },
  list(ctx: ReadContext, parentIdentity: Identity | null): readonly CredentialDescriptor[] {
    const system = systemCapability(ctx, false);
    system.reads?.add(ownerKey(parentIdentity));
    return system.engine[credentialVaultOwner].list(system.connection, parentIdentity);
  },
  updateScopes(
    ctx: WriteContext,
    parentIdentity: Identity | null,
    tokenId: string,
    scopes: readonly string[],
  ): void {
    const system = systemCapability(ctx, true);
    const reached = system.engine[credentialVaultOwner].updateScopes(
      parentIdentity,
      tokenId,
      scopes,
      system.vocabulary,
      system.now(),
    );
    system.writes!.keys.add(ownerKey(parentIdentity));
    stageCredentialInvalidations(system.writes!, reached);
  },
  revoke(ctx: WriteContext, parentIdentity: Identity | null, tokenId: string): void {
    const system = systemCapability(ctx, true);
    const revoked = system.engine[credentialVaultOwner].revoke(parentIdentity, tokenId);
    system.writes!.keys.add(ownerKey(parentIdentity));
    stageCredentialInvalidations(system.writes!, revoked);
  },
});
