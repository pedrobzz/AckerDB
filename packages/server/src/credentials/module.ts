/**
 * The Credentials module: every credential invariant AckerDB owns, in one
 * place, over the ordinary managed database.
 *
 * **What is policy here.** A credential IS an Identity, so issuing one mints
 * one. Its secret is minted once, disclosed once, and stored only as a digest.
 * Its authority is a *pattern* set bounded at both ends — the issuer's current
 * grant at issuance, every ancestor's current grant at use — so narrowing a
 * parent narrows every descendant with no revocation sweep. Revoking takes the
 * descendants with it, because their authority had this one as its source. An
 * authority change stages an invalidation that the transaction publishes only
 * if it commits.
 *
 * **What is not.** Storage, transactions, indexes, query planning, ordering,
 * pagination, and reactive dependencies are the managed database's, reached
 * through the same reader and writer `ctx.db` is built from. There is no
 * credential vault, no credential-specific reactive key, and no second
 * connection: a credential row is a row.
 *
 * **One module, two execution roots.** An invocation binds this to the writer
 * or reader its transaction already owns, with the caller's principal and
 * collectors. Pre-invocation bearer authentication binds it to a snapshot
 * reader with no recorder, because there is no subscription to record for. They
 * are two adapters over one implementation rather than two implementations.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { decode, encode, type Identity } from "@ackerdb/core";
import { effectiveChildScopes, issueChildScopes } from "./delegation.ts";
import { unauthenticated, type ExternalAccount } from "../auth/credentials.ts";
import {
  CREDENTIAL_ISSUER,
  CREDENTIAL_TOKEN_PREFIX,
  type ParsedCredentialToken,
} from "../auth/credential-token.ts";
import { Identities } from "../auth/identities.ts";
import {
  expandScopeGrant,
  isScopeGrant,
  MAX_SCOPE_PATTERNS,
  SCOPE_WILDCARD,
} from "../auth/scopes.ts";
import type { WriteCollector } from "../database/access.ts";
import { mappedTableQuery, type SafeProjection } from "../database/managed.ts";
import { markOneTimeResult } from "../runtime/one-time-result.ts";
import { AckerDBError, CorruptDatabaseError } from "../shared/errors.ts";
import { deepFreeze } from "../shared/immutable.ts";
import { utf8ByteLength } from "../shared/bytes.ts";
import type {
  Credential,
  CredentialQuery,
  IssueCredentialInput,
  IssuedCredential,
  UpdateCredentialInput,
} from "./api.ts";
import {
  CREDENTIALS_TABLE,
  type CredentialDatabase,
  type CredentialRow,
} from "./tables.ts";

export interface CredentialLimits {
  readonly maxPerIdentity: number;
  readonly maxNameBytes: number;
  readonly maxMetadataBytes: number;
}

/** What authentication proves: the credential's Identity, its lineage, and its stored grant. */
export interface AuthenticatedCredential {
  readonly identity: Identity;
  readonly parentIdentity: Identity | null;
  readonly tokenId: string;
  readonly scopes: readonly string[];
}

/** A resolved grant and the external accounts an invalidation may narrow it through. */
export interface EffectiveGrant {
  readonly scopes: readonly string[];
  readonly derivedFrom: readonly ExternalAccount[];
}

/** Resolves the current grant patterns of an Identity holding no credential. */
export type IdentityGrantResolver = (
  identity: Identity,
) => readonly string[] | Promise<readonly string[]>;

/**
 * Which credentials one operation may address: exactly the children of one
 * Identity, or every credential there is. Owner scope is an exact parent match
 * rather than a subtree walk — an Identity administers what it issued, and a
 * revocation reaching deeper is the cascade's doing, not the selector's.
 */
export type CredentialScope =
  | { readonly kind: "owner"; readonly identity: Identity }
  | { readonly kind: "global" };

export const GLOBAL_SCOPE: CredentialScope = Object.freeze({ kind: "global" });

