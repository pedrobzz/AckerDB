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
 * `adminCredentials` is the third door and the only one the framework's own
 * functions use. It differs from the other two in what it is bounded by rather
 * than in what it can do: an Admin Credential is a root credential, so nothing
 * bounds it at use and issuance is the only ceiling there is — the caller must
 * already hold everything it is about to mint. It is deliberately absent from
 * the package's public surface, because an application that wants a root
 * credential already has `systemCredentials`.
 *
 * Revocations and grant changes are staged on the write set and published
 * after commit as account invalidations on the one generic auth-invalidation
 * path (`issuer: ackerdb:credentials`, subject = token id), so live sessions
 * and leases re-authorize immediately.
 */
import type { Database } from "bun:sqlite";
import { stableEncode, type Identity } from "@ackerdb/core";
import type { ExternalAccount, Principal, UserPrincipal } from "./credentials.ts";
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
import { ADMINISTRATIVE_GRANT, SCOPE_WILDCARD } from "./scopes.ts";
import { markOneTimeResult } from "../runtime/one-time-result.ts";

export type {
  CreatedCredential,
  CredentialCreateInput,
  CredentialDescriptor,
  CredentialUpdateInput,
};

/** Any mutation or transaction context, whatever its exact schema. */
export type WriteContext = MutationCtx<any, object> | TxCtx<any, object>;
/** Any invocation context that can read, whatever its exact schema. */
export type ReadContext = QueryCtx<any, object> | WriteContext;

export interface CredentialOperations {
  create(ctx: WriteContext, input: CredentialCreateInput): CreatedCredential;
  list(ctx: ReadContext): readonly CredentialDescriptor[];
  update(ctx: WriteContext, tokenId: string, input: CredentialUpdateInput): void;
  updateScopes(ctx: WriteContext, tokenId: string, scopes: readonly string[]): void;
  revoke(ctx: WriteContext, tokenId: string): void;
}

