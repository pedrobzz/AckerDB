/**
 * Engine-owned identity-credential storage: the one vault.
 *
 * Every credential IS an Identity. Creating one mints a fresh Identity row, so
 * an agent authenticating with the token is a first-class user at every choke
 * point — fairness, file ownership, analytics and telemetry all key on it
 * without knowing it came from a token. `parent_identity` records delegation
 * lineage: null for a standalone identity whose grant comes straight from the
 * vocabulary, otherwise the issuing Identity whose current grant bounds the
 * child at use.
 *
 * The stored grant is a *pattern* set, not an expansion: authority is whatever
 * those patterns expand to against the vocabulary at the moment the principal
 * is built, which is what lets a wildcard cover a scope declared after the
 * credential was minted.
 *
 * Every caller already owns its SQLite transaction.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Database } from "bun:sqlite";
import { decode, encode, type Identity } from "@ackerdb/core";
import type { ExternalAccount } from "./credentials.ts";
import { CorruptDatabaseError, AckerDBError } from "../shared/errors.ts";
import { deepFreeze } from "../shared/immutable.ts";
import { CREDENTIAL_TOKEN_PREFIX, type ParsedCredentialToken } from "./credential-token.ts";
import {
  expandScopeGrant,
  isAdministrativeGrant,
  isScopeGrant,
  MAX_SCOPE_PATTERNS,
  SCOPE_WILDCARD,
} from "./scopes.ts";
import { effectiveChildScopes } from "./child-credentials.ts";

export const credentialVaultOwner = Symbol("ackerdb.credentialVault");

export const CREDENTIAL_INTERNAL_OBJECTS = [
  {
    type: "table" as const,
    name: "_ackerdb_credentials",
    table: "_ackerdb_credentials",
    sql: `CREATE TABLE _ackerdb_credentials (
      creation_seq INTEGER PRIMARY KEY,
      token_id TEXT NOT NULL UNIQUE CHECK (length(token_id) = 22),
      identity INTEGER NOT NULL UNIQUE REFERENCES _ackerdb_identities(identity) ON UPDATE RESTRICT ON DELETE RESTRICT,
      parent_identity INTEGER REFERENCES _ackerdb_identities(identity) ON UPDATE RESTRICT ON DELETE RESTRICT,
      secret_digest BLOB NOT NULL CHECK (length(secret_digest) = 32),
      name TEXT NOT NULL CHECK (length(name) > 0),
      metadata TEXT NOT NULL,
      scopes TEXT NOT NULL,
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL CHECK (updated_at >= created_at)
    )`,
  },
  {
    type: "index" as const,
    name: "ix__ackerdb_credentials_owner",
    table: "_ackerdb_credentials",
    sql: "CREATE INDEX ix__ackerdb_credentials_owner ON _ackerdb_credentials (parent_identity, creation_seq)",
  },
] as const;

export interface CredentialLimits {
  readonly maxPerIdentity: number;
  readonly maxNameBytes: number;
  readonly maxMetadataBytes: number;
}

export interface CredentialCreateInput {
  readonly name: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Grant patterns; absent is the empty grant. */
  readonly scopes?: readonly string[];
}

export type CredentialUpdateInput =
  | {
      readonly name: string;
      readonly metadata?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly name?: string;
      readonly metadata: Readonly<Record<string, unknown>>;
    };