/**
 * What a write needs and a read does not: the transaction's collector, where
 * authority changes and the one-time mark are staged, plus the limits and the
 * clock a new or edited row is held to. They travel together because they
 * appear and disappear together — a read-only root has none of the three, and
 * bundling them is what keeps that a type rather than three unused fields.
 */
export interface CredentialWriteContext {
  readonly collector: WriteCollector;
  readonly limits: CredentialLimits;
  readonly now: () => number;
}

export interface CredentialsOptions {
  readonly db: CredentialDatabase;
  /** The application's declared scopes: what every grant expands against. */
  readonly vocabulary: readonly string[];
  /**
   * The grant patterns an Identity holding no credential of its own carries.
   * The lineage walk ends here, and so does the delegation bound when the
   * caller is not the parent it is issuing for.
   */
  readonly resolveIdentityGrant: IdentityGrantResolver;
  /** Absent on a read-only root, where no write can be attempted. */
  readonly writes: CredentialWriteContext | null;
}

const DUMMY_DIGEST = new Uint8Array(32);
const EMPTY_ACCOUNTS: readonly ExternalAccount[] = Object.freeze([]);
const NO_INVALIDATIONS: readonly ExternalAccount[] = Object.freeze([]);
const NO_IDS: readonly string[] = Object.freeze([]);

function digestOf(secret: string): Uint8Array {
  return createHash("sha256").update(secret).digest();
}

/**
 * Consume one committed transaction's staged authority changes, as accounts on
 * the one generic auth-invalidation path every session and lease already
 * subscribes to. A credential names itself by its token id, so a revocation and
 * a grant change reach exactly the live principals that credential authorized —
 * and staging them on the write set is what makes a rolled-back revocation
 * publish nothing.
 */
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

function checkedTokenId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(value)) {
    throw new AckerDBError("validation", "credential ID is invalid");
  }
  return value;
}

function checkedName(value: unknown, maxBytes: number): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AckerDBError("validation", "credential name must be non-empty");
  }
  const name = value.trim();
  if (utf8ByteLength(name) > maxBytes) {
    throw new AckerDBError("validation", `credential name exceeds ${maxBytes} UTF-8 bytes`);
  }
  return name;
}

function checkedMetadata(value: unknown, maxBytes: number): {
  readonly encoded: string;
  readonly value: Readonly<Record<string, unknown>>;
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AckerDBError("validation", "credential metadata must be an object");
  }
  let encoded: string;
  try {
    encoded = encode(value);
  } catch (cause) {
    throw new AckerDBError("validation", "credential metadata must be wire-encodable", { cause });
  }
  if (utf8ByteLength(encoded) > maxBytes) {
    throw new AckerDBError("validation", `credential metadata exceeds ${maxBytes} UTF-8 bytes`);
  }
  return { encoded, value: deepFreeze(decode(encoded) as Record<string, unknown>) };
}

/**
 * Validate one requested grant against the declared vocabulary.
 *
 * A concrete entry must name a scope that exists: it addresses one exact thing,
 * so a name nothing answers to is a typo, and letting it through would store a
 * grant that silently authorizes nothing. A pattern is open-ended by
 * construction — `notes:*` is a claim on a prefix, deliberately including scopes
 * declared after the credential was minted — so only its shape is checked here,
 * and what it authorizes is decided at expansion.
 */
function normalizeGrantPatterns(
  value: unknown,
  vocabulary: readonly string[],
  where: string,
): readonly string[] {
  if (!Array.isArray(value)) {
    throw new AckerDBError("validation", `${where} must be an array`);
  }
  if (value.length > MAX_SCOPE_PATTERNS) {
    throw new AckerDBError(
      "validation",
      `${where} must contain at most ${MAX_SCOPE_PATTERNS} patterns`,
    );
  }
  if (!isScopeGrant(value)) {
    throw new AckerDBError(
      "validation",
      `${where} must be unique scope patterns, each a name optionally ending in "${SCOPE_WILDCARD}"`,
    );
  }
  for (const pattern of value) {
    if (!pattern.endsWith(SCOPE_WILDCARD) && !vocabulary.includes(pattern)) {
      throw new AckerDBError(
        "validation",
        `${where} contains undeclared scope ${JSON.stringify(pattern)}`,
      );
    }
  }
  return Object.freeze([...value]);
}

