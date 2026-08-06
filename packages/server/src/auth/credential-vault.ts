/**
 * Engine-owned identity-credential storage.
 *
 * Every credential IS an Identity: creating one mints a fresh child Identity
 * row, so an agent authenticating with the token is a first-class user at
 * every choke point. `parent_identity` records delegation lineage — null for
 * standalone identities whose scopes are granted directly, otherwise the
 * issuing Identity whose current grant bounds the child at use
 * (`effectiveChildScopes`). Every caller already owns its SQLite transaction.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Database } from "bun:sqlite";
import { decode, encode, type Identity } from "@ackerdb/core";
import { CorruptDatabaseError, AckerDBError } from "../shared/errors.ts";
import { deepFreeze } from "../shared/immutable.ts";
import { CREDENTIAL_TOKEN_PREFIX, type ParsedCredentialToken } from "./credential-token.ts";
import {
  isScopeGrant,
  normalizeGrantAgainstVocabulary,
} from "./access-policy.ts";
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
  readonly maxTokensPerIdentity: number;
  readonly maxNameBytes: number;
  readonly maxMetadataBytes: number;
}

export interface CredentialCreateInput {
  readonly name: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
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

/** Resolves the current direct grant of a non-credential Identity. */
export type IdentityGrantResolver = (
  identity: Identity,
) => readonly string[] | Promise<readonly string[]>;

/** Engine-owned identity-credential storage. Every caller owns its SQLite transaction. */
export class CredentialVault {
  constructor(private readonly writer: Database) {}

  /**
   * Issue one credential, minting its child Identity in the same transaction.
   * The subset invariant against the ISSUER's grant is the caller's to
   * enforce (`issueChildScopes`) — this validates against the vocabulary.
   */
  create(
    parentIdentity: Identity | null,
    input: CredentialCreateInput,
    vocabulary: readonly string[] | undefined,
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
    const scopes = normalizeGrantAgainstVocabulary(
      vocabulary,
      input.scopes ?? [],
      "credential scopes",
    );
    if (!Number.isFinite(now) || now < 0) {
      throw new RangeError("credential clock must be finite and non-negative");
    }
    if (parentIdentity !== null) requireIdentity(this.writer, parentIdentity);
    const count = this.writer
      .query("SELECT COUNT(*) AS count FROM _ackerdb_credentials WHERE parent_identity IS ?")
      .get(parentIdentity) as { readonly count: bigint };
    if (count.count >= BigInt(limits.maxTokensPerIdentity)) {
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
    ).run(id, identity, parentIdentity, digest(secret), name, normalizedMetadata.encoded, encode(scopes), now, now);
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

  /** Replace the stored grant. Returns true when the grant changed at all. */
  updateScopes(
    parentIdentity: Identity | null,
    tokenId: string,
    value: unknown,
    vocabulary: readonly string[] | undefined,
    now: number,
  ): boolean {
    if (parentIdentity !== null) validateIdentity(parentIdentity);
    validateTokenId(tokenId);
    const scopes = normalizeGrantAgainstVocabulary(vocabulary, value, "credential scopes");
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
    return previous.length !== scopes.length ||
      previous.some((scope, index) => scopes[index] !== scope);
  }

  revoke(parentIdentity: Identity | null, tokenId: string): void {
    if (parentIdentity !== null) validateIdentity(parentIdentity);
    validateTokenId(tokenId);
    const result = this.writer.query(
      "DELETE FROM _ackerdb_credentials WHERE token_id = ? AND parent_identity IS ?",
    ).run(tokenId, parentIdentity);
    if (result.changes === 0) throw new AckerDBError("not_found", "credential not found");
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

  /** The child Identity a token id names, or null when no credential holds it. */
  identityForToken(connection: Database, tokenId: string): Identity | null {
    validateTokenId(tokenId);
    const row = connection.query(
      "SELECT identity FROM _ackerdb_credentials WHERE token_id = ?",
    ).get(tokenId) as { identity: bigint } | null;
    return row === null ? null : row.identity as Identity;
  }

  /**
   * The live grant an Identity holds through the vault: its stored scopes
   * narrowed by every ancestor's current grant (`effectiveChildScopes` up the
   * delegation chain, ending at a non-credential Identity resolved by the
   * application). Identity creation order makes the chain acyclic.
   */
  async effectiveScopes(
    connection: Database,
    identity: Identity,
    resolveIdentityGrant: IdentityGrantResolver,
  ): Promise<readonly string[]> {
    const row = connection.query(
      "SELECT parent_identity, scopes FROM _ackerdb_credentials WHERE identity = ?",
    ).get(identity) as Pick<StoredCredentialRow, "parent_identity" | "scopes"> | null;
    if (row === null) return Object.freeze([...await resolveIdentityGrant(identity)]);
    const stored = storedScopes(row.scopes);
    if (row.parent_identity === null) return stored;
    const parent = await this.effectiveScopes(
      connection,
      row.parent_identity as Identity,
      resolveIdentityGrant,
    );
    return effectiveChildScopes(stored, parent);
  }
}