export interface CredentialDescriptor {
  readonly id: string;
  /** The credential's own first-class Identity. */
  readonly identity: Identity;
  readonly name: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  /** The grant as stored: patterns, not their expansion. */
  readonly scopes: readonly string[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type CreatedCredential = CredentialDescriptor & {
  /** Returned only from create; no descriptor read can recover this value. */
  readonly token: string;
};

/** What authentication proves: the child Identity, its lineage, and its stored grant. */
export interface AuthenticatedCredential {
  readonly identity: Identity;
  readonly parentIdentity: Identity | null;
  readonly tokenId: string;
  readonly scopes: readonly string[];
}

interface StoredCredentialRow {
  readonly creation_seq: bigint;
  readonly token_id: string;
  readonly identity: bigint;
  readonly parent_identity: bigint | null;
  readonly secret_digest: Uint8Array;
  readonly name: string;
  readonly metadata: string;
  readonly scopes: string;
  readonly created_at: number;
  readonly updated_at: number;
}

type StoredDescriptorRow = Pick<StoredCredentialRow,
  "creation_seq" | "token_id" | "identity" | "name" | "metadata" | "scopes" | "created_at" | "updated_at"
>;

const utf8 = new TextEncoder();
const DUMMY_DIGEST = new Uint8Array(32);
const EMPTY_LINEAGE: readonly string[] = Object.freeze([]);

function digest(secret: string): Uint8Array {
  return createHash("sha256").update(secret).digest();
}

function validateIdentity(identity: unknown): asserts identity is Identity {
  if (typeof identity !== "bigint" || identity <= 0n) {
    throw new AckerDBError("validation", "credential Identity must be a positive bigint");
  }
}

function requireIdentity(connection: Database, identity: Identity): void {
  if (connection.query("SELECT 1 FROM _ackerdb_identities WHERE identity = ?").get(identity) === null) {
    throw new AckerDBError("not_found", "Identity not found");
  }
}

function validateTokenId(tokenId: unknown): asserts tokenId is string {
  if (typeof tokenId !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(tokenId)) {
    throw new AckerDBError("validation", "credential ID is invalid");
  }
}

function credentialName(value: unknown, maxBytes: number): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AckerDBError("validation", "credential name must be non-empty");
  }
  const name = value.trim();
  if (utf8.encode(name).byteLength > maxBytes) {
    throw new AckerDBError("validation", `credential name exceeds ${maxBytes} UTF-8 bytes`);
  }
  return name;
}

function metadata(value: unknown, maxBytes: number): {
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
  if (utf8.encode(encoded).byteLength > maxBytes) {
    throw new AckerDBError("validation", `credential metadata exceeds ${maxBytes} UTF-8 bytes`);
  }
  return { encoded, value: deepFreeze(decode(encoded) as Record<string, unknown>) };
}

/**
 * Validate one requested grant against the known vocabulary.
 *
 * A concrete entry must name a scope that exists: it addresses one exact thing,
 * so a name nothing answers to is a typo, and letting it through would store a
 * grant that silently authorizes nothing. A pattern is open-ended by
 * construction — `notes:*` is a claim on a prefix, deliberately including
 * scopes declared after the credential was minted — so only its shape is
 * checked here, and what it authorizes is decided at expansion.
 */
