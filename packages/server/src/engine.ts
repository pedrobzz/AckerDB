/**
 * The storage engine: bun:sqlite with WAL, one writer connection (all
 * transactions are serialized through the runtime's writer queue) and
 * isolated reader connections (queries and subscription recomputes see
 * committed snapshots only).
 *
 * Physical mapping:
 *   - primary key            INTEGER PRIMARY KEY AUTOINCREMENT (ids never reused)
 *   - string                 TEXT
 *   - number / scheduleAt    REAL
 *   - bigint / identity      INTEGER
 *   - boolean                INTEGER (0/1)
 *   - bytes                  BLOB
 *   - enum                   INTEGER (stable interned tag, see _dbz_tags)
 *   - union                  INTEGER tag column + TEXT payload column "<col>__p"
 *   - array / object / jsonb TEXT (wire-encoded, so bigints/bytes round-trip)
 *
 * Enum/union tags are interned once per (type name, variant name) in
 * `_dbz_tags` and never change and are never reused: reordering variants is
 * cosmetic, renames keep storage, deletions retire the tag forever.
 *
 * Direct indexes execute as SQLite b-tree indexes: same API and semantics;
 * the array-backed layout is a later optimization if benchmarks demand it
 * (the same "only if it wins" rule the wiki applies to sized numerics).
 */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Database, type Statement } from "bun:sqlite";
import { decode, encode, type DurabilityPolicy } from "@dbzz/core";
import type { Descriptor, Identity, Validator } from "./dbz.ts";
import {
  MutationReplayLedger,
  mutationReplayOwner,
  scanMutationReplay,
  type MutationReplaySnapshot,
} from "./mutation-replay.ts";
import {
  MCP_TOKEN_INTERNAL_OBJECTS,
  McpTokenVault,
  mcpTokenVaultOwner,
  verifyMcpTokenVaultState,
} from "./mcp-token-vault.ts";
import { CorruptDatabaseError, IncompatibleDatabaseError } from "./errors.ts";
import type { IndexDef, Schema, TableDef } from "./schema.ts";
import { snapshotOf, type SchemaSnapshot } from "./snapshot.ts";

export { CorruptDatabaseError, IncompatibleDatabaseError } from "./errors.ts";
export interface TagMap {
  toTag: Map<string, number>;
  toName: Map<number, string>;
}

interface PhysCol {
  name: string;
  ddl: string;
}

export interface ColumnPlan {
  jsName: string;
  /** Unwrapped kind ("nullable" removed). */
  kind: string;
  nullable: boolean;
  /** For enum/union: the declared type name (tag map key). */
  typeName?: string;
  phys: PhysCol[];
  toSql(value: unknown): unknown[];
  fromSql(values: unknown[]): unknown;
}

export interface TablePlan {
  name: string;
  pk: string;
  scheduleAt: string | null;
  columns: Map<string, ColumnPlan>;
  /** Physical column names in DDL order (pk first). */
  physOrder: string[];
  indexes: IndexDef[];
}

export interface EngineOptions {
  /** `production` is FULL sync; `balanced` is NORMAL and may lose recent commits on power loss. */
  durability?: DurabilityPolicy;
  busyTimeoutMs?: number;
  integrityCheck?: "quick" | "full";
}

export type EngineCloseDisposition = "clean" | "unclean";

export interface IntegrityReport {
  ok: boolean;
  check: "quick" | "full";
  errors: string[];
}

export interface CheckpointReport {
  readonly mode: "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE";
  readonly busy: number;
  readonly totalFrames: number;
  readonly checkpointedFrames: number;
  readonly residualFrames: number;
  readonly oldestReader: null;
  readonly durationMs: number;
}

export interface EngineStatus {
  engineSchemaVersion: number;
  sqliteVersion: string;
  durability: DurabilityPolicy;
  synchronous: "FULL" | "NORMAL";
  commitVersion: bigint;
  recoveredFromCrash: boolean;
  databaseBytes: number;
  walBytes: number;
  lastCheckpointAtMs: number | null;
  lastCheckpoint: CheckpointReport | null;
  mutationRecords: number;
  mutationResultBytes: number;
}

export interface BackupManifest {
  format: 1;
  sha256: string;
  bytes: number;
  schemaFingerprint: string;
  commitVersion: bigint;
  durability: DurabilityPolicy;
  verifiedAt: number;
}

const ENGINE_SCHEMA_VERSION = 7;
const LOCK_SUFFIX = ".dbzz.lock";
const SQLITE_HEADER = Buffer.from("SQLite format 3\0");
const WAL_HEADER_BYTES = 32;
const WAL_FORMAT_VERSION = 3_007_000;
const WAL_MAGIC_LITTLE_ENDIAN = 0x377f0682;
const WAL_MAGIC_BIG_ENDIAN = 0x377f0683;
const SQLITE_SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;

const quote = (name: string) => `"${name}"`;

interface StoredObject {
  type: "table" | "index";
  name: string;
  table: string;
  sql: string;
}

