import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Database } from "bun:sqlite";
import { decode, encode } from "@dbzz/core";
import type { Identity } from "./dbz.ts";
import { CorruptDatabaseError, DbzzError } from "./errors.ts";
import { deepFreeze } from "./immutable.ts";
import { MCP_TOKEN_PREFIX, parseMcpToken } from "./mcp-credential.ts";
import {
  isMcpScopeGrant,
  normalizeMcpScopeGrant,
  type McpScopeDescriptor,
} from "./mcp-scopes.ts";

export const mcpTokenVaultOwner = Symbol("dbzz.mcpTokenVault");

export const MCP_TOKEN_INTERNAL_OBJECTS = [
  {
    type: "table" as const,
    name: "_dbz_mcp_tokens",
    table: "_dbz_mcp_tokens",
    sql: `CREATE TABLE _dbz_mcp_tokens (
      token_id TEXT PRIMARY KEY CHECK (length(token_id) = 22),
      identity INTEGER NOT NULL REFERENCES _dbz_identities(identity) ON UPDATE RESTRICT ON DELETE RESTRICT,
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
    name: "ix__dbz_mcp_tokens_owner",
    table: "_dbz_mcp_tokens",
    sql: "CREATE INDEX ix__dbz_mcp_tokens_owner ON _dbz_mcp_tokens (identity, mcp, created_at, token_id)",
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

const utf8 = new TextEncoder();
const DUMMY_DIGEST = new Uint8Array(32);

function digest(secret: string): Uint8Array {
  return createHash("sha256").update(secret).digest();
}

function validateIdentity(identity: unknown): asserts identity is Identity {
  if (typeof identity !== "bigint" || identity <= 0n) {
    throw new DbzzError("validation", "MCP token Identity must be a positive bigint");
  }
}

function requireIdentity(connection: Database, identity: Identity): void {
  if (connection.query("SELECT 1 FROM _dbz_identities WHERE identity = ?").get(identity) === null) {
    throw new DbzzError("not_found", "Identity not found");
  }
}

function validateTokenId(tokenId: unknown): asserts tokenId is string {
  if (typeof tokenId !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(tokenId)) {
    throw new DbzzError("validation", "MCP token ID is invalid");
  }
}

function metadata(value: unknown, maxBytes: number): {
  readonly encoded: string;
  readonly value: Readonly<Record<string, unknown>>;
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DbzzError("validation", "MCP token metadata must be an object");
  }
  let encoded: string;
  try {
    encoded = encode(value);
  } catch (cause) {
    throw new DbzzError("validation", "MCP token metadata must be wire-encodable", { cause });
  }
  if (utf8.encode(encoded).byteLength > maxBytes) {
    throw new DbzzError("validation", `MCP token metadata exceeds ${maxBytes} UTF-8 bytes`);
  }
  return { encoded, value: deepFreeze(decode(encoded) as Record<string, unknown>) };
}

function storedScopes(encoded: string): readonly string[] {
  let value: unknown;
  try {
    value = decode(encoded);
  } catch {
    throw new CorruptDatabaseError("DBZZ MCP token scope grant is invalid");
  }
  if (!isMcpScopeGrant(value)) {
    throw new CorruptDatabaseError("DBZZ MCP token scope grant is invalid");
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
      throw new CorruptDatabaseError("DBZZ MCP token scope grant is invalid for its endpoint");
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

function invalidCredential(): DbzzError {
  return new DbzzError("unauthenticated", "invalid MCP credential");
}

export function verifyMcpTokenVaultState(connection: Database): void {
  const rows = connection.query(
    "SELECT token_id, identity, mcp, secret_digest, name, metadata, scopes, created_at, updated_at FROM _dbz_mcp_tokens",
  );
  for (const row of rows.iterate() as IterableIterator<StoredTokenRow>) {
    if (
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
      throw new CorruptDatabaseError("DBZZ MCP token vault is invalid");
    }
    try {
      const decoded = decode(row.metadata);
      if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error();
    } catch {
      throw new CorruptDatabaseError("DBZZ MCP token vault metadata is invalid");
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
      throw new DbzzError("validation", "MCP token create input must be an object");
    }
    for (const key of Object.keys(input)) {
      if (key !== "name" && key !== "metadata" && !(key === "scopes" && scopeDescriptor !== undefined)) {
        throw new DbzzError("validation", `unknown MCP token field "${key}"`);
      }
    }
    if (typeof input.name !== "string" || input.name.trim() === "") {
      throw new DbzzError("validation", "MCP token name must be non-empty");
    }
    const name = input.name.trim();
    if (utf8.encode(name).byteLength > limits.maxNameBytes) {
      throw new DbzzError("validation", `MCP token name exceeds ${limits.maxNameBytes} UTF-8 bytes`);
    }
    const normalizedMetadata = metadata(input.metadata ?? {}, limits.maxMetadataBytes);
    const scopes = scopeDescriptor === undefined
      ? Object.freeze([])
      : normalizeMcpScopeGrant(scopeDescriptor, input.scopes, "MCP token scopes");
    if (!Number.isFinite(now) || now < 0) throw new RangeError("MCP token clock must be finite and non-negative");
    requireIdentity(this.writer, identity);
    const count = this.writer
      .query("SELECT COUNT(*) AS count FROM _dbz_mcp_tokens WHERE identity = ? AND mcp = ?")
      .get(identity, mcp) as { readonly count: bigint };
    if (count.count >= BigInt(limits.maxTokensPerIdentity)) {
      throw new DbzzError("overloaded", "MCP token capacity is full", { resource: "operation" });
    }

    const id = randomBytes(16).toString("base64url");
    const secret = randomBytes(32).toString("base64url");
    this.writer.query(
      `INSERT INTO _dbz_mcp_tokens
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
      `SELECT token_id, mcp, name, metadata, scopes, created_at, updated_at
        FROM _dbz_mcp_tokens
        WHERE identity = ? AND mcp = ?
        ORDER BY created_at, token_id`,
    ).all(identity, mcp) as StoredTokenRow[];
    return Object.freeze(rows.map((row) => descriptor(row, scopeDescriptor)));
  }

  updateScopes<Scope extends string>(
    identity: Identity,
    mcp: string,
    tokenId: string,
    value: unknown,
    scopeDescriptor: McpScopeDescriptor<Scope>,
    now: number,
  ): void {
    validateIdentity(identity);
    validateTokenId(tokenId);
    const scopes = normalizeMcpScopeGrant(scopeDescriptor, value, "MCP token scopes");
    const result = this.writer.query(
      `UPDATE _dbz_mcp_tokens
        SET scopes = ?, updated_at = ?
        WHERE token_id = ? AND identity = ? AND mcp = ?`,
    ).run(encode(scopes), now, tokenId, identity, mcp);
    if (result.changes === 0) throw new DbzzError("not_found", "MCP token not found");
  }

  revoke(identity: Identity, mcp: string, tokenId: string): void {
    validateIdentity(identity);
    validateTokenId(tokenId);
    requireIdentity(this.writer, identity);
    const result = this.writer.query(
      "DELETE FROM _dbz_mcp_tokens WHERE token_id = ? AND identity = ? AND mcp = ?",
    ).run(tokenId, identity, mcp);
    if (result.changes === 0) throw new DbzzError("not_found", "MCP token not found");
  }

  authenticate(
    connection: Database,
    expectedMcp: string,
    rawToken: string,
    scopeDescriptor: McpScopeDescriptor | undefined,
  ): Readonly<{ identity: Identity; tokenId: string; scopes: readonly string[] }> {
    const parsed = parseMcpToken(rawToken);
    if (parsed === null) throw invalidCredential();
    const row = connection.query(
      "SELECT identity, mcp, secret_digest, scopes FROM _dbz_mcp_tokens WHERE token_id = ?",
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