/** Administration of the Admin Credential itself, for the framework's own functions. */
export interface AdminCredentialOperations {
  list(ctx: ReadContext): readonly CredentialDescriptor[];
  rotate(ctx: WriteContext, name: string): CreatedCredential;
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

/**
 * A capability whose write authority is settled. Resolving one is the only way
 * to obtain it, so the write operations below never test for a write set and
 * never assert one — the type is the check, and a future operation cannot
 * forget it.
 */
type WriteCapability = CredentialContextCapability & { readonly writes: WriteCollector };

function ownerCapability(ctx: object): CredentialContextCapability & {
  readonly principal: Principal & { readonly kind: "user"; readonly identity: Identity };
} {
  const found = invocationCapability(ctx);
  if (found.principal.kind !== "user") {
    throw new AckerDBError(
      "unauthorized",
      "credential administration requires a user identity",
    );
  }
  return found as CredentialContextCapability & {
    readonly principal: Principal & { readonly kind: "user"; readonly identity: Identity };
  };
}

function systemCapability(ctx: object): CredentialContextCapability {
  const found = invocationCapability(ctx);
  if (found.principal.kind !== "system") {
    throw new AckerDBError(
      "unauthorized",
      "system credential administration requires system authority",
    );
  }
  return found;
}

function writing<T extends CredentialContextCapability>(capability: T): T & WriteCapability {
  if (capability.writes === null) {
    throw new AckerDBError("validation", "credential writes require a mutation or transaction");
  }
  return capability as T & WriteCapability;
}

function ownerKey(parentIdentity: Identity | null): string {
  return `internal:credentials:${stableEncode([parentIdentity])}`;
}

/**
 * The subset invariant at issuance: whatever the issuer asks for must expand
 * inside the grant the issuer itself currently holds.
 */
function delegable(
  owner: { readonly principal: UserPrincipal; readonly vocabulary: readonly string[] },
  scopes: unknown,
  where: string,
): void {
  issueChildScopes(
    owner.principal.scopes,
    normalizeGrantPatterns(scopes, owner.vocabulary, where),
    owner.vocabulary,
  );
}

/**
 * The issuance half of the child invariant, for an issuer that has no grant of
 * its own to be bounded against.
 *
 * System authority is the framework's unrestricted own, so there is no set to
 * compare a request against the way {@link delegable} compares one. What can
 * still be held is the property the invariant exists for: a concrete grant's
 * expansion is fixed the moment it is stored, so the scopes an operator names
 * are the most that child can ever reach — bounded at use by its parent, and
 * never widened later by the parent growing.
 *
 * An open-ended pattern is precisely the construct that would widen, and under
 * an unbounded issuer nothing would ever have consented to the widening. It
 * belongs to the bounded door: `credentials.create`, where the issuer is the
 * parent and its own expansion is the ceiling.
 *
 * A root credential has no parent to outgrow, so it keeps patterns.
 */
function namedOutright(
  capability: CredentialContextCapability,
  parentIdentity: Identity | null,
  scopes: unknown,
  where: string,
): void {
  if (scopes === undefined) return;
  const patterns = normalizeGrantPatterns(scopes, capability.vocabulary, where);
  if (parentIdentity === null) return;
  for (const pattern of patterns) {
    if (!pattern.endsWith(SCOPE_WILDCARD)) continue;
    throw new AckerDBError(
      "unauthorized",
      `${where}: ${JSON.stringify(pattern)} is open-ended, and system authority has no grant` +
        " to bound it against — name the scopes outright, or issue from the parent identity",
    );
  }
}

/**
 * The administration itself, written once against a resolved capability and an
 * owner. User and system authority differ in exactly two things: who is allowed
 * to ask, and whether the request is bounded by a grant the asker holds. Both
 * are settled before these run.
 *
 * Keeping the orchestration here is what stops the two surfaces from drifting.
 * Every operation owes the same three things beyond its vault call — record the
 * owner key so a reactive list re-runs, mark a token-bearing result one-time,
 * and stage the invalidations the change reaches — and an invariant added to
 * one surface but forgotten on the other is a security bug, not an
 * inconsistency.
 */
function createCredential(
  capability: WriteCapability,
  owner: Identity | null,
  input: CredentialCreateInput,
): CreatedCredential {
  const created = capability.engine[credentialVaultOwner].create(
    owner,
    input,
    capability.vocabulary,
    capability.limits,
    capability.now(),
  );
  capability.writes.keys.add(ownerKey(owner));
  markOneTimeResult(capability.writes);
  return created;
}

function listCredentials(
  capability: CredentialContextCapability,
  owner: Identity | null,
): readonly CredentialDescriptor[] {
  capability.reads?.add(ownerKey(owner));
  return capability.engine[credentialVaultOwner].list(capability.connection, owner);
}

function updateCredentialScopes(
  capability: WriteCapability,
  owner: Identity | null,
  tokenId: string,
  scopes: readonly string[],
): void {
  // Any grant change re-authorizes live holders: narrowing must revoke
  // authority immediately, and widening is only visible after re-auth.
  const reached = capability.engine[credentialVaultOwner].updateScopes(
    owner,
    tokenId,
    scopes,
    capability.vocabulary,
    capability.now(),
  );
  capability.writes.keys.add(ownerKey(owner));
  stageCredentialInvalidations(capability.writes, reached);
}

function revokeCredential(
  capability: WriteCapability,
  owner: Identity | null,
  tokenId: string,
): void {
  const revoked = capability.engine[credentialVaultOwner].revoke(owner, tokenId);
  capability.writes.keys.add(ownerKey(owner));
  stageCredentialInvalidations(capability.writes, revoked);
}

/**
 * Credential issuance and administration for the calling user identity. Its
 * owner is always itself, and every grant it asks for is bounded by the grant
 * it holds — the subset invariant at issuance.
 */
export const credentials: CredentialOperations = Object.freeze({
  create(ctx: WriteContext, input: CredentialCreateInput): CreatedCredential {
    const owner = writing(ownerCapability(ctx));
    if (input !== null && typeof input === "object" && input.scopes !== undefined) {
      delegable(owner, input.scopes, "credential scopes");
    }
    return createCredential(owner, owner.principal.identity, input);
  },
  list(ctx: ReadContext): readonly CredentialDescriptor[] {
    const owner = ownerCapability(ctx);
    return listCredentials(owner, owner.principal.identity);
  },
  update(ctx: WriteContext, tokenId: string, input: CredentialUpdateInput): void {
    const owner = writing(ownerCapability(ctx));
    owner.engine[credentialVaultOwner].update(
      owner.principal.identity,
      tokenId,
      input,
      owner.limits,
      owner.now(),
    );
    owner.writes.keys.add(ownerKey(owner.principal.identity));
  },
  updateScopes(ctx: WriteContext, tokenId: string, scopes: readonly string[]): void {
    const owner = writing(ownerCapability(ctx));
    delegable(owner, scopes, "credential scopes");
    updateCredentialScopes(owner, owner.principal.identity, tokenId, scopes);
  },
  revoke(ctx: WriteContext, tokenId: string): void {
    const owner = writing(ownerCapability(ctx));
    revokeCredential(owner, owner.principal.identity, tokenId);
  },
});

/**
 * The Admin Credential, listed and rotated by the framework's own `admin`
 * functions.
 *
 * **Rotation replaces the credential it was called with**, minting a new one
 * and revoking every credential that was administrative before the mint. It
 * cannot re-key the row in place: the
 * invalidation channel names a credential by its token id, so an old secret and
 * its replacement sharing one id would be one subject, and "revoke the leaked
 * secret's live sessions but not the new one's" would not be expressible. A
 * rotation whose whole purpose is to defeat a leaked secret has to produce a
 * different subject.
 *
 * The two live at once for the length of one transaction, which is what makes
 * the rotation downtime-free: the new credential is already usable when the old
 * one stops being. The cost is that the administrative Identity changes, and
 * with it everything keyed on that Identity — File ownership and every
 * credential delegated beneath the old master, which the
 * revocation cascade takes with it.
 */
export const adminCredentials: AdminCredentialOperations = Object.freeze({
  list(ctx: ReadContext): readonly CredentialDescriptor[] {
    // Every mint and revoke of a root credential records this exact key, so a
    // reactive read of the administrative set re-runs on precisely the changes
    // that can alter it, and on nothing else.
    const capability = invocationCapability(ctx);
    capability.reads?.add(ownerKey(null));
    return capability.engine[credentialVaultOwner].listAdministrative(capability.connection);
  },
  rotate(ctx: WriteContext, name: string): CreatedCredential {
    const owner = writing(ownerCapability(ctx));
    const superseded = owner.engine[credentialVaultOwner].listAdministrative(owner.connection);
    // Rotation replaces the credential it was called with, so the caller has to
    // be one of them. Holding a grant that covers the vocabulary is not the
    // same claim and never was: a *child* holding `["*", "_*"]` covers it too,
    // and minting a root from there would trade authority its parent can narrow
    // at any moment for authority nobody can — an escalation in permanence
    // rather than in reach. So would a resolver-backed user the application
    // granted everything, who would additionally get to destroy the operator's
    // master. Membership here is the strictly stronger statement, and it makes
    // the subset invariant redundant rather than merely satisfied.
    //
    // The comparison is on the Identity, which is the credential row's own
    // unique key, rather than on the token id an external provider also gets to
    // choose the shape of.
    const rotating = owner.principal.issuer === CREDENTIAL_ISSUER &&
      superseded.some((credential) => credential.identity === owner.principal.identity);
    if (!rotating) {
      throw new AckerDBError(
        "unauthorized",
        "credential rotation replaces the Admin Credential it is called with," +
          " and this caller presents none",
      );
    }
    // Revoked first, then minted, inside one transaction. Root credentials
    // share one capacity bucket, so minting first would make a full bucket the
    // one state rotation cannot get out of — and the bucket is exactly what a
    // rotation is about to make room in. Ordering it this way costs nothing:
    // the set was read before either step, so the replacement is never in the
    // set it replaces, and a failed mint rolls the revocations back with it.
    for (const previous of superseded) revokeCredential(owner, null, previous.id);
    // The caller's own credential is always among those, and it is revoked with
    // the response carrying the new secret already staged.
    return createCredential(owner, null, { name, scopes: ADMINISTRATIVE_GRANT });
  },
});

/**
 * System-authority credential administration, including standalone identities.
 * It names its owner rather than being one, and nothing bounds what it may
 * grant: system authority is the framework's own, already unrestricted.
 */
export const systemCredentials: SystemCredentialOperations = Object.freeze({
  create(
    ctx: WriteContext,
    parentIdentity: Identity | null,
    input: CredentialCreateInput,
  ): CreatedCredential {
    const system = writing(systemCapability(ctx));
    if (input !== null && typeof input === "object") {
      namedOutright(system, parentIdentity, input.scopes, "credential scopes");
    }
    return createCredential(system, parentIdentity, input);
  },
  list(ctx: ReadContext, parentIdentity: Identity | null): readonly CredentialDescriptor[] {
    return listCredentials(systemCapability(ctx), parentIdentity);
  },
  updateScopes(
    ctx: WriteContext,
    parentIdentity: Identity | null,
    tokenId: string,
    scopes: readonly string[],
  ): void {
    const system = writing(systemCapability(ctx));
    namedOutright(system, parentIdentity, scopes, "credential scopes");
    updateCredentialScopes(system, parentIdentity, tokenId, scopes);
  },
  revoke(ctx: WriteContext, parentIdentity: Identity | null, tokenId: string): void {
    revokeCredential(writing(systemCapability(ctx)), parentIdentity, tokenId);
  },
});