const INTERNAL_OBJECTS: StoredObject[] = [
  {
    type: "table",
    name: "_dbz_meta",
    table: "_dbz_meta",
    sql: "CREATE TABLE _dbz_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  },
  {
    type: "table",
    name: "_dbz_tags",
    table: "_dbz_tags",
    sql: "CREATE TABLE _dbz_tags (type TEXT NOT NULL, variant TEXT NOT NULL, tag INTEGER NOT NULL, PRIMARY KEY (type, variant))",
  },
  {
    type: "table",
    name: "_dbz_state",
    table: "_dbz_state",
    sql: `CREATE TABLE _dbz_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      commit_version INTEGER NOT NULL CHECK (commit_version >= 0),
      clean_shutdown INTEGER NOT NULL CHECK (clean_shutdown IN (0, 1)),
      mutation_records INTEGER NOT NULL CHECK (mutation_records >= 0),
      mutation_result_bytes INTEGER NOT NULL CHECK (mutation_result_bytes >= 0),
      last_checkpoint_at REAL
    )`,
  },
  {
    type: "table",
    name: "_dbz_mutations",
    table: "_dbz_mutations",
    sql: `CREATE TABLE _dbz_mutations (
      commit_version INTEGER PRIMARY KEY CHECK (commit_version > 0),
      session_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      issued_at REAL NOT NULL,
      principal_fingerprint TEXT NOT NULL,
      function_ref TEXT NOT NULL,
      args_fingerprint TEXT NOT NULL,
      result_disposition TEXT NOT NULL CHECK (result_disposition IN ('replayable', 'one-time')),
      result TEXT,
      result_bytes INTEGER NOT NULL CHECK (result_bytes >= 0),
      durability TEXT NOT NULL CHECK (durability IN ('production', 'balanced')),
      completed_at REAL NOT NULL,
      CHECK (
        (result_disposition = 'replayable' AND result IS NOT NULL) OR
        (result_disposition = 'one-time' AND result IS NULL AND result_bytes = 0)
      )
    )`,
  },
  {
    type: "table",
    name: "_dbz_identities",
    table: "_dbz_identities",
    sql: "CREATE TABLE _dbz_identities (identity INTEGER PRIMARY KEY AUTOINCREMENT)",
  },
  {
    type: "table",
    name: "_dbz_identity_accounts",
    table: "_dbz_identity_accounts",
    sql: `CREATE TABLE _dbz_identity_accounts (
      issuer TEXT NOT NULL CHECK (length(issuer) > 0),
      subject TEXT NOT NULL CHECK (length(subject) > 0),
      identity INTEGER NOT NULL REFERENCES _dbz_identities(identity) ON UPDATE RESTRICT ON DELETE RESTRICT,
      PRIMARY KEY (issuer, subject)
    )`,
  },
  {
    type: "index",
    name: "ix__dbz_identity_accounts_identity",
    table: "_dbz_identity_accounts",
    sql: "CREATE INDEX ix__dbz_identity_accounts_identity ON _dbz_identity_accounts (identity)",
  },
  ...MCP_TOKEN_INTERNAL_OBJECTS,
];

const INTERNAL_OBJECT_NAMES = new Set(INTERNAL_OBJECTS.map((object) => object.name));
const STORED_NAME = /^[a-zA-Z][a-zA-Z0-9_]*$/;

function canonicalSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function storedRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function corruptSnapshot(message: string): never {
  throw new CorruptDatabaseError(`stored schema snapshot is invalid: ${message}`);
}

function storedName(value: unknown, path: string): string {
  if (typeof value !== "string" || !STORED_NAME.test(value) || value.includes("__")) {
    corruptSnapshot(`${path} is not a valid identifier`);
  }
  return value;
}

function physicalColumnDdl(name: string, descriptor: Descriptor, path: string): string[] {
  if (!storedRecord(descriptor) || typeof descriptor["k"] !== "string") {
    corruptSnapshot(`${path} is not a validator descriptor`);
  }
  const nullable = descriptor["k"] === "nullable";
  const base = (nullable ? descriptor["inner"] : descriptor) as Descriptor;
  if (!storedRecord(base) || typeof base["k"] !== "string") {
    corruptSnapshot(`${path} has an invalid nullable descriptor`);
  }
  const notNull = nullable ? "" : " NOT NULL";
  if (base["k"] === "pk") return [`${quote(name)} INTEGER PRIMARY KEY AUTOINCREMENT`];
  if (base["k"] === "union") {
    return [`${quote(name)} INTEGER${notNull}`, `${quote(`${name}__p`)} TEXT${notNull}`];
  }
  const type = (() => {
    switch (base["k"]) {
      case "string":
      case "array":
      case "object":
      case "jsonb":
        return "TEXT";
      case "number":
      case "scheduleAt":
        return "REAL";
      case "bigint":
      case "identity":
      case "boolean":
      case "enum":
        return "INTEGER";
      case "bytes":
        return "BLOB";
      default:
        corruptSnapshot(`${path} cannot be stored as a table column`);
    }
  })();
  return [`${quote(name)} ${type}${notNull}`];
}

function parseStoredSnapshot(value: string): SchemaSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    corruptSnapshot("JSON cannot be parsed");
  }
  if (!storedRecord(parsed) || parsed["version"] !== 1 || !storedRecord(parsed["tables"])) {
    corruptSnapshot("root must contain version 1 and a tables object");
  }
  for (const [tableName, value] of Object.entries(parsed["tables"])) {
    storedName(tableName, "table name");
    if (!storedRecord(value) || (value["kind"] !== "table" && value["kind"] !== "event")) {
      corruptSnapshot(`${tableName} has an invalid table kind`);
    }
    if (!storedRecord(value["columns"]) || !Array.isArray(value["indexes"])) {
      corruptSnapshot(`${tableName} must contain columns and indexes`);
    }
    const storedColumns = value["columns"];
    let primaryKeys = 0;
    let scheduleColumns = 0;
    for (const [column, descriptor] of Object.entries(storedColumns)) {
      storedName(column, `${tableName} column`);
      if (!storedRecord(descriptor)) corruptSnapshot(`${tableName}.${column} is invalid`);
      if (descriptor["k"] === "pk") primaryKeys++;
      if (descriptor["k"] === "scheduleAt") scheduleColumns++;
      physicalColumnDdl(column, descriptor as Descriptor, `${tableName}.${column}`);
    }
    if (primaryKeys !== 1) corruptSnapshot(`${tableName} has ${primaryKeys} primary keys`);
    if (scheduleColumns > 1 || (value["kind"] === "event" && scheduleColumns > 0)) {
      corruptSnapshot(`${tableName} has invalid scheduling columns`);
    }
    const indexNames = new Set<string>();
    for (const index of value["indexes"]) {
      if (!storedRecord(index)) corruptSnapshot(`${tableName} has an invalid index`);
      const name = storedName(index["name"], `${tableName} index name`);
      if (indexNames.has(name)) corruptSnapshot(`${tableName} has duplicate index ${name}`);
      indexNames.add(name);
      if (
        !Array.isArray(index["columns"]) ||
        index["columns"].length === 0 ||
        index["columns"].some((column) => typeof column !== "string" || !(column in storedColumns)) ||
        new Set(index["columns"]).size !== index["columns"].length ||
        typeof index["unique"] !== "boolean" ||
        (index["algorithm"] !== "btree" && index["algorithm"] !== "direct")
      ) {
        corruptSnapshot(`${tableName}.${name} has an invalid definition`);
      }
    }
    if (value["kind"] === "event" && value["indexes"].length > 0) {
      corruptSnapshot(`${tableName} event table has physical indexes`);
    }
  }
  return parsed as unknown as SchemaSnapshot;
}

function expectedApplicationObjects(snapshot: SchemaSnapshot): StoredObject[] {
  const objects: StoredObject[] = [];
  for (const [tableName, table] of Object.entries(snapshot.tables)) {
    if (table.kind === "event") continue;
    const columns = Object.entries(table.columns).flatMap(([column, descriptor]) =>
      physicalColumnDdl(column, descriptor, `${tableName}.${column}`),
    );
    objects.push({
      type: "table",
      name: tableName,
      table: tableName,
      sql: `CREATE TABLE ${quote(tableName)} (${columns.join(", ")})`,
    });
    for (const index of table.indexes) {
      const name = indexSqlName(tableName, index.name);
      objects.push({
        type: "index",
        name,
        table: tableName,
        sql: `CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${quote(name)} ON ${quote(tableName)} (${index.columns.map(quote).join(", ")})`,
      });
    }
    const scheduleAt = Object.entries(table.columns).find(([, descriptor]) => descriptor["k"] === "scheduleAt")?.[0];
    if (scheduleAt !== undefined) {
      const name = `ix__sched_${tableName}`;
      objects.push({
        type: "index",
        name,
        table: tableName,
        sql: `CREATE INDEX ${quote(name)} ON ${quote(tableName)} (${quote(scheduleAt)})`,
      });
    }
  }
  return objects;
}

function unwrapValidator(validator: Validator<unknown, string>): {
  base: Validator<unknown, string>;
  nullable: boolean;
} {
  if (validator.kind === "nullable") {
    return { base: (validator as unknown as { inner: Validator<unknown, string> }).inner, nullable: true };
  }
  return { base: validator, nullable: false };
}

