import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Database } from "bun:sqlite";
import { decode, encode } from "@dbzz/core";
import type { Identity } from "./dbz.ts";
import { CorruptDatabaseError, DbzzError } from "./errors.ts";
import { deepFreeze } from "./immutable.ts";
import { MCP_TOKEN_PREFIX, parseMcpToken } from "./mcp-credential.ts";

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

export interface McpTokenCreateInput {
  readonly name: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface McpTokenDescriptor {
  readonly id: string;
  readonly mcp: string;
  readonly name: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CreatedMcpToken extends McpTokenDescriptor {
  /** Returned only from create; no descriptor read can recover this value. */
  readonly token: string;
}

interface StoredTokenRow {
  readonly token_id: string;
  readonly identity: bigint;
  readonly mcp: string;
  readonly secret_digest: Uint8Array;
  readonly name: string;
  readonly metadata: string;
  readonly created_at: number;
  readonly updated_at: number;
}

const utf8 = new TextEncoder();
const DUMMY_DIGEST = new Uint8Array(32);

function digest(secret: string): Uint8Array {
  return createHash("sha256").update(secret).digest();
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

function descriptor(row: Pick<StoredTokenRow,
  "token_id" | "mcp" | "name" | "metadata" | "created_at" | "updated_at"
>): McpTokenDescriptor {
  return Object.freeze({
    id: row.token_id,
    mcp: row.mcp,
    name: row.name,
    metadata: deepFreeze(decode(row.metadata) as Record<string, unknown>),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function invalidCredential(): DbzzError {
  return new DbzzError("unauthenticated", "invalid MCP credential");
}

export function verifyMcpTokenVaultState(connection: Database): void {
  const rows = connection.query(
    "SELECT token_id, identity, mcp, secret_digest, name, metadata, created_at, updated_at FROM _dbz_mcp_tokens",
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
  }
}

/** Engine-owned opaque token storage. Every caller already owns its SQLite transaction. */
export class McpTokenVault {
  constructor(private readonly writer: Database) {}

  create(
    identity: Identity,
    mcp: string,
    input: McpTokenCreateInput,
    limits: McpTokenLimits,
    now: number,
  ): CreatedMcpToken {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw new DbzzError("validation", "MCP token create input must be an object");
    }
    for (const key of Object.keys(input)) {
      if (key !== "name" && key !== "metadata") {
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
    if (!Number.isFinite(now) || now < 0) throw new RangeError("MCP token clock must be finite and non-negative");
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
        (token_id, identity, mcp, secret_digest, name, metadata, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, identity, mcp, digest(secret), name, normalizedMetadata.encoded, now, now);
    return Object.freeze({
      id,
      mcp,
      name,
      metadata: normalizedMetadata.value,
      createdAt: now,
      updatedAt: now,
      token: `${MCP_TOKEN_PREFIX}${id}.${secret}`,
    });
  }

  list(connection: Database, identity: Identity, mcp: string): readonly McpTokenDescriptor[] {
    const rows = connection.query(
      `SELECT token_id, mcp, name, metadata, created_at, updated_at
        FROM _dbz_mcp_tokens
        WHERE identity = ? AND mcp = ?
        ORDER BY created_at, token_id`,
    ).all(identity, mcp) as StoredTokenRow[];
    return Object.freeze(rows.map(descriptor));
  }

  authenticate(
    connection: Database,
    expectedMcp: string,
    rawToken: string,
  ): Readonly<{ identity: Identity; tokenId: string }> {
    const parsed = parseMcpToken(rawToken);
    if (parsed === null) throw invalidCredential();
    const row = connection.query(
      "SELECT identity, mcp, secret_digest FROM _dbz_mcp_tokens WHERE token_id = ?",
    ).get(parsed.id) as Pick<StoredTokenRow, "identity" | "mcp" | "secret_digest"> | null;
    const expected = row?.secret_digest ?? DUMMY_DIGEST;
    const matches = expected.byteLength === 32 && timingSafeEqual(digest(parsed.secret), expected);
    if (!matches || row === null || row.mcp !== expectedMcp) throw invalidCredential();
    return Object.freeze({ identity: row.identity as Identity, tokenId: parsed.id });
  }
}