export function normalizeGrantPatterns(
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

function descriptor(row: StoredDescriptorRow): CredentialDescriptor {
  return Object.freeze({
    id: row.token_id,
    identity: row.identity as Identity,
    name: row.name,
    metadata: deepFreeze(decode(row.metadata) as Record<string, unknown>),
    scopes: storedScopes(row.scopes),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function invalidCredential(): AckerDBError {
  return new AckerDBError("unauthenticated", "invalid credential");
}

export function verifyCredentialVaultState(connection: Database): void {
  const rows = connection.query(
    "SELECT creation_seq, token_id, identity, parent_identity, secret_digest, name, metadata, scopes, created_at, updated_at FROM _ackerdb_credentials",
  );
  for (const row of rows.iterate() as IterableIterator<StoredCredentialRow>) {
    if (
      typeof row.creation_seq !== "bigint" ||
      row.creation_seq <= 0n ||
      typeof row.token_id !== "string" ||
      !/^[A-Za-z0-9_-]{22}$/.test(row.token_id) ||
      typeof row.identity !== "bigint" ||
      row.identity <= 0n ||
      (row.parent_identity !== null &&
        (typeof row.parent_identity !== "bigint" || row.parent_identity <= 0n)) ||
      !(row.secret_digest instanceof Uint8Array) ||
      row.secret_digest.byteLength !== 32 ||
      typeof row.name !== "string" ||
      row.name.length === 0 ||
      typeof row.metadata !== "string" ||
      typeof row.scopes !== "string" ||
      !Number.isFinite(row.created_at) ||
      !Number.isFinite(row.updated_at) ||
      row.updated_at < row.created_at
    ) {
      throw new CorruptDatabaseError("AckerDB credential vault is invalid");
    }
    try {
      const decoded = decode(row.metadata);
      if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error();
    } catch {
      throw new CorruptDatabaseError("AckerDB credential vault metadata is invalid");
    }
    storedScopes(row.scopes);
  }
}

/** Resolves the current grant patterns of a non-credential Identity. */
export type IdentityGrantResolver = (
  identity: Identity,
) => readonly string[] | Promise<readonly string[]>;

/**
 * Reads the external accounts one Identity answers to. The Engine owns
 * `_ackerdb_identity_accounts`, so the vault asks rather than queries — the
 * same shape `IdentityGrantResolver` already uses for the other question the
 * lineage walk must ask about an Identity it does not own.
 */
export type IdentityAccountResolver = (
  connection: Database,
  identity: Identity,
) => readonly ExternalAccount[];

/** A resolved grant and the upstream accounts an invalidation may narrow it through. */
export interface EffectiveGrant {
  readonly scopes: readonly string[];
  readonly derivedFrom: readonly ExternalAccount[];
}

const EMPTY_ACCOUNTS: readonly ExternalAccount[] = Object.freeze([]);

/** Engine-owned identity-credential storage. Every caller owns its SQLite transaction. */
export class CredentialVault {
  constructor(private readonly writer: Database) {}

  /**
   * Issue one credential, minting its Identity in the same transaction. The
   * subset invariant against the ISSUER's grant belongs to the caller
   * (`issueChildScopes`); this validates the requested grant's shape.
   */
  create(
    parentIdentity: Identity | null,
    input: CredentialCreateInput,
    vocabulary: readonly string[],
    limits: CredentialLimits,
    now: number,
  ): CreatedCredential {
    if (parentIdentity !== null) validateIdentity(parentIdentity);
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw new AckerDBError("validation", "credential create input must be an object");
    }
    for (const key of Object.keys(input)) {
      if (key !== "name" && key !== "metadata" && key !== "scopes") {
        throw new AckerDBError("validation", `unknown credential field "${key}"`);
      }
    }
    const name = credentialName(input.name, limits.maxNameBytes);
    const normalizedMetadata = metadata(input.metadata ?? {}, limits.maxMetadataBytes);
    const scopes = normalizeGrantPatterns(input.scopes ?? [], vocabulary, "credential scopes");
    if (!Number.isFinite(now) || now < 0) {
      throw new RangeError("credential clock must be finite and non-negative");
    }
    if (parentIdentity !== null) requireIdentity(this.writer, parentIdentity);
    const count = this.writer
      .query("SELECT COUNT(*) AS count FROM _ackerdb_credentials WHERE parent_identity IS ?")
      .get(parentIdentity) as { readonly count: bigint };
    if (count.count >= BigInt(limits.maxPerIdentity)) {
      throw new AckerDBError("overloaded", "credential capacity is full", { resource: "operation" });
    }

    const identity = (this.writer
      .query("INSERT INTO _ackerdb_identities DEFAULT VALUES RETURNING identity")
      .get() as { identity: bigint }).identity as Identity;
    const id = randomBytes(16).toString("base64url");
    const secret = randomBytes(32).toString("base64url");
    this.writer.query(
      `INSERT INTO _ackerdb_credentials
        (token_id, identity, parent_identity, secret_digest, name, metadata, scopes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      identity,
      parentIdentity,
      digest(secret),
      name,
      normalizedMetadata.encoded,
      encode(scopes),
      now,
      now,
    );
    return Object.freeze({
      id,
      identity,
      name,
      metadata: normalizedMetadata.value,
      scopes,
      createdAt: now,
      updatedAt: now,
      token: `${CREDENTIAL_TOKEN_PREFIX}${id}.${secret}`,
    });
  }

  list(
    connection: Database,
    parentIdentity: Identity | null,
  ): readonly CredentialDescriptor[] {
    if (parentIdentity !== null) {
      validateIdentity(parentIdentity);
      requireIdentity(connection, parentIdentity);
    }
    const rows = connection.query(
      `SELECT creation_seq, token_id, identity, name, metadata, scopes, created_at, updated_at
        FROM _ackerdb_credentials
        WHERE parent_identity IS ?
        ORDER BY creation_seq`,
    ).all(parentIdentity) as StoredDescriptorRow[];
    return Object.freeze(rows.map(descriptor));
  }

  /**
   * Every Admin Credential: a *root* credential whose stored grant is the
   * administrative one. This is the vault's single answer to "does a master
   * exist", and boot-mint, rotation and the offline break-glass reset all read
   * it rather than each deriving a predicate of their own — two derivations
   * would disagree the first time the definition moved, and disagreement here
   * means a database that clears rows one side still counts, or can never
   * re-mint.
   *
   * Rootness is half the definition and not an optimization. A *child* holding
   * the same patterns is a delegate: its live authority is intersected with its
   * parent's, so it is bounded by a master rather than being one. Restricting
   * the read to roots is also what keeps the set disjoint under revocation,
   * since no root is ever a descendant of another.
   *
   * The grant is decoded per row rather than compared as stored bytes: the
   * encoding is an implementation detail of the column, and the claim is about
   * the patterns. The root bucket is bounded by `maxPerIdentity`, so the scan
   * is a handful of rows.
   */
  listAdministrative(connection: Database): readonly CredentialDescriptor[] {
    const rows = connection.query(
      `SELECT creation_seq, token_id, identity, name, metadata, scopes, created_at, updated_at
        FROM _ackerdb_credentials
        WHERE parent_identity IS NULL
        ORDER BY creation_seq`,
    ).all() as StoredDescriptorRow[];
    return Object.freeze(
      rows.map(descriptor).filter((credential) => isAdministrativeGrant(credential.scopes)),
    );
  }

  update(
    parentIdentity: Identity | null,
    tokenId: string,
    input: CredentialUpdateInput,
    limits: CredentialLimits,
    now: number,
  ): void {
    if (parentIdentity !== null) validateIdentity(parentIdentity);
    validateTokenId(tokenId);
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw new AckerDBError("validation", "credential update input must be an object");
    }
    const keys = Object.keys(input);
    if (keys.length === 0) {
      throw new AckerDBError("validation", "credential update requires name or metadata");
    }
    for (const key of keys) {
      if (key !== "name" && key !== "metadata") {
        throw new AckerDBError("validation", `unknown credential field "${key}"`);
      }
    }
    const name = Object.hasOwn(input, "name")
      ? credentialName(input.name, limits.maxNameBytes)
      : undefined;
    const normalizedMetadata = Object.hasOwn(input, "metadata")
      ? metadata(input.metadata, limits.maxMetadataBytes)
      : undefined;
    if (!Number.isFinite(now) || now < 0) {
      throw new RangeError("credential clock must be finite and non-negative");
    }

    const assignments: string[] = [];
    const values: unknown[] = [];
    if (name !== undefined) {
      assignments.push("name = ?");
      values.push(name);
    }
    if (normalizedMetadata !== undefined) {
      assignments.push("metadata = ?");
      values.push(normalizedMetadata.encoded);
    }
    assignments.push("updated_at = ?");
    values.push(now, tokenId, parentIdentity);
    const result = this.writer.query(
      `UPDATE _ackerdb_credentials
        SET ${assignments.join(", ")}
        WHERE token_id = ? AND parent_identity IS ?`,
    ).run(...(values as never[]));
    if (result.changes === 0) throw new AckerDBError("not_found", "credential not found");
  }

  /**
   * Replace the stored grant, and report every credential whose live authority
   * the change can reach: the credential itself plus everything delegated
   * beneath it, because a descendant's effective grant is intersected with
   * this one's. An unchanged grant reaches nothing.
   */
  updateScopes(
    parentIdentity: Identity | null,
    tokenId: string,
    value: unknown,
    vocabulary: readonly string[],
    now: number,
  ): readonly string[] {
    if (parentIdentity !== null) validateIdentity(parentIdentity);
    validateTokenId(tokenId);
    const scopes = normalizeGrantPatterns(value, vocabulary, "credential scopes");
    const stored = this.writer.query(
      `SELECT scopes FROM _ackerdb_credentials
        WHERE token_id = ? AND parent_identity IS ?`,
    ).get(tokenId, parentIdentity) as Pick<StoredCredentialRow, "scopes"> | null;
    if (stored === null) throw new AckerDBError("not_found", "credential not found");
    const previous = storedScopes(stored.scopes);
    const result = this.writer.query(
      `UPDATE _ackerdb_credentials
        SET scopes = ?, updated_at = ?
        WHERE token_id = ? AND parent_identity IS ?`,
    ).run(encode(scopes), now, tokenId, parentIdentity);
    if (result.changes === 0) throw new AckerDBError("not_found", "credential not found");
    const changed = previous.length !== scopes.length ||
      previous.some((scope, index) => scopes[index] !== scope);
    return changed ? this.lineage(this.writer, tokenId) : EMPTY_LINEAGE;
  }

  /**
   * Revoke one credential and everything delegated beneath it, returning every
   * token id removed. The cascade is the invariant, not a convenience: a
   * child's authority is bounded by its parent's, so a surviving child of a
   * revoked parent would have no source to be bounded by — and, because a
   * credential-less Identity reads as an ordinary application root, it would be
   * resolved by the application's own scope resolver instead of failing closed.
   */
  revoke(parentIdentity: Identity | null, tokenId: string): readonly string[] {
    if (parentIdentity !== null) validateIdentity(parentIdentity);
    validateTokenId(tokenId);
    // Ownership is proved against the named credential; the cascade below is
    // unconditional, because everything under it descends from that authority.
    const owned = this.writer.query(
      "SELECT 1 FROM _ackerdb_credentials WHERE token_id = ? AND parent_identity IS ?",
    ).get(tokenId, parentIdentity);
    if (owned === null) throw new AckerDBError("not_found", "credential not found");
    const revoked = this.lineage(this.writer, tokenId);
    this.writer.query(
      `DELETE FROM _ackerdb_credentials WHERE token_id IN (${revoked.map(() => "?").join(", ")})`,
    ).run(...(revoked as string[]));
    return revoked;
  }

  /**
   * One credential and every credential delegated beneath it. Identity creation
   * order makes the delegation chain acyclic, and the owner index answers each
   * level directly, so the walk costs one indexed step per level.
   */
  lineage(connection: Database, tokenId: string): readonly string[] {
    validateTokenId(tokenId);
    const rows = connection.query(
      `WITH RECURSIVE lineage(token_id, identity) AS (
        SELECT token_id, identity FROM _ackerdb_credentials WHERE token_id = ?
        UNION ALL
        SELECT c.token_id, c.identity
          FROM _ackerdb_credentials c
          JOIN lineage ON c.parent_identity = lineage.identity
      )
      SELECT token_id FROM lineage`,
    ).all(tokenId) as { token_id: string }[];
    return Object.freeze(rows.map((row) => row.token_id));
  }

  authenticate(
    connection: Database,
    parsed: ParsedCredentialToken,
  ): AuthenticatedCredential {
    const row = connection.query(
      "SELECT identity, parent_identity, secret_digest, scopes FROM _ackerdb_credentials WHERE token_id = ?",
    ).get(parsed.id) as Pick<
      StoredCredentialRow,
      "identity" | "parent_identity" | "secret_digest" | "scopes"
    > | null;
    const expected = row?.secret_digest ?? DUMMY_DIGEST;
    const matches = expected.byteLength === 32 && timingSafeEqual(digest(parsed.secret), expected);
    if (!matches || row === null) throw invalidCredential();
    return Object.freeze({
      identity: row.identity as Identity,
      parentIdentity: row.parent_identity === null ? null : row.parent_identity as Identity,
      tokenId: parsed.id,
      scopes: storedScopes(row.scopes),
    });
  }

  /** The Identity a token id names, or null when no credential holds it. */
  identityForToken(connection: Database, tokenId: string): Identity | null {
    validateTokenId(tokenId);
    const row = connection.query(
      "SELECT identity FROM _ackerdb_credentials WHERE token_id = ?",
    ).get(tokenId) as { identity: bigint } | null;
    return row === null ? null : row.identity as Identity;
  }

  /**
   * The live grant an Identity holds through the vault, and the external
   * accounts that bound it: its stored patterns expanded, then narrowed by
   * every ancestor's current expansion up the delegation chain, ending at a
   * non-credential Identity resolved by the application. Identity creation
   * order makes the chain acyclic.
   *
   * The walk also collects `derivedFrom` — the accounts of that root Identity.
   * A delegated credential is live under its own `ackerdb:credentials`
   * subject, so an invalidation for the account upstream would otherwise miss
   * it, and a vault principal never expires out of the stale authority.
   * Collecting the roots here is what keeps the invalidation channel
   * synchronous: the read happens once, where a read already happens.
   */
  async effectiveGrant(
    connection: Database,
    identity: Identity,
    vocabulary: readonly string[],
    resolveIdentityGrant: IdentityGrantResolver,
    accountsForIdentity: IdentityAccountResolver,
  ): Promise<EffectiveGrant> {
    const row = connection.query(
      "SELECT parent_identity, scopes FROM _ackerdb_credentials WHERE identity = ?",
    ).get(identity) as Pick<StoredCredentialRow, "parent_identity" | "scopes"> | null;
    if (row === null) {
      return Object.freeze({
        scopes: expandScopeGrant(await resolveIdentityGrant(identity), vocabulary),
        derivedFrom: accountsForIdentity(connection, identity),
      });
    }
    const stored = expandScopeGrant(storedScopes(row.scopes), vocabulary);
    if (row.parent_identity === null) {
      return Object.freeze({ scopes: stored, derivedFrom: EMPTY_ACCOUNTS });
    }
    const parent = await this.effectiveGrant(
      connection,
      row.parent_identity as Identity,
      vocabulary,
      resolveIdentityGrant,
      accountsForIdentity,
    );
    return Object.freeze({
      scopes: effectiveChildScopes(stored, parent.scopes),
      derivedFrom: parent.derivedFrom,
    });
  }
}