function ddlTypeOf(kind: string): string {
  switch (kind) {
    case "string":
      return "TEXT";
    case "number":
    case "scheduleAt":
      return "REAL";
    case "bigint":
    case "identity":
    case "boolean":
    case "enum":
      return "INTEGER";
    case "bytes":
      return "BLOB";
    case "array":
    case "object":
    case "jsonb":
      return "TEXT";
    default:
      throw new Error(`no DDL type for validator kind "${kind}"`);
  }
}

function positiveInt(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function readExactly(fd: number, buffer: Uint8Array, position: number, artifact: string): void {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const count = readSync(fd, buffer, offset, buffer.byteLength - offset, position + offset);
    if (count === 0) throw new CorruptDatabaseError(`${artifact} changed while it was being validated`);
    offset += count;
  }
}

function existingDatabasePageSize(path: string): number {
  const fd = openSync(path, "r");
  try {
    const status = fstatSync(fd);
    if (!status.isFile()) throw new Error(`database path is not a regular file: ${path}`);
    if (status.size === 0) {
      throw new CorruptDatabaseError("pre-existing database file is empty; refusing to initialize it");
    }
    if (status.size < 100) throw new CorruptDatabaseError("database file is truncated before its SQLite header");
    const header = Buffer.allocUnsafe(100);
    readExactly(fd, header, 0, "database file");
    if (!header.subarray(0, SQLITE_HEADER.byteLength).equals(SQLITE_HEADER)) {
      throw new CorruptDatabaseError("database file has an invalid SQLite header");
    }
    const encodedPageSize = header.readUInt16BE(16);
    const pageSize = encodedPageSize === 1 ? 65_536 : encodedPageSize;
    if (pageSize < 512 || pageSize > 65_536 || (pageSize & (pageSize - 1)) !== 0) {
      throw new CorruptDatabaseError("database file has an invalid SQLite page size");
    }
    if (status.size < pageSize || status.size % pageSize !== 0) {
      throw new CorruptDatabaseError("database file is truncated between SQLite pages");
    }
    const changeCounter = header.readUInt32BE(24);
    const headerPages = header.readUInt32BE(28);
    const versionValidFor = header.readUInt32BE(92);
    if (
      headerPages !== 0 &&
      changeCounter === versionValidFor &&
      headerPages * pageSize !== status.size
    ) {
      throw new CorruptDatabaseError("database file size does not match its SQLite header");
    }
    return pageSize;
  } finally {
    closeSync(fd);
  }
}

function walChecksum(
  bytes: Uint8Array,
  littleEndian: boolean,
  initial: readonly [number, number],
): [number, number] {
  const words = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let [first, second] = initial;
  for (let offset = 0; offset < bytes.byteLength; offset += 8) {
    first = (first + words.getUint32(offset, littleEndian) + second) >>> 0;
    second = (second + words.getUint32(offset + 4, littleEndian) + first) >>> 0;
  }
  return [first, second];
}

/**
 * Reject only a valid WAL header that is provably incompatible with the main
 * file. SQLite owns valid-prefix recovery on the disposable copy below: frame
 * tails, salt changes, and checksum failures can all be normal crash residue.
 * A removed whole valid suffix is likewise unknowable without a separately
 * durable expected-end watermark.
 */
function existingWalPageSize(path: string): number | null {
  const walPath = `${path}-wal`;
  if (!existsSync(walPath)) return null;
  const fd = openSync(walPath, "r");
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return null;
    // A crash may leave an incomplete first header. SQLite treats that as no
    // valid WAL rather than as evidence that a committed frame existed.
    if (size < WAL_HEADER_BYTES) return null;
    const header = Buffer.allocUnsafe(WAL_HEADER_BYTES);
    readExactly(fd, header, 0, "database WAL");
    const magic = header.readUInt32BE(0);
    if (magic !== WAL_MAGIC_LITTLE_ENDIAN && magic !== WAL_MAGIC_BIG_ENDIAN) {
      return null;
    }
    const littleEndian = magic === WAL_MAGIC_LITTLE_ENDIAN;
    const checksum = walChecksum(header.subarray(0, 24), littleEndian, [0, 0]);
    if (checksum[0] !== header.readUInt32BE(24) || checksum[1] !== header.readUInt32BE(28)) {
      return null;
    }
    if (header.readUInt32BE(4) !== WAL_FORMAT_VERSION) {
      throw new CorruptDatabaseError("database WAL uses an unsupported format");
    }
    const pageSize = header.readUInt32BE(8);
    if (pageSize < 512 || pageSize > 65_536 || (pageSize & (pageSize - 1)) !== 0) {
      throw new CorruptDatabaseError("database WAL has an invalid page size");
    }
    return pageSize;
  } finally {
    closeSync(fd);
  }
}

function initializeInternalObjects(connection: Database): void {
  connection.exec("BEGIN IMMEDIATE");
  try {
    connection.exec(INTERNAL_OBJECTS.map((object) => object.sql).join(";"));
    connection
      .query("INSERT INTO _dbz_meta (key, value) VALUES ('engine_schema', ?)")
      .run(String(ENGINE_SCHEMA_VERSION));
    connection
      .query("INSERT INTO _dbz_state (singleton, commit_version, clean_shutdown, mutation_records, mutation_result_bytes, last_checkpoint_at) VALUES (1, 0, 1, 0, 0, NULL)")
      .run();
    connection.exec("COMMIT");
  } catch (error) {
    connection.exec("ROLLBACK");
    throw error;
  }
}

function removeStaleInitializationArtifacts(path: string): void {
  const directory = dirname(path);
  const prefix = `${basename(path)}.dbzz-init-`;
  const stagingName = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:-(?:wal|shm|journal))?$/;
  const stale = readdirSync(directory, { withFileTypes: true }).filter(
    (entry) =>
      !entry.isDirectory() &&
      entry.name.startsWith(prefix) &&
      stagingName.test(entry.name.slice(prefix.length)),
  );
  if (stale.length === 0) return;
  for (const entry of stale) rmSync(join(directory, entry.name), { force: true });
  fsyncPath(directory);
}

