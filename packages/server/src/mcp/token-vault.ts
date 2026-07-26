import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Database } from "bun:sqlite";
import { decode, encode } from "@ackerdb/core";
import type { Identity } from "../validation/v.ts";
import { CorruptDatabaseError, AckerDBError } from "../shared/errors.ts";
import { deepFreeze } from "../shared/immutable.ts";
import { MCP_TOKEN_PREFIX, type ParsedMcpToken } from "./credential.ts";
import {
  isMcpScopeGrant,
  normalizeMcpScopeGrant,
  type McpScopeDescriptor,
} from "./scopes.ts";

export const mcpTokenVaultOwner = Symbol("ackerdb.mcpTokenVault");

export const MCP_TOKEN_INTERNAL_OBJECTS = [
  {
    type: "table" as const,
    name: "_ackerdb_mcp_tokens",
    table: "_ackerdb_mcp_tokens",
    sql: `CREATE TABLE _ackerdb_mcp_tokens (
      creation_seq INTEGER PRIMARY KEY,
      token_id TEXT NOT NULL UNIQUE CHECK (length(token_id) = 22),
      identity INTEGER NOT NULL REFERENCES _ackerdb_identities(identity) ON UPDATE RESTRICT ON DELETE RESTRICT,
      mcp TEXT NOT NULL CHECK (length(mcp) > 0),
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
    name: "ix__ackerdb_mcp_tokens_owner",
    table: "_ackerdb_mcp_tokens",
    sql: "CREATE INDEX ix__ackerdb_mcp_tokens_owner ON _ackerdb_mcp_tokens (identity, mcp, creation_seq)",
  },
] as const;

export interface McpTokenLimits {
  readonly maxTokensPerIdentity: number;
  readonly maxNameBytes: number;
  readonly maxMetadataBytes: number;
}

interface McpTokenCreateInputBase {
  readonly name: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type McpTokenCreateInput<Scope extends string = never> = McpTokenCreateInputBase &
  ([Scope] extends [never]
    ? { readonly scopes?: never }
    : { readonly scopes: readonly Scope[] });

export type McpTokenUpdateInput =
  | {
      readonly name: string;
      readonly metadata?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly name?: string;
      readonly metadata: Readonly<Record<string, unknown>>;
    };

interface McpTokenDescriptorBase {
  readonly id: string;
  readonly mcp: string;
  readonly name: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type McpTokenDescriptor<Scope extends string = never> = McpTokenDescriptorBase &
  ([Scope] extends [never] ? object : { readonly scopes: readonly Scope[] });

export type CreatedMcpToken<Scope extends string = never> = McpTokenDescriptor<Scope> & {
  /** Returned only from create; no descriptor read can recover this value. */
  readonly token: string;
};

interface StoredTokenRow {
  readonly creation_seq: bigint;
  readonly token_id: string;
  readonly identity: bigint;
  readonly mcp: string;
  readonly secret_digest: Uint8Array;
  readonly name: string;
  readonly metadata: string;
  readonly scopes: string;
  readonly created_at: number;
  readonly updated_at: number;
}

type StoredTokenDescriptorRow = Pick<StoredTokenRow,
  "creation_seq" | "token_id" | "mcp" | "name" | "metadata" | "scopes" | "created_at" | "updated_at"
>;

const utf8 = new TextEncoder();
const DUMMY_DIGEST = new Uint8Array(32);

function digest(secret: string): Uint8Array {
  return createHash("sha256").update(secret).digest();
}

function validateIdentity(identity: unknown): asserts identity is Identity {
  if (typeof identity !== "bigint" || identity <= 0n) {
    throw new AckerDBError("validation", "MCP token Identity must be a positive bigint");
  }
}

function requireIdentity(connection: Database, identity: Identity): void {
  if (connection.query("SELECT 1 FROM _ackerdb_identities WHERE identity = ?").get(identity) === null) {
    throw new AckerDBError("not_found", "Identity not found");
  }
}

function validateTokenId(tokenId: unknown): asserts tokenId is string {
  if (typeof tokenId !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(tokenId)) {
    throw new AckerDBError("validation", "MCP token ID is invalid");
  }
}

function tokenName(value: unknown, maxBytes: number): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AckerDBError("validation", "MCP token name must be non-empty");
  }
  const name = value.trim();
  if (utf8.encode(name).byteLength > maxBytes) {
    throw new AckerDBError("validation", `MCP token name exceeds ${maxBytes} UTF-8 bytes`);
  }
  return name;
}

function metadata(value: unknown, maxBytes: number): {
  readonly encoded: string;
  readonly value: Readonly<Record<string, unknown>>;
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AckerDBError("validation", "MCP token metadata must be an object");
  }
  let encoded: string;
  try {
    encoded = encode(value);
  } catch (cause) {
    throw new AckerDBError("validation", "MCP token metadata must be wire-encodable", { cause });
  }
  if (utf8.encode(encoded).byteLength > maxBytes) {
    throw new AckerDBError("validation", `MCP token metadata exceeds ${maxBytes} UTF-8 bytes`);
  }
  return { encoded, value: deepFreeze(decode(encoded) as Record<string, unknown>) };
}

function storedScopes(encoded: string): readonly string[] {
  let value: unknown;
  try {
    value = decode(encoded);
  } catch {
    throw new CorruptDatabaseError("AckerDB MCP token scope grant is invalid");
  }
  if (!isMcpScopeGrant(value)) {
    throw new CorruptDatabaseError("AckerDB MCP token scope grant is invalid");
  }
  return Object.freeze([...value]);
}

function descriptor<Scope extends string>(
  row: Pick<StoredTokenRow,
    "token_id" | "mcp" | "name" | "metadata" | "scopes" | "created_at" | "updated_at"
  >,
  scopeDescriptor: McpScopeDescriptor<Scope> | undefined,
): McpTokenDescriptor<Scope> {
  const grant = storedScopes(row.scopes);
  if (scopeDescriptor === undefined && grant.length !== 0) {
    throw new CorruptDatabaseError("scope-free MCP token contains a scope grant");
  }
  let scopes: readonly Scope[] | undefined;
  if (scopeDescriptor !== undefined) {
    try {
      scopes = normalizeMcpScopeGrant(scopeDescriptor, grant, "stored MCP token scopes");
    } catch {
      throw new CorruptDatabaseError("AckerDB MCP token scope grant is invalid for its endpoint");
    }
  }
  return Object.freeze({
    id: row.token_id,
    mcp: row.mcp,
    name: row.name,
    metadata: deepFreeze(decode(row.metadata) as Record<string, unknown>),
    ...(scopes === undefined ? {} : { scopes }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }) as McpTokenDescriptor<Scope>;
}

function invalidCredential(): AckerDBError {
  return new AckerDBError("unauthenticated", "invalid MCP credential");
}

export function verifyMcpTokenVaultState(connection: Database): void {
  const rows = connection.query(
    "SELECT creation_seq, token_id, identity, mcp, secret_digest, name, metadata, scopes, created_at, updated_at FROM _ackerdb_mcp_tokens",
  );
  for (const row of rows.iterate() as IterableIterator<StoredTokenRow>) {
    if (
      typeof row.creation_seq !== "bigint" ||
      row.creation_seq <= 0n ||
      typeof row.token_id !== "string" ||
      !/^[A-Za-z0-9_-]{22}$/.test(row.token_id) ||
      typeof row.identity !== "bigint" ||
      row.identity <= 0n ||
      typeof row.mcp !== "string" ||
      row.mcp.length === 0 ||
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
      throw new CorruptDatabaseError("AckerDB MCP token vault is invalid");
    }
    try {
      const decoded = decode(row.metadata);
      if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error();
    } catch {
      throw new CorruptDatabaseError("AckerDB MCP token vault metadata is invalid");
    }
    storedScopes(row.scopes);
  }
}

/** Engine-owned opaque token storage. Every caller already owns its SQLite transaction. */
export class McpTokenVault {
  constructor(private readonly writer: Database) {}

  create<Scope extends string>(
    identity: Identity,
    mcp: string,
    input: McpTokenCreateInput<Scope>,
    scopeDescriptor: McpScopeDescriptor<Scope> | undefined,
    limits: McpTokenLimits,
    now: number,
  ): CreatedMcpToken<Scope> {
    validateIdentity(identity);
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw new AckerDBError("validation", "MCP token create input must be an object");
    }
    for (const key of Object.keys(input)) {
      if (key !== "name" && key !== "metadata" && !(key === "scopes" && scopeDescriptor !== undefined)) {
        throw new AckerDBError("validation", `unknown MCP token field "${key}"`);
      }
    }
    const name = tokenName(input.name, limits.maxNameBytes);
    const normalizedMetadata = metadata(input.metadata ?? {}, limits.maxMetadataBytes);
    const scopes = scopeDescriptor === undefined
      ? Object.freeze([])
      : normalizeMcpScopeGrant(scopeDescriptor, input.scopes, "MCP token scopes");
    if (!Number.isFinite(now) || now < 0) {
      throw new RangeError("MCP token clock must be finite and non-negative");
    }
    requireIdentity(this.writer, identity);
    const count = this.writer
      .query("SELECT COUNT(*) AS count FROM _ackerdb_mcp_tokens WHERE identity = ? AND mcp = ?")
      .get(identity, mcp) as { readonly count: bigint };
    if (count.count >= BigInt(limits.maxTokensPerIdentity)) {
      throw new AckerDBError("overloaded", "MCP token capacity is full", { resource: "operation" });
    }

    const id = randomBytes(16).toString("base64url");
    const secret = randomBytes(32).toString("base64url");
    this.writer.query(
      `INSERT INTO _ackerdb_mcp_tokens
        (token_id, identity, mcp, secret_digest, name, metadata, scopes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, identity, mcp, digest(secret), name, normalizedMetadata.encoded, encode(scopes), now, now);
    return Object.freeze({
      id,
      mcp,
      name,
      metadata: normalizedMetadata.value,
      ...(scopeDescriptor === undefined ? {} : { scopes }),
      createdAt: now,
      updatedAt: now,
      token: `${MCP_TOKEN_PREFIX}${id}.${secret}`,
    }) as CreatedMcpToken<Scope>;
  }

  list<Scope extends string>(
    connection: Database,
    identity: Identity,
    mcp: string,
    scopeDescriptor: McpScopeDescriptor<Scope> | undefined,
  ): readonly McpTokenDescriptor<Scope>[] {
    validateIdentity(identity);
    requireIdentity(connection, identity);
    const rows = connection.query(
      `SELECT creation_seq, token_id, mcp, name, metadata, scopes, created_at, updated_at
        FROM _ackerdb_mcp_tokens
        WHERE identity = ? AND mcp = ?
        ORDER BY creation_seq`,
    ).all(identity, mcp) as StoredTokenDescriptorRow[];
    return Object.freeze(rows.map((row) => descriptor(row, scopeDescriptor)));
  }

  update(
    identity: Identity,
    mcp: string,
    tokenId: string,
    input: McpTokenUpdateInput,
    limits: McpTokenLimits,
    now: number,
  ): void {
    validateIdentity(identity);
    validateTokenId(tokenId);
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw new AckerDBError("validation", "MCP token update input must be an object");
    }
    const keys = Object.keys(input);
    if (keys.length === 0) {
      throw new AckerDBError("validation", "MCP token update requires name or metadata");
    }
    for (const key of keys) {
      if (key !== "name" && key !== "metadata") {
        throw new AckerDBError("validation", `unknown MCP token field "${key}"`);
      }
    }
    const name = Object.hasOwn(input, "name")
      ? tokenName(input.name, limits.maxNameBytes)
      : undefined;
    const normalizedMetadata = Object.hasOwn(input, "metadata")
      ? metadata(input.metadata, limits.maxMetadataBytes)
      : undefined;
    if (!Number.isFinite(now) || now < 0) {
      throw new RangeError("MCP token clock must be finite and non-negative");
    }
    requireIdentity(this.writer, identity);

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
    values.push(now, tokenId, identity, mcp);
    const result = this.writer.query(
      `UPDATE _ackerdb_mcp_tokens
        SET ${assignments.join(", ")}
        WHERE token_id = ? AND identity = ? AND mcp = ?`,
    ).run(...(values as never[]));
    if (result.changes === 0) throw new AckerDBError("not_found", "MCP token not found");
  }

  updateScopes<Scope extends string>(
    identity: Identity,
    mcp: string,
    tokenId: string,
    value: unknown,
    scopeDescriptor: McpScopeDescriptor<Scope>,
    now: number,
  ): boolean {
    validateIdentity(identity);
    validateTokenId(tokenId);
    const scopes = normalizeMcpScopeGrant(scopeDescriptor, value, "MCP token scopes");
    const stored = this.writer.query(
      `SELECT scopes FROM _ackerdb_mcp_tokens
        WHERE token_id = ? AND identity = ? AND mcp = ?`,
    ).get(tokenId, identity, mcp) as Pick<StoredTokenRow, "scopes"> | null;
    if (stored === null) throw new AckerDBError("not_found", "MCP token not found");
    let previous: readonly Scope[];
    try {
      previous = normalizeMcpScopeGrant(
        scopeDescriptor,
        storedScopes(stored.scopes),
        "stored MCP token scopes",
      );
    } catch {
      throw new CorruptDatabaseError("AckerDB MCP token scope grant is invalid for its endpoint");
    }
    const result = this.writer.query(
      `UPDATE _ackerdb_mcp_tokens
        SET scopes = ?, updated_at = ?
        WHERE token_id = ? AND identity = ? AND mcp = ?`,
    ).run(encode(scopes), now, tokenId, identity, mcp);
    if (result.changes === 0) throw new AckerDBError("not_found", "MCP token not found");
    const next = new Set(scopes);
    return previous.some((scope) => !next.has(scope));
  }

  revoke(identity: Identity, mcp: string, tokenId: string): void {
    validateIdentity(identity);
    validateTokenId(tokenId);
    requireIdentity(this.writer, identity);
    const result = this.writer.query(
      "DELETE FROM _ackerdb_mcp_tokens WHERE token_id = ? AND identity = ? AND mcp = ?",
    ).run(tokenId, identity, mcp);
    if (result.changes === 0) throw new AckerDBError("not_found", "MCP token not found");
  }

  authenticate(
    connection: Database,
    expectedMcp: string,
    parsed: ParsedMcpToken,
    scopeDescriptor: McpScopeDescriptor | undefined,
  ): Readonly<{ identity: Identity; tokenId: string; scopes: readonly string[] }> {
    const row = connection.query(
      "SELECT identity, mcp, secret_digest, scopes FROM _ackerdb_mcp_tokens WHERE token_id = ?",
    ).get(parsed.id) as Pick<StoredTokenRow, "identity" | "mcp" | "secret_digest" | "scopes"> | null;
    const expected = row?.secret_digest ?? DUMMY_DIGEST;
    const matches = expected.byteLength === 32 && timingSafeEqual(digest(parsed.secret), expected);
    if (!matches || row === null || row.mcp !== expectedMcp) throw invalidCredential();
    const storedGrant = storedScopes(row.scopes);
    let scopes: readonly string[];
    try {
      if (scopeDescriptor === undefined) {
        if (storedGrant.length !== 0) throw invalidCredential();
        scopes = storedGrant;
      } else {
        scopes = normalizeMcpScopeGrant(scopeDescriptor, storedGrant, "stored MCP token scopes");
      }
    } catch {
      throw invalidCredential();
    }
    return Object.freeze({
      identity: row.identity as Identity,
      tokenId: parsed.id,
      scopes,
    });
  }
}