function storedScopes(encoded: string): readonly string[] {
  let value: unknown;
  try {
    value = decode(encoded);
  } catch {
    throw new CorruptDatabaseError("AckerDB credential scope grant is invalid");
  }
  if (!isScopeGrant(value)) {
    throw new CorruptDatabaseError("AckerDB credential scope grant is invalid");
  }
  return Object.freeze([...value]);
}

/** The one mapping from a stored row to what every reader may see. */
function safeCredential(row: CredentialRow): Credential {
  return Object.freeze({
    id: row.tokenId,
    identity: row.identity,
    parentIdentity: row.parentIdentity,
    name: row.name,
    metadata: deepFreeze(decode(row.metadataJson) as Record<string, unknown>),
    scopes: storedScopes(row.scopesJson),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

/**
 * What a credential looks like to every reader, and the only row a caller's
 * predicate, order, or aggregate can address.
 *
 * `id` is the public token id rather than the stored primary key, which is the
 * whole reason this projection exists: the two are different columns of
 * different types, and a caller who filters on the id it was handed must reach
 * the one it was handed. Everything absent here — the stored key, the digest,
 * the two encoded columns — is unaddressable rather than merely untyped.
 */
const SAFE_CREDENTIAL: SafeProjection<CredentialRow, Credential> = {
  descriptor: safeCredential,
  columns: (row) => ({
    id: row.tokenId,
    identity: row.identity,
    parentIdentity: row.parentIdentity,
    name: row.name,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }),
};

/** Column references, named once so the untyped row proxy is cast in one place. */
interface CredentialRowRef {
  readonly tokenId: { eq(value: string): unknown; in(values: readonly string[]): unknown };
  readonly identity: { eq(value: Identity): unknown };
  readonly parentIdentity: {
    eq(value: Identity): unknown;
    in(values: readonly Identity[]): unknown;
    isNull(): unknown;
  };
}

const credentialRef = (row: never): CredentialRowRef => row as unknown as CredentialRowRef;

/**
 * Credential inputs reach this module straight from application code, with no
 * validator in front of them, so an undeclared field is refused here rather
 * than silently ignored.
 */
function refuseUnknownCredentialFields(input: object, allowed: readonly string[]): void {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      throw new AckerDBError("validation", `unknown credential field "${key}"`);
    }
  }
}

export class Credentials {
  /** Every credential is an Identity, so the two domains meet on one handle. */
  private readonly identities: Identities;

  constructor(private readonly options: CredentialsOptions) {
    this.identities = new Identities(options.db);
  }

  private get table() {
    return this.options.db[CREDENTIALS_TABLE];
  }

  /**
   * The safe read interface for one scope. The owner predicate is applied
   * before anything the caller composes, so no later `.where` can widen it, and
   * it is an ordinary database predicate — which is exactly what makes the
   * query reactive through the machinery every other table already uses.
   */
  query(scope: CredentialScope): CredentialQuery {
    const base = this.table.query();
    return mappedTableQuery(
      scope.kind === "global"
        ? base
        : base.where((row) => credentialRef(row).parentIdentity.eq(scope.identity)),
      SAFE_CREDENTIAL,
    ) as CredentialQuery;
  }

  /** The credential a bearer names, once its secret matches the stored digest. */
  async authenticate(parsed: ParsedCredentialToken): Promise<AuthenticatedCredential> {
    const row = await this.rowForToken(parsed.id);
    const expected = row?.secretDigest ?? DUMMY_DIGEST;
    const matches = expected.byteLength === 32 &&
      timingSafeEqual(digestOf(parsed.secret), expected);
    if (!matches || row === null) throw unauthenticated();
    return Object.freeze({
      identity: row.identity,
      parentIdentity: row.parentIdentity,
      tokenId: row.tokenId,
      scopes: storedScopes(row.scopesJson),
    });
  }

  /** The Identity a token id names, or null when no credential holds it. */
  async identityForToken(tokenId: string): Promise<Identity | null> {
    const row = await this.rowForToken(checkedTokenId(tokenId));
    return row === null ? null : row.identity;
  }

  /**
   * The live grant an Identity holds, and the external accounts that bound it:
   * its stored patterns expanded, then narrowed by every ancestor's current
   * expansion up the delegation chain, ending at an Identity the application
   * resolves. Identity creation order makes the chain acyclic.
   *
   * The walk also collects `derivedFrom` — the accounts of that root Identity.
   * A delegated credential is live under its own credential subject, so an
   * invalidation for the account upstream would otherwise miss it, and a
   * non-expiring principal never re-authenticates out of stale authority.
   */
  async effectiveGrant(identity: Identity): Promise<EffectiveGrant> {
    const row = await this.rowForIdentity(identity);
    if (row === null) {
      return Object.freeze({
        scopes: expandScopeGrant(
          await this.options.resolveIdentityGrant(identity),
          this.options.vocabulary,
        ),
        derivedFrom: await this.identities.accountsFor(identity),
      });
    }
    const stored = expandScopeGrant(storedScopes(row.scopesJson), this.options.vocabulary);
    if (row.parentIdentity === null) {
      return Object.freeze({ scopes: stored, derivedFrom: EMPTY_ACCOUNTS });
    }
    const parent = await this.effectiveGrant(row.parentIdentity);
    return Object.freeze({
      scopes: effectiveChildScopes(stored, parent.scopes),
      derivedFrom: parent.derivedFrom,
    });
  }

  /**
   * Issue one credential, minting its Identity in the same transaction.
   *
   * **A child never exceeds its parent, whoever asked.** `delegatedBy` is the
   * grant the request must fit inside; an owner passes the authority it is
   * presenting, and global administration passes none — so the bound is
   * re-derived from the parent's *current* effective grant instead. "No
   * framework access check" is about who may reach the operation, not about
   * whether a stored grant may exceed its source: a child that did would be
   * held back only by the use-time intersection, and would spring open the
   * moment its parent widened.
   *
   * A root has no parent to be bounded by, so its patterns are validated
   * against the vocabulary and nothing else.
   */
  async issue(input: {
    readonly parentIdentity: Identity | null;
    readonly credential: IssueCredentialInput;
    readonly delegatedBy?: readonly string[];
  }): Promise<IssuedCredential> {
    const writes = this.writing();
    const declaration = input.credential;
    if (declaration === null || typeof declaration !== "object" || Array.isArray(declaration)) {
      throw new AckerDBError("validation", "credential input must be an object");
    }
    refuseUnknownCredentialFields(declaration, ["name", "metadata", "scopes"]);
    const name = checkedName(declaration.name, writes.limits.maxNameBytes);
    const metadata = checkedMetadata(declaration.metadata ?? {}, writes.limits.maxMetadataBytes);
    const scopes = normalizeGrantPatterns(
      declaration.scopes ?? [],
      this.options.vocabulary,
      "credential scopes",
    );
    const now = this.timestamp(writes);
    if (input.parentIdentity !== null) {
      await this.requireIdentity(input.parentIdentity);
      issueChildScopes(
        await this.delegationBound(input.parentIdentity, input.delegatedBy),
        scopes,
        this.options.vocabulary,
      );
    }
    await this.checkCapacity(input.parentIdentity, writes.limits);

    const identity = await this.identities.create();
    const tokenId = randomBytes(16).toString("base64url");
    const secret = randomBytes(32).toString("base64url");
    await this.table.insert({
      tokenId,
      identity,
      parentIdentity: input.parentIdentity,
      secretDigest: digestOf(secret),
      name,
      metadataJson: metadata.encoded,
      scopesJson: encode(scopes),
      createdAt: now,
      updatedAt: now,
    });
    // The plaintext exists for exactly this answer, so the answer may never be
    // replayed from the mutation ledger.
    markOneTimeResult(writes.collector);
    return Object.freeze({
      id: tokenId,
      identity,
      parentIdentity: input.parentIdentity,
      name,
      metadata: metadata.value,
      scopes,
      createdAt: now,
      updatedAt: now,
      token: `${CREDENTIAL_TOKEN_PREFIX}${tokenId}.${secret}`,
    });
  }

  /** Change descriptive state only. Nothing here can alter authority, so nothing invalidates. */
  async update(
    scope: CredentialScope,
    tokenId: string,
    input: UpdateCredentialInput,
  ): Promise<void> {
    const writes = this.writing();
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw new AckerDBError("validation", "credential update input must be an object");
    }
    const keys = Object.keys(input);
    if (keys.length === 0) {
      throw new AckerDBError("validation", "credential update requires name or metadata");
    }
    refuseUnknownCredentialFields(input, ["name", "metadata"]);
    const row = await this.addressed(scope, tokenId);
    const patch: Record<string, unknown> = { updatedAt: this.timestamp(writes) };
    if (Object.hasOwn(input, "name")) {
      patch["name"] = checkedName(input.name, writes.limits.maxNameBytes);
    }
    if (Object.hasOwn(input, "metadata")) {
      patch["metadataJson"] =
        checkedMetadata(input.metadata, writes.limits.maxMetadataBytes).encoded;
    }
    await this.table.patch(row.id, patch);
  }

  /**
   * Replace the stored grant, and stage an invalidation for every credential
   * the change can reach: this one plus everything delegated beneath it,
   * because a descendant's effective grant is intersected with this one's. An
   * unchanged grant reaches nothing, so a no-op update terminates no session.
   */
  async updateScopes(
    scope: CredentialScope,
    tokenId: string,
    value: unknown,
    delegatedBy?: readonly string[],
  ): Promise<void> {
    const writes = this.writing();
    const scopes = normalizeGrantPatterns(value, this.options.vocabulary, "credential scopes");
    const row = await this.addressed(scope, tokenId);
    if (row.parentIdentity !== null) {
      issueChildScopes(
        await this.delegationBound(row.parentIdentity, delegatedBy),
        scopes,
        this.options.vocabulary,
      );
    }
    const previous = storedScopes(row.scopesJson);
    await this.table.patch(row.id, {
      scopesJson: encode(scopes),
      updatedAt: this.timestamp(writes),
    });
    const changed = previous.length !== scopes.length ||
      previous.some((pattern, index) => scopes[index] !== pattern);
    if (!changed) return;
    for (const reached of await this.lineage([row])) {
      writes.collector.credentialInvalidations.push(reached.tokenId);
    }
  }

  /**
   * Revoke one credential and everything delegated beneath it.
   *
   * The cascade is the invariant, not a convenience: a child's authority is
   * bounded by its parent's, so a surviving child of a revoked parent would
   * have no source to be bounded by — and, because a credential-less Identity
   * reads as an ordinary application Identity, it would then be resolved by the
   * application's own scope resolver instead of failing closed.
   */
  async revoke(scope: CredentialScope, tokenId: string): Promise<readonly string[]> {
    return this.remove([await this.addressed(scope, tokenId)]);
  }

  /**
   * Revoke a set of credentials in one transaction. Missing ids are ignored, so
   * repeating a bulk offboarding is safe; overlapping descendant sets collapse,
   * so a credential named twice — directly and through its parent — is revoked
   * once and reported once.
   */
  async revokeMany(ids: readonly string[]): Promise<readonly string[]> {
    this.writing();
    if (!Array.isArray(ids)) {
      throw new AckerDBError("validation", "credential ids must be an array");
    }
    const wanted = [...new Set(ids.map(checkedTokenId))];
    if (wanted.length === 0) return NO_IDS;
    return this.remove(await this.table.query()
      .where((row) => credentialRef(row).tokenId.in(wanted))
      .collect());
  }

  /** The shared tail of both revocations: expand the lineage, delete it, stage it. */
  private async remove(roots: readonly CredentialRow[]): Promise<readonly string[]> {
    const writes = this.writing();
    if (roots.length === 0) return NO_IDS;
    const reached = await this.lineage(roots);
    await this.table.deleteMany(reached.map((row) => row.id));
    const revoked = reached.map((row) => row.tokenId);
    for (const tokenId of revoked) writes.collector.credentialInvalidations.push(tokenId);
    return Object.freeze(revoked);
  }

  /**
   * A set of credentials plus everything delegated beneath them, deduplicated.
   * Identity creation order makes the delegation chain acyclic, and the owner
   * index answers a whole level at once, so the walk costs one indexed query
   * per level of depth rather than one per credential.
   *
   * Every descendant is collected, never a bounded page: a descendant this walk
   * missed would survive its parent's revocation, and — because an Identity
   * with no credential row reads as an ordinary application Identity — would
   * then be resolved by the application's own scope resolver instead of failing
   * closed. Depth and breadth are already bounded by issuance capacity.
   */
  private async lineage(roots: readonly CredentialRow[]): Promise<readonly CredentialRow[]> {
    const found = new Map<bigint, CredentialRow>();
    let frontier: Identity[] = [];
    for (const row of roots) {
      if (found.has(row.id)) continue;
      found.set(row.id, row);
      frontier.push(row.identity);
    }
    while (frontier.length > 0) {
      const parents = frontier;
      const children = await this.table.query()
        .where((row) => credentialRef(row).parentIdentity.in(parents))
        .collect();
      frontier = [];
      for (const child of children) {
        if (found.has(child.id)) continue;
        found.set(child.id, child);
        frontier.push(child.identity);
      }
    }
    return [...found.values()];
  }

  /**
   * What a child may be granted: the authority the caller is presenting when it
   * is the parent, and the parent's current effective grant when it is not.
   */
  private async delegationBound(
    parentIdentity: Identity,
    presented: readonly string[] | undefined,
  ): Promise<readonly string[]> {
    return presented ?? (await this.effectiveGrant(parentIdentity)).scopes;
  }

  /** The one row an operation names, proved to sit inside the scope that named it. */
  private async addressed(scope: CredentialScope, tokenId: string): Promise<CredentialRow> {
    const row = await this.rowForToken(checkedTokenId(tokenId));
    if (
      row === null ||
      (scope.kind === "owner" && row.parentIdentity !== scope.identity)
    ) {
      throw new AckerDBError("not_found", "credential not found");
    }
    return row;
  }

  private async rowForToken(tokenId: string): Promise<CredentialRow | null> {
    return await this.table.query()
      .where((row) => credentialRef(row).tokenId.eq(tokenId))
      .unique();
  }

  private async rowForIdentity(identity: Identity): Promise<CredentialRow | null> {
    return await this.table.query()
      .where((row) => credentialRef(row).identity.eq(identity))
      .unique();
  }

  private async requireIdentity(identity: Identity): Promise<void> {
    if (typeof identity !== "bigint" || identity <= 0n) {
      throw new AckerDBError("validation", "credential Identity must be a positive bigint");
    }
    if (!await this.identities.exists(identity)) {
      throw new AckerDBError("not_found", "Identity not found");
    }
  }

  private async checkCapacity(
    parentIdentity: Identity | null,
    limits: CredentialLimits,
  ): Promise<void> {
    const held = await this.table.query()
      .where((row) => parentIdentity === null
        ? credentialRef(row).parentIdentity.isNull()
        : credentialRef(row).parentIdentity.eq(parentIdentity))
      .count();
    if (held >= limits.maxPerIdentity) {
      throw new AckerDBError("overloaded", "credential capacity is full", { resource: "operation" });
    }
  }

  private timestamp(writes: CredentialWriteContext): number {
    const now = writes.now();
    if (!Number.isFinite(now) || now < 0) {
      throw new RangeError("credential clock must be finite and non-negative");
    }
    return now;
  }

  private writing(): CredentialWriteContext {
    const writes = this.options.writes;
    if (writes === null) {
      throw new AckerDBError("validation", "credential writes require a mutation or transaction");
    }
    return writes;
  }
}