function publishMissingDatabase(path: string): boolean {
  if (!existsSync(path) && SQLITE_SIDECAR_SUFFIXES.some((suffix) => existsSync(`${path}${suffix}`))) {
    throw new CorruptDatabaseError("database main file is missing while SQLite sidecars exist");
  }
  if (existsSync(path)) return false;
  const directory = dirname(path);
  const stagingPath = `${path}.dbzz-init-${randomUUID()}`;
  let staged = false;
  try {
    const fd = openSync(stagingPath, "wx", 0o600);
    closeSync(fd);
    staged = true;
    const database = new Database(stagingPath, { create: true, safeIntegers: true });
    try {
      initializeInternalObjects(database);
    } finally {
      database.close(false);
    }
    fsyncPath(stagingPath);
    if (SQLITE_SIDECAR_SUFFIXES.some((suffix) => existsSync(`${path}${suffix}`))) {
      throw new CorruptDatabaseError("database main file is missing while SQLite sidecars exist");
    }
    try {
      linkSync(stagingPath, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    fsyncPath(directory);
    return true;
  } finally {
    if (staged) {
      rmSync(stagingPath, { force: true });
      for (const suffix of SQLITE_SIDECAR_SUFFIXES) rmSync(`${stagingPath}${suffix}`, { force: true });
      fsyncPath(directory);
    }
  }
}

function normalizeStorageError(error: unknown): unknown {
  if (error instanceof CorruptDatabaseError || error instanceof IncompatibleDatabaseError) return error;
  const code = storedRecord(error) && typeof error["code"] === "string" ? error["code"] : null;
  if (
    code === "SQLITE_NOTADB" ||
    code === "SQLITE_FORMAT" ||
    code === "SQLITE_CORRUPT" ||
    code?.startsWith("SQLITE_CORRUPT_") === true
  ) {
    return new CorruptDatabaseError(`database storage is corrupt (${code})`, { cause: error });
  }
  return error;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function acquireProcessLock(path: string): string | null {
  if (path === ":memory:") return null;
  const lockPath = `${path}${LOCK_SUFFIX}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(lockPath);
      writeFileSync(`${lockPath}/owner.json`, JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }));
      return lockPath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner: { pid?: unknown } = {};
      try {
        owner = JSON.parse(readFileSync(`${lockPath}/owner.json`, "utf8")) as { pid?: unknown };
      } catch {
        const age = Date.now() - statSync(lockPath).mtimeMs;
        if (age < 5_000) throw new Error(`database is already opening in another process: ${path}`);
      }
      if (typeof owner.pid === "number" && processIsAlive(owner.pid)) {
        throw new Error(`database is already open by process ${owner.pid}: ${path}`);
      }
      rmSync(lockPath, { recursive: true, force: true });
    }
  }
  throw new Error(`could not acquire database process lock: ${path}`);
}

function fsyncPath(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function checkRows(db: Database, pragma: "quick_check" | "integrity_check"): string[] {
  const rows = db.query(`PRAGMA ${pragma}`).all() as Record<string, unknown>[];
  return rows.map((row) => String(Object.values(row)[0]));
}

function inspectArtifact(path: string): Pick<BackupManifest, "format" | "schemaFingerprint" | "commitVersion"> {
  const db = new Database(path, { readonly: true, safeIntegers: true });
  try {
    const checks = checkRows(db, "quick_check").filter((value) => value !== "ok");
    const foreignKeys = db.query("PRAGMA foreign_key_check").all() as Record<string, unknown>[];
    if (foreignKeys.length > 0) checks.push(`${foreignKeys.length} foreign-key violation(s)`);
    if (checks.length > 0) throw new CorruptDatabaseError(checks.join("; "));
    const version = db
      .query("SELECT value FROM _dbz_meta WHERE key = 'engine_schema'")
      .get() as { value: string } | null;
    if (version?.value !== String(ENGINE_SCHEMA_VERSION)) {
      throw new IncompatibleDatabaseError("artifact has an incompatible DBZZ engine schema");
    }
    const mutationReplay = scanMutationReplay(db);
    const snapshot = db
      .query("SELECT value FROM _dbz_meta WHERE key = 'schema'")
      .get() as { value: string } | null;
    if (snapshot === null) throw new CorruptDatabaseError("artifact is missing its schema snapshot");
    return {
      format: 1,
      schemaFingerprint: createHash("sha256").update(snapshot.value).digest("hex"),
      commitVersion: mutationReplay.commitVersion,
    };
  } finally {
    db.close();
  }
}

export class Engine {
  readonly schema: Schema;
  readonly writer: Database;
  readonly reader: Database;
  readonly [mutationReplayOwner]: MutationReplayLedger;
  readonly [mcpTokenVaultOwner]: McpTokenVault;
  readonly path: string;
  readonly durability: DurabilityPolicy;
  readonly recoveredFromCrash: boolean;
  readonly tags = new Map<string, TagMap>();
  readonly plans = new Map<string, TablePlan>();
  private readonly processLock: string | null;
  private readonly sqlitePath: string;
  private readonly busyTimeoutMs: number;
  private readonly additionalReaders = new Set<Database>();
  private lastCheckpoint: CheckpointReport | null = null;
  private closed = false;

  constructor(schema: Schema, path: string, options: EngineOptions = {}) {
    this.schema = schema;
    this.path = path;
    this.durability = options.durability ?? "production";
    const busyTimeoutMs = positiveInt(options.busyTimeoutMs ?? 5_000, "busyTimeoutMs");
    this.busyTimeoutMs = busyTimeoutMs;
    this.processLock = acquireProcessLock(path);
    const sqlitePath = path === ":memory:"
      ? `file:dbzz-${randomUUID()}?mode=memory&cache=shared`
      : path;
    this.sqlitePath = sqlitePath;
    let writer: Database | null = null;
    let reader: Database | null = null;
    let mutationReplay: MutationReplaySnapshot | null = null;
    try {
      if (path !== ":memory:") removeStaleInitializationArtifacts(path);
      const bootstrap = path === ":memory:" || publishMissingDatabase(path);
      if (path !== ":memory:" && !bootstrap) {
        mutationReplay = this.validateExistingStorage(
          path,
          busyTimeoutMs,
          options.integrityCheck ?? "quick",
        );
      }
      writer = new Database(sqlitePath, { create: path === ":memory:", safeIntegers: true });
      writer.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
      writer.exec("PRAGMA foreign_keys = ON");
      this.writer = writer;
      if (bootstrap) {
        mutationReplay = this.validateStorage(writer, options.integrityCheck ?? "quick", true);
      }
      if (mutationReplay === null) throw new Error("mutation replay ledger was not loaded");
      this[mutationReplayOwner] = new MutationReplayLedger(writer, mutationReplay);
      this[mcpTokenVaultOwner] = new McpTokenVault(writer);
      this.internTags();
      this.buildPlans();
      writer.exec("PRAGMA journal_mode = WAL");
      writer.exec(`PRAGMA synchronous = ${this.durability === "production" ? "FULL" : "NORMAL"}`);
      if (path === ":memory:") {
        reader = new Database(sqlitePath, { create: true, safeIntegers: true });
        reader.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
        reader.exec("PRAGMA foreign_keys = ON");
      } else {
        reader = new Database(path, { readonly: true, safeIntegers: true });
        reader.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
        reader.exec("PRAGMA foreign_keys = ON");
      }
      this.reader = reader;
      const state = this.writer
        .query("SELECT clean_shutdown FROM _dbz_state WHERE singleton = 1")
        .get() as { clean_shutdown: bigint };
      this.recoveredFromCrash = state.clean_shutdown === 0n;
      this.writer.query("UPDATE _dbz_state SET clean_shutdown = 0 WHERE singleton = 1").run();
    } catch (error) {
      const failure = normalizeStorageError(error);
      if (reader !== null && reader !== writer) reader.close(false);
      writer?.close(false);
      if (this.processLock !== null) rmSync(this.processLock, { recursive: true, force: true });
      throw failure;
    }
  }

  /** Open another isolated snapshot reader owned by this engine. */
  createReader(): Database {
    if (this.closed) throw new Error("engine is closed");
    const reader = this.path === ":memory:"
      ? new Database(this.sqlitePath, { create: true, safeIntegers: true })
      : new Database(this.sqlitePath, { readonly: true, safeIntegers: true });
    try {
      reader.exec(`PRAGMA busy_timeout = ${this.busyTimeoutMs}`);
      reader.exec("PRAGMA foreign_keys = ON");
      this.additionalReaders.add(reader);
      return reader;
    } catch (error) {
      reader.close(false);
      throw error;
    }
  }

  private validateExistingStorage(
    path: string,
    busyTimeoutMs: number,
    integrityCheck: "quick" | "full",
  ): MutationReplaySnapshot {
    const walPageSize = existingWalPageSize(path);
    const needsRecoveryCopy = ["-wal", "-journal"].some((suffix) => {
      const sidecar = `${path}${suffix}`;
      return existsSync(sidecar) && statSync(sidecar).size > 0;
    });
    const directory = needsRecoveryCopy
      ? mkdtempSync(join(tmpdir(), "dbzz-storage-validation-"))
      : null;
    const validationPath = directory === null ? path : join(directory, "data.db");
    const recoveryFreePageSize = directory === null ? existingDatabasePageSize(path) : null;
    let database: Database | null = null;
    try {
      if (directory !== null) {
        copyFileSync(path, validationPath);
        for (const suffix of ["-wal", "-journal"] as const) {
          if (existsSync(`${path}${suffix}`)) {
            copyFileSync(`${path}${suffix}`, `${validationPath}${suffix}`);
          }
        }
      }
      database = new Database(validationPath, {
        readonly: directory === null,
        safeIntegers: true,
      });
      database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
      database.exec("PRAGMA foreign_keys = ON");
      const mutationReplay = this.validateStorage(database, integrityCheck, false);
      const databasePageSize = recoveryFreePageSize ?? existingDatabasePageSize(validationPath);
      if (walPageSize !== null && walPageSize !== databasePageSize) {
        throw new CorruptDatabaseError("database WAL page size does not match its main file");
      }
      return mutationReplay;
    } finally {
      database?.close(false);
      if (directory !== null) rmSync(directory, { recursive: true, force: true });
    }
  }

  private validateStorage(
    connection: Database,
    integrityCheck: "quick" | "full",
    bootstrap: boolean,
  ): MutationReplaySnapshot {
    this.initializeInternalSchema(bootstrap, connection);
    const integrity = this.integrity(integrityCheck, connection);
    if (!integrity.ok) throw new CorruptDatabaseError(integrity.errors.join("; "));
    this.verifyInternalState(connection);
    const mutationReplay = scanMutationReplay(connection);
    this.loadSnapshot(connection);
    return mutationReplay;
  }

  private initializeInternalSchema(bootstrap: boolean, connection: Database = this.writer): void {
    const objects = connection
      .query("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
      .all() as { type: string; name: string; tbl_name: string; sql: string | null }[];
    const meta = objects.find((object) => object.type === "table" && object.name === "_dbz_meta");
    if (meta === undefined) {
      if (!bootstrap || objects.length > 0) {
        throw new CorruptDatabaseError("pre-existing database has no DBZZ metadata; refusing to initialize it");
      }
      initializeInternalObjects(connection);
      return;
    }

    const expectedMeta = INTERNAL_OBJECTS[0]!;
    if (canonicalSql(meta.sql ?? "") !== canonicalSql(expectedMeta.sql)) {
      throw new IncompatibleDatabaseError("database internal table _dbz_meta has an incompatible shape");
    }

    const version = connection
      .query("SELECT value FROM _dbz_meta WHERE key = 'engine_schema'")
      .get() as { value: string } | null;
    if (version === null || version.value !== String(ENGINE_SCHEMA_VERSION)) {
      throw new IncompatibleDatabaseError(
        `database engine schema is ${version?.value ?? "legacy"}; expected ${ENGINE_SCHEMA_VERSION}`,
      );
    }
    const actualByName = new Map(objects.map((object) => [object.name, object]));
    for (const expected of INTERNAL_OBJECTS) {
      const actual = actualByName.get(expected.name);
      if (
        actual === undefined ||
        actual.type !== expected.type ||
        actual.tbl_name !== expected.table ||
        canonicalSql(actual.sql ?? "") !== canonicalSql(expected.sql)
      ) {
        throw new IncompatibleDatabaseError(
          `database internal ${expected.type} ${expected.name} has an incompatible shape`,
        );
      }
    }
    const unknown = objects.find(
      (object) =>
        (object.name.startsWith("_dbz_") || object.name.startsWith("ix__dbz_")) &&
        !INTERNAL_OBJECT_NAMES.has(object.name),
    );
    if (unknown !== undefined) {
      throw new IncompatibleDatabaseError(`database has unknown internal object ${unknown.name}`);
    }
  }

  integrity(check: "quick" | "full" = "quick", connection: Database = this.writer): IntegrityReport {
    const pragma = check === "quick" ? "quick_check" : "integrity_check";
    const results = checkRows(connection, pragma);
    const errors = results.filter((value) => value !== "ok");
    const foreignKeys = connection.query("PRAGMA foreign_key_check").all() as Record<string, unknown>[];
    for (const row of foreignKeys) errors.push(`foreign key violation: ${JSON.stringify(row)}`);
    return { ok: errors.length === 0, check, errors };
  }

  private verifyInternalState(connection: Database = this.writer): void {
    const unknownMeta = connection
      .query("SELECT key FROM _dbz_meta WHERE key NOT IN ('engine_schema', 'schema') LIMIT 1")
      .get() as { key: string } | null;
    if (unknownMeta !== null) throw new CorruptDatabaseError(`unknown DBZZ metadata key ${unknownMeta.key}`);
    const stateRows = connection
      .query("SELECT COUNT(*) AS count FROM _dbz_state")
      .get() as { count: bigint };
    if (stateRows.count !== 1n) throw new CorruptDatabaseError("DBZZ state must contain exactly one singleton row");
    const invalidTag = connection
      .query(
        "SELECT 1 FROM _dbz_tags WHERE typeof(type) <> 'text' OR length(type) = 0 OR typeof(variant) <> 'text' OR length(variant) = 0 OR typeof(tag) <> 'integer' OR tag < 0 LIMIT 1",
      )
      .get();
    const invalidTagGroup = connection
      .query(
        "SELECT 1 FROM _dbz_tags GROUP BY type HAVING MIN(tag) <> 0 OR MAX(tag) + 1 <> COUNT(*) OR COUNT(DISTINCT tag) <> COUNT(*) LIMIT 1",
      )
      .get();
    if (invalidTag !== null || invalidTagGroup !== null) {
      throw new CorruptDatabaseError("DBZZ tag assignments are invalid");
    }
    const invalidIdentity = connection
      .query(
        "SELECT 1 FROM _dbz_identities WHERE typeof(identity) <> 'integer' OR identity <= 0 LIMIT 1",
      )
      .get();
    const invalidAccount = connection
      .query(
        "SELECT 1 FROM _dbz_identity_accounts WHERE typeof(issuer) <> 'text' OR length(issuer) = 0 OR typeof(subject) <> 'text' OR length(subject) = 0 OR typeof(identity) <> 'integer' OR identity <= 0 LIMIT 1",
      )
      .get();
    if (invalidIdentity !== null || invalidAccount !== null) {
      throw new CorruptDatabaseError("DBZZ identity directory is invalid");
    }
    verifyMcpTokenVaultState(connection);
  }

  commitVersion(connection: Database = this.writer): bigint {
    const row = connection
      .query("SELECT commit_version FROM _dbz_state WHERE singleton = 1")
      .get() as { commit_version: bigint };
    return row.commit_version;
  }

  /** Allocate the next non-replay version. The caller must own an open writer transaction. */
  allocateCommitVersion(): bigint {
    const row = this.writer
      .query("UPDATE _dbz_state SET commit_version = commit_version + 1 WHERE singleton = 1 RETURNING commit_version")
      .get() as { commit_version: bigint };
    return row.commit_version;
  }

  /** Look up one exact external account on any Engine-owned connection. */
  identityForAccount(connection: Database, issuer: string, subject: string): Identity | null {
    const account = connection
      .query("SELECT identity FROM _dbz_identity_accounts WHERE issuer = ? AND subject = ?")
      .get(issuer, subject) as { identity: bigint } | null;
    return account === null ? null : account.identity as Identity;
  }

  /** Resolve or provision one exact account. The caller must own the writer transaction. */
  resolveIdentity(issuer: string, subject: string): Identity {
    const existing = this.identityForAccount(this.writer, issuer, subject);
    if (existing !== null) return existing;

    const created = this.writer
      .query("INSERT INTO _dbz_identities DEFAULT VALUES RETURNING identity")
      .get() as { identity: bigint };
    this.writer
      .query("INSERT INTO _dbz_identity_accounts (issuer, subject, identity) VALUES (?, ?, ?)")
      .run(issuer, subject, created.identity);
    return created.identity as Identity;
  }

  /** Attach one exact account inside the caller-owned writer transaction. */
  attachIdentityAccount(identity: Identity, issuer: string, subject: string): boolean {
    const existing = this.identityForAccount(this.writer, issuer, subject);
    if (existing !== null) return existing === identity;
    this.writer
      .query("INSERT INTO _dbz_identity_accounts (issuer, subject, identity) VALUES (?, ?, ?)")
      .run(issuer, subject, identity);
    return true;
  }

  /** Detach one owned account inside the caller-owned writer transaction. */
  detachIdentityAccount(
    identity: Identity,
    issuer: string,
    subject: string,
  ): "removed" | "not_owned" | "last_account" {
    if (this.identityForAccount(this.writer, issuer, subject) !== identity) return "not_owned";
    const removed = this.writer
      .query(`DELETE FROM _dbz_identity_accounts
        WHERE issuer = ? AND subject = ? AND identity = ?
          AND 1 < (SELECT COUNT(*) FROM _dbz_identity_accounts WHERE identity = ?)`)
      .run(issuer, subject, identity, identity);
    return removed.changes === 1 ? "removed" : "last_account";
  }

  schemaFingerprint(): string {
    return createHash("sha256").update(JSON.stringify(snapshotOf(this.schema))).digest("hex");
  }

  /** Assign stable tags to every named enum/union variant. */
  private internTags(): void {
    const select = this.writer.query("SELECT variant, tag FROM _dbz_tags WHERE type = ?");
    for (const [typeName, validator] of this.schema.namedTypes) {
      const variants =
        validator.kind === "enum"
          ? [...(validator as unknown as { values: readonly string[] }).values]
          : Object.keys((validator as unknown as { members: Record<string, unknown> }).members);
      const map: TagMap = { toTag: new Map(), toName: new Map() };
      let max = -1;
      for (const row of select.all(typeName) as { variant: string; tag: bigint }[]) {
        const tag = Number(row.tag);
        map.toTag.set(row.variant, tag);
        map.toName.set(tag, row.variant);
        if (tag > max) max = tag;
      }
      for (const variant of variants) {
        if (!map.toTag.has(variant)) {
          const tag = ++max;
          map.toTag.set(variant, tag);
          map.toName.set(tag, variant);
        }
      }
      this.tags.set(typeName, map);
    }
  }

  /** Persist the in-memory tag plan. The caller owns the schema transaction. */
  persistTags(): void {
    const insert = this.writer.query(
      "INSERT INTO _dbz_tags (type, variant, tag) VALUES (?, ?, ?) ON CONFLICT(type, variant) DO NOTHING",
    );
    for (const [type, map] of this.tags) {
      for (const [variant, tag] of map.toTag) insert.run(type, variant, tag);
    }
  }

  private buildPlans(): void {
    for (const [tableName, table] of Object.entries(this.schema.tables)) {
      if (table.kind === "event") continue;
      this.plans.set(tableName, this.planTable(tableName, table));
    }
  }

  private planTable(tableName: string, table: TableDef): TablePlan {
    const columns = new Map<string, ColumnPlan>();
    const physOrder: string[] = [];
    for (const [jsName, validator] of Object.entries(table.columns)) {
      const plan = this.planColumn(jsName, validator);
      columns.set(jsName, plan);
      for (const phys of plan.phys) physOrder.push(phys.name);
    }
    return {
      name: tableName,
      pk: table.primaryKey,
      scheduleAt: table.scheduleAtColumn,
      columns,
      physOrder,
      indexes: table.indexes,
    };
  }

  private planColumn(jsName: string, validator: Validator<unknown, string>): ColumnPlan {
    const { base, nullable } = unwrapValidator(validator);
    const notNull = nullable ? "" : " NOT NULL";

    if (base.kind === "pk") {
      return {
        jsName,
        kind: "pk",
        nullable: false,
        phys: [{ name: jsName, ddl: `${quote(jsName)} INTEGER PRIMARY KEY AUTOINCREMENT` }],
        toSql: (value) => [value],
        fromSql: (values) => values[0],
      };
    }

    if (base.kind === "union") {
      const typeName = (base as unknown as { name: string }).name;
      const payloadCol = `${jsName}__p`;
      const tagMap = () => this.tags.get(typeName)!;
      return {
        jsName,
        kind: "union",
        nullable,
        typeName,
        phys: [
          { name: jsName, ddl: `${quote(jsName)} INTEGER${notNull}` },
          { name: payloadCol, ddl: `${quote(payloadCol)} TEXT${notNull}` },
        ],
        toSql: (value) => {
          if (value === null) return [null, null];
          const { tag, value: payload } = value as { tag: string; value: unknown };
          const tagInt = tagMap().toTag.get(tag);
          if (tagInt === undefined) throw new Error(`unknown ${typeName} variant "${tag}"`);
          return [tagInt, encode(payload)];
        },
        fromSql: (values) => {
          if (values[0] === null) return null;
          return {
            tag: tagMap().toName.get(Number(values[0]))!,
            value: decode(values[1] as string),
          };
        },
      };
    }

    if (base.kind === "enum") {
      const typeName = (base as unknown as { name: string }).name;
      const tagMap = () => this.tags.get(typeName)!;
      return {
        jsName,
        kind: "enum",
        nullable,
        typeName,
        phys: [{ name: jsName, ddl: `${quote(jsName)} INTEGER${notNull}` }],
        toSql: (value) => {
          if (value === null) return [null];
          const tagInt = tagMap().toTag.get(value as string);
          if (tagInt === undefined) throw new Error(`unknown ${typeName} variant "${String(value)}"`);
          return [tagInt];
        },
        fromSql: (values) => (values[0] === null ? null : tagMap().toName.get(Number(values[0]))!),
      };
    }

    const ddl = `${quote(jsName)} ${ddlTypeOf(base.kind)}${notNull}`;
    const simple = (toSql: (v: unknown) => unknown, fromSql: (v: unknown) => unknown): ColumnPlan => ({
      jsName,
      kind: base.kind,
      nullable,
      phys: [{ name: jsName, ddl }],
      toSql: (value) => [value === null ? null : toSql(value)],
      fromSql: (values) => (values[0] === null ? null : fromSql(values[0])),
    });

    switch (base.kind) {
      case "string":
        return simple((v) => v, (v) => v);
      case "number":
      case "scheduleAt":
        return simple((v) => v, (v) => Number(v));
      case "bigint":
      case "identity":
        return simple((v) => v, (v) => v);
      case "boolean":
        return simple((v) => (v ? 1 : 0), (v) => v === 1n || v === 1);
      case "bytes":
        return simple((v) => v, (v) => v);
      case "array":
      case "object":
      case "jsonb":
        return simple((v) => encode(v), (v) => decode(v as string));
      default:
        throw new Error(`unsupported column kind "${base.kind}"`);
    }
  }

  // -- DDL -------------------------------------------------------------------

  createTableDdl(plan: TablePlan, nameOverride?: string): string {
    const cols: string[] = [];
    for (const column of plan.columns.values()) {
      for (const phys of column.phys) cols.push(phys.ddl);
    }
    return `CREATE TABLE IF NOT EXISTS ${quote(nameOverride ?? plan.name)} (${cols.join(", ")})`;
  }

  /** Create one table plus its indexes (user + internal scheduler index). */
  createTablePhysical(plan: TablePlan): void {
    this.writer.exec(this.createTableDdl(plan));
    this.createIndexesPhysical(plan);
  }

  createIndexesPhysical(plan: TablePlan): void {
    for (const index of plan.indexes) this.writer.exec(this.indexDdl(plan, index));
    if (plan.scheduleAt !== null) {
      this.writer.exec(
        `CREATE INDEX IF NOT EXISTS ${quote(`ix__sched_${plan.name}`)} ON ${quote(plan.name)} (${quote(plan.scheduleAt)})`,
      );
    }
  }

  indexDdl(plan: TablePlan, index: IndexDef): string {
    const unique = index.unique ? "UNIQUE " : "";
    const cols = index.columns.map((c) => quote(c)).join(", ");
    return `CREATE ${unique}INDEX IF NOT EXISTS ${quote(indexSqlName(plan.name, index.name))} ON ${quote(plan.name)} (${cols})`;
  }

  /** Create all tables and indexes for a fresh database and store the snapshot. */
  createAll(): void {
    this.writer.exec("BEGIN IMMEDIATE");
    try {
      this.persistTags();
      for (const plan of this.plans.values()) this.createTablePhysical(plan);
      this.saveSnapshot(snapshotOf(this.schema));
      this.writer.exec("COMMIT");
    } catch (error) {
      this.writer.exec("ROLLBACK");
      throw error;
    }
  }

  // -- Meta ------------------------------------------------------------------

  loadSnapshot(connection: Database = this.writer): SchemaSnapshot | null {
    const row = connection.query("SELECT value FROM _dbz_meta WHERE key = 'schema'").get() as
      | { value: string }
      | null;
    const snapshot = row === null ? null : parseStoredSnapshot(row.value);
    this.verifyApplicationSchema(snapshot, connection);
    if (snapshot !== null) this.verifySnapshotTags(snapshot, connection);
    return snapshot;
  }

  private verifyApplicationSchema(snapshot: SchemaSnapshot | null, connection: Database): void {
    const actual = connection
      .query("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
      .all() as { type: string; name: string; tbl_name: string; sql: string | null }[];
    const expected = new Map(
      [...INTERNAL_OBJECTS, ...(snapshot === null ? [] : expectedApplicationObjects(snapshot))]
        .map((object) => [object.name, object]),
    );
    const extra = actual.find((object) => !expected.has(object.name));
    if (extra !== undefined) {
      const reason = snapshot === null ? "without a schema snapshot" : "outside the stored schema snapshot";
      throw new CorruptDatabaseError(`database object ${extra.name} exists ${reason}`);
    }
    for (const object of expected.values()) {
      const stored = actual.find((candidate) => candidate.name === object.name);
      if (
        stored === undefined ||
        stored.type !== object.type ||
        stored.tbl_name !== object.table ||
        canonicalSql(stored.sql ?? "") !== canonicalSql(object.sql)
      ) {
        if (INTERNAL_OBJECT_NAMES.has(object.name)) continue;
        throw new CorruptDatabaseError(
          `database ${object.type} ${object.name} does not match the stored schema snapshot`,
        );
      }
    }
  }

  private verifySnapshotTags(snapshot: SchemaSnapshot, connection: Database): void {
    const definitions = new Map<string, { descriptor: string; variants: string[] }>();
    for (const table of Object.values(snapshot.tables)) {
      for (const descriptor of Object.values(table.columns)) {
        const base = (descriptor["k"] === "nullable" ? descriptor["inner"] : descriptor) as Descriptor;
        if (base["k"] !== "enum" && base["k"] !== "union") continue;
        const name = storedName(base["name"], "named type");
        const variants = base["k"] === "enum"
          ? base["values"]
          : storedRecord(base["members"])
            ? Object.keys(base["members"])
            : null;
        if (!Array.isArray(variants) || variants.length === 0 || variants.some((value) => typeof value !== "string")) {
          corruptSnapshot(`${name} has invalid variants`);
        }
        const signature = JSON.stringify(base);
        const previous = definitions.get(name);
        if (previous !== undefined && previous.descriptor !== signature) {
          corruptSnapshot(`named type ${name} has conflicting definitions`);
        }
        definitions.set(name, { descriptor: signature, variants: variants as string[] });
      }
    }
    const stored = new Map<string, Set<string>>();
    for (const row of connection.query("SELECT type, variant FROM _dbz_tags").all() as { type: string; variant: string }[]) {
      const variants = stored.get(row.type) ?? new Set<string>();
      variants.add(row.variant);
      stored.set(row.type, variants);
    }
    for (const [type, definition] of definitions) {
      const missing = definition.variants.find((variant) => !stored.get(type)?.has(variant));
      if (missing !== undefined) {
        throw new CorruptDatabaseError(`DBZZ tag assignment is missing ${type}.${missing}`);
      }
    }
  }

  saveSnapshot(snapshot: SchemaSnapshot): void {
    this.writer
      .query("INSERT INTO _dbz_meta (key, value) VALUES ('schema', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(snapshot));
  }

  // -- Row codec + basic CRUD (ctx.db composes richer queries on top) --------

  plan(table: string): TablePlan {
    const plan = this.plans.get(table);
    if (!plan) throw new Error(`unknown table "${table}"`);
    return plan;
  }

  /** Decode one SQL result object (keyed by physical column name) to a JS row. */
  rowFromSql(plan: TablePlan, sqlRow: Record<string, unknown>): Record<string, unknown> {
    const row: Record<string, unknown> = {};
    for (const column of plan.columns.values()) {
      row[column.jsName] = column.fromSql(column.phys.map((p) => sqlRow[p.name]));
    }
    return row;
  }

  insertSql(plan: TablePlan): { sql: string; bind(row: Record<string, unknown>): unknown[] } {
    const physCols: string[] = [];
    const columns = [...plan.columns.values()].filter((c) => c.kind !== "pk");
    for (const column of columns) for (const phys of column.phys) physCols.push(phys.name);
    const sql = `INSERT INTO ${quote(plan.name)} (${physCols.map(quote).join(", ")}) VALUES (${physCols.map(() => "?").join(", ")}) RETURNING ${quote(plan.pk)}`;
    return {
      sql,
      bind: (row) => columns.flatMap((c) => c.toSql(row[c.jsName])),
    };
  }

  statement(conn: Database, sql: string): Statement {
    return conn.query(sql);
  }

  status(): EngineStatus {
    const state = this.writer
      .query("SELECT commit_version, mutation_records, mutation_result_bytes, last_checkpoint_at FROM _dbz_state WHERE singleton = 1")
      .get() as {
        commit_version: bigint;
        mutation_records: bigint;
        mutation_result_bytes: bigint;
        last_checkpoint_at: number | null;
      };
    const sqlite = this.writer.query("SELECT sqlite_version() AS version").get() as { version: string };
    const fileBytes = (path: string): number =>
      path === ":memory:" || !existsSync(path) ? 0 : statSync(path).size;
    return {
      engineSchemaVersion: ENGINE_SCHEMA_VERSION,
      sqliteVersion: sqlite.version,
      durability: this.durability,
      synchronous: this.durability === "production" ? "FULL" : "NORMAL",
      commitVersion: state.commit_version,
      recoveredFromCrash: this.recoveredFromCrash,
      databaseBytes: fileBytes(this.path),
      walBytes: fileBytes(`${this.path}-wal`),
      lastCheckpointAtMs: state.last_checkpoint_at,
      lastCheckpoint: this.lastCheckpoint,
      mutationRecords: Number(state.mutation_records),
      mutationResultBytes: Number(state.mutation_result_bytes),
    };
  }

  checkpoint(mode: CheckpointReport["mode"] = "PASSIVE"): CheckpointReport {
    const started = performance.now();
    const row = this.writer.query(`PRAGMA wal_checkpoint(${mode})`).get() as Record<string, bigint>;
    const values = Object.values(row).map(Number);
    const busy = Number(row.busy ?? values[0] ?? 0);
    const totalFrames = Number(row.log ?? values[1] ?? 0);
    const checkpointedFrames = Number(row.checkpointed ?? values[2] ?? 0);
    this.writer
      .query("UPDATE _dbz_state SET last_checkpoint_at = ? WHERE singleton = 1")
      .run(Date.now());
    const report: CheckpointReport = Object.freeze({
      mode,
      busy,
      totalFrames,
      checkpointedFrames,
      residualFrames: Math.max(0, totalFrames - checkpointedFrames),
      oldestReader: null,
      durationMs: performance.now() - started,
    });
    this.lastCheckpoint = report;
    return report;
  }

  /** Caller must serialize this with writers. The destination must not exist. */
  backup(destination: string): BackupManifest {
    if (this.path === ":memory:") throw new Error("in-memory databases cannot be backed up with VACUUM INTO");
    if (existsSync(destination)) throw new Error(`backup destination already exists: ${destination}`);
    mkdirSync(dirname(destination), { recursive: true });
    const temporary = `${destination}.tmp-${crypto.randomUUID()}`;
    try {
      this.writer.exec(`VACUUM INTO ${sqlString(temporary)}`);
      fsyncPath(temporary);
      const inspected = inspectArtifact(temporary);
      if (inspected.schemaFingerprint !== this.schemaFingerprint()) {
        throw new CorruptDatabaseError("backup schema fingerprint does not match the running schema");
      }
      renameSync(temporary, destination);
      fsyncPath(dirname(destination));
      const bytes = statSync(destination).size;
      const sha256 = createHash("sha256").update(readFileSync(destination)).digest("hex");
      return {
        ...inspected,
        sha256,
        bytes,
        durability: this.durability,
        verifiedAt: Date.now(),
      };
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }

  static restore(source: string, destination: string, manifest: BackupManifest): void {
    if (existsSync(destination)) throw new Error(`restore destination already exists: ${destination}`);
    const bytes = statSync(source).size;
    const sha256 = createHash("sha256").update(readFileSync(source)).digest("hex");
    if (bytes !== manifest.bytes || sha256 !== manifest.sha256) {
      throw new CorruptDatabaseError("backup artifact does not match its manifest");
    }
    mkdirSync(dirname(destination), { recursive: true });
    const temporary = `${destination}.tmp-${crypto.randomUUID()}`;
    try {
      copyFileSync(source, temporary);
      fsyncPath(temporary);
      const inspected = inspectArtifact(temporary);
      if (inspected.commitVersion !== manifest.commitVersion) {
        throw new CorruptDatabaseError("restored commit version does not match the manifest");
      }
      if (inspected.schemaFingerprint !== manifest.schemaFingerprint) {
        throw new CorruptDatabaseError("restored schema does not match the manifest");
      }
      renameSync(temporary, destination);
      fsyncPath(dirname(destination));
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }

  /** Release every native handle and record only an explicitly clean shutdown. */
  close(shutdown: EngineCloseDisposition): void {
    if (shutdown !== "clean" && shutdown !== "unclean") {
      throw new TypeError('engine close disposition must be exactly "clean" or "unclean"');
    }
    if (this.closed) return;
    this.closed = true;
    let failed = false;
    let failure: unknown;
    const attempt = (work: () => void) => {
      try {
        work();
      } catch (error) {
        if (!failed) failure = error;
        failed = true;
      }
    };
    if (shutdown === "clean") {
      attempt(() => {
        this.writer.query("UPDATE _dbz_state SET clean_shutdown = 1 WHERE singleton = 1").run();
      });
    }
    for (const reader of this.additionalReaders) attempt(() => reader.close());
    this.additionalReaders.clear();
    if (this.reader !== this.writer) attempt(() => this.reader.close());
    if (shutdown === "clean") attempt(() => this.writer.exec("PRAGMA wal_checkpoint(TRUNCATE)"));
    attempt(() => this.writer.close());
    const processLock = this.processLock;
    if (processLock !== null) {
      attempt(() => rmSync(processLock, { recursive: true, force: true }));
    }
    if (failed) throw failure;
  }
}

export function indexSqlName(table: string, index: string): string {
  return `ix_${table}_${index}`;
}
