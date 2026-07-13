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
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { Database, type Statement } from "bun:sqlite";
import { decode, encode, type DurabilityPolicy } from "@dbzz/core";
import type { Validator } from "./dbz.ts";
import type { IndexDef, Schema, TableDef } from "./schema.ts";
import { snapshotOf, type SchemaSnapshot } from "./snapshot.ts";

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

export interface IntegrityReport {
  ok: boolean;
  check: "quick" | "full";
  errors: string[];
}

export interface CheckpointReport {
  mode: "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE";
  busy: number;
  totalFrames: number;
  checkpointedFrames: number;
  residualFrames: number;
  oldestReader: null;
  durationMs: number;
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

export interface StoredMutation {
  sessionId: string;
  requestId: string;
  issuedAt: number;
  principalFingerprint: string;
  functionRef: string;
  argsFingerprint: string;
  result: string;
  resultBytes: number;
  commitVersion: bigint;
  durability: DurabilityPolicy;
  completedAt: number;
}

export type NewStoredMutation = Omit<StoredMutation, "completedAt"> & { completedAt?: number };

export class IncompatibleDatabaseError extends Error {}
export class CorruptDatabaseError extends Error {}

const ENGINE_SCHEMA_VERSION = 2;
const LOCK_SUFFIX = ".dbzz.lock";

const quote = (name: string) => `"${name}"`;

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
    const state = db
      .query("SELECT commit_version, mutation_records, mutation_result_bytes FROM _dbz_state WHERE singleton = 1")
      .get() as
      | { commit_version: bigint; mutation_records: bigint; mutation_result_bytes: bigint }
      | null;
    if (state === null) throw new CorruptDatabaseError("artifact is missing DBZZ state");
    const ledger = db
      .query("SELECT COUNT(*) AS records, COALESCE(SUM(result_bytes), 0) AS bytes, COALESCE(MAX(commit_version), 0) AS max_version FROM _dbz_mutations")
      .get() as { records: bigint; bytes: bigint; max_version: bigint };
    if (
      ledger.records !== state.mutation_records ||
      ledger.bytes !== state.mutation_result_bytes ||
      ledger.max_version > state.commit_version
    ) {
      throw new CorruptDatabaseError("artifact mutation ledger is inconsistent");
    }
    const snapshot = db
      .query("SELECT value FROM _dbz_meta WHERE key = 'schema'")
      .get() as { value: string } | null;
    if (snapshot === null) throw new CorruptDatabaseError("artifact is missing its schema snapshot");
    return {
      format: 1,
      schemaFingerprint: createHash("sha256").update(snapshot.value).digest("hex"),
      commitVersion: state.commit_version,
    };
  } finally {
    db.close();
  }
}

export class Engine {
  readonly schema: Schema;
  readonly writer: Database;
  readonly reader: Database;
  readonly path: string;
  readonly durability: DurabilityPolicy;
  readonly recoveredFromCrash: boolean;
  readonly tags = new Map<string, TagMap>();
  readonly plans = new Map<string, TablePlan>();
  private readonly processLock: string | null;
  private readonly sqlitePath: string;
  private readonly busyTimeoutMs: number;
  private readonly additionalReaders = new Set<Database>();
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
    try {
      writer = new Database(sqlitePath, { create: true, safeIntegers: true });
      writer.exec("PRAGMA journal_mode = WAL");
      writer.exec(`PRAGMA synchronous = ${this.durability === "production" ? "FULL" : "NORMAL"}`);
      writer.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
      writer.exec("PRAGMA foreign_keys = ON");
      if (path === ":memory:") {
        reader = new Database(sqlitePath, { create: true, safeIntegers: true });
        reader.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
        reader.exec("PRAGMA foreign_keys = ON");
      } else {
        reader = new Database(path, { readonly: true, safeIntegers: true });
        reader.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
        reader.exec("PRAGMA foreign_keys = ON");
      }
      this.writer = writer;
      this.reader = reader;
      this.initializeInternalSchema();
      const integrity = this.integrity(options.integrityCheck ?? "quick");
      if (!integrity.ok) throw new CorruptDatabaseError(integrity.errors.join("; "));
      this.verifyInternalState();
      const state = this.writer
        .query("SELECT clean_shutdown FROM _dbz_state WHERE singleton = 1")
        .get() as { clean_shutdown: bigint };
      this.recoveredFromCrash = state.clean_shutdown === 0n;
      this.writer.query("UPDATE _dbz_state SET clean_shutdown = 0 WHERE singleton = 1").run();
      this.internTags();
      this.buildPlans();
    } catch (error) {
      if (reader !== null && reader !== writer) reader.close(false);
      writer?.close(false);
      if (this.processLock !== null) rmSync(this.processLock, { recursive: true, force: true });
      throw error;
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

  private initializeInternalSchema(): void {
    const exists = this.writer
      .query("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = '_dbz_meta'")
      .get();
    if (exists === null) {
      this.writer.exec("BEGIN IMMEDIATE");
      try {
        this.writer.exec(
          `CREATE TABLE _dbz_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
           CREATE TABLE _dbz_tags (type TEXT NOT NULL, variant TEXT NOT NULL, tag INTEGER NOT NULL, PRIMARY KEY (type, variant));
           CREATE TABLE _dbz_state (
             singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
             commit_version INTEGER NOT NULL CHECK (commit_version >= 0),
             clean_shutdown INTEGER NOT NULL CHECK (clean_shutdown IN (0, 1)),
             mutation_records INTEGER NOT NULL CHECK (mutation_records >= 0),
             mutation_result_bytes INTEGER NOT NULL CHECK (mutation_result_bytes >= 0),
             last_checkpoint_at REAL
           );
           CREATE TABLE _dbz_mutations (
             session_id TEXT NOT NULL,
             request_id TEXT NOT NULL,
             issued_at REAL NOT NULL,
             principal_fingerprint TEXT NOT NULL,
             function_ref TEXT NOT NULL,
             args_fingerprint TEXT NOT NULL,
             result TEXT NOT NULL,
             result_bytes INTEGER NOT NULL CHECK (result_bytes >= 0),
             commit_version INTEGER NOT NULL CHECK (commit_version >= 0),
             durability TEXT NOT NULL CHECK (durability IN ('production', 'balanced')),
             completed_at REAL NOT NULL,
             PRIMARY KEY (session_id, request_id)
           );
           CREATE INDEX ix__dbz_mutations_completed_at ON _dbz_mutations (completed_at);`,
        );
        this.writer
          .query("INSERT INTO _dbz_meta (key, value) VALUES ('engine_schema', ?)")
          .run(String(ENGINE_SCHEMA_VERSION));
        this.writer
          .query("INSERT INTO _dbz_state (singleton, commit_version, clean_shutdown, mutation_records, mutation_result_bytes, last_checkpoint_at) VALUES (1, 0, 1, 0, 0, NULL)")
          .run();
        this.writer.exec("COMMIT");
      } catch (error) {
        this.writer.exec("ROLLBACK");
        throw error;
      }
      return;
    }

    const version = this.writer
      .query("SELECT value FROM _dbz_meta WHERE key = 'engine_schema'")
      .get() as { value: string } | null;
    if (version === null || version.value !== String(ENGINE_SCHEMA_VERSION)) {
      throw new IncompatibleDatabaseError(
        `database engine schema is ${version?.value ?? "legacy"}; expected ${ENGINE_SCHEMA_VERSION}`,
      );
    }
    const expected = new Map([
      ["_dbz_state", ["singleton", "commit_version", "clean_shutdown", "mutation_records", "mutation_result_bytes", "last_checkpoint_at"]],
      ["_dbz_mutations", ["session_id", "request_id", "issued_at", "principal_fingerprint", "function_ref", "args_fingerprint", "result", "result_bytes", "commit_version", "durability", "completed_at"]],
    ]);
    for (const [table, columns] of expected) {
      const actual = (this.writer.query(`PRAGMA table_info(${quote(table)})`).all() as { name: string }[]).map(
        (row) => row.name,
      );
      if (actual.join("\0") !== columns.join("\0")) {
        throw new IncompatibleDatabaseError(`database internal table ${table} has an incompatible shape`);
      }
    }
  }

  integrity(check: "quick" | "full" = "quick"): IntegrityReport {
    const pragma = check === "quick" ? "quick_check" : "integrity_check";
    const results = checkRows(this.writer, pragma);
    const errors = results.filter((value) => value !== "ok");
    const foreignKeys = this.writer.query("PRAGMA foreign_key_check").all() as Record<string, unknown>[];
    for (const row of foreignKeys) errors.push(`foreign key violation: ${JSON.stringify(row)}`);
    return { ok: errors.length === 0, check, errors };
  }

  private verifyInternalState(): void {
    const state = this.writer
      .query("SELECT commit_version, mutation_records, mutation_result_bytes FROM _dbz_state WHERE singleton = 1")
      .get() as
      | { commit_version: bigint; mutation_records: bigint; mutation_result_bytes: bigint }
      | null;
    if (state === null) throw new CorruptDatabaseError("missing DBZZ state singleton");
    const actual = this.writer
      .query("SELECT COUNT(*) AS records, COALESCE(SUM(result_bytes), 0) AS bytes, COALESCE(MAX(commit_version), 0) AS max_version FROM _dbz_mutations")
      .get() as { records: bigint; bytes: bigint; max_version: bigint };
    if (state.mutation_records !== actual.records || state.mutation_result_bytes !== actual.bytes) {
      throw new CorruptDatabaseError("mutation ledger counters do not match stored records");
    }
    if (actual.max_version > state.commit_version) {
      throw new CorruptDatabaseError("mutation ledger references a future commit version");
    }
  }

  commitVersion(connection: Database = this.writer): bigint {
    const row = connection
      .query("SELECT commit_version FROM _dbz_state WHERE singleton = 1")
      .get() as { commit_version: bigint };
    return row.commit_version;
  }

  storedMutation(sessionId: string, requestId: string): StoredMutation | null {
    const row = this.writer
      .query(
        "SELECT session_id, request_id, issued_at, principal_fingerprint, function_ref, args_fingerprint, result, result_bytes, commit_version, durability, completed_at FROM _dbz_mutations WHERE session_id = ? AND request_id = ?",
      )
      .get(sessionId, requestId) as
      | {
          session_id: string;
          request_id: string;
          issued_at: number;
          principal_fingerprint: string;
          function_ref: string;
          args_fingerprint: string;
          result: string;
          result_bytes: bigint;
          commit_version: bigint;
          durability: DurabilityPolicy;
          completed_at: number;
        }
      | null;
    return row === null
      ? null
      : {
          sessionId: row.session_id,
          requestId: row.request_id,
          issuedAt: row.issued_at,
          principalFingerprint: row.principal_fingerprint,
          functionRef: row.function_ref,
          argsFingerprint: row.args_fingerprint,
          result: row.result,
          resultBytes: Number(row.result_bytes),
          commitVersion: row.commit_version,
          durability: row.durability,
          completedAt: row.completed_at,
        };
  }

  /** Persist a successful mutation receipt. The caller must own the writer transaction. */
  insertStoredMutation(record: NewStoredMutation): void {
    const completedAt = record.completedAt ?? Date.now();
    this.writer
      .query(
        "INSERT INTO _dbz_mutations (session_id, request_id, issued_at, principal_fingerprint, function_ref, args_fingerprint, result, result_bytes, commit_version, durability, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        record.sessionId,
        record.requestId,
        record.issuedAt,
        record.principalFingerprint,
        record.functionRef,
        record.argsFingerprint,
        record.result,
        record.resultBytes,
        record.commitVersion,
        record.durability,
        completedAt,
      );
    this.writer
      .query("UPDATE _dbz_state SET mutation_records = mutation_records + 1, mutation_result_bytes = mutation_result_bytes + ? WHERE singleton = 1")
      .run(record.resultBytes);
  }

  pruneStoredMutations(completedBefore: number, limit = 1_000): number {
    positiveInt(limit, "mutation prune limit");
    const rows = this.writer
      .query("SELECT session_id, request_id, result_bytes FROM _dbz_mutations WHERE completed_at < ? ORDER BY completed_at LIMIT ?")
      .all(completedBefore, limit) as { session_id: string; request_id: string; result_bytes: bigint }[];
    if (rows.length === 0) return 0;
    const bytes = rows.reduce((sum, row) => sum + row.result_bytes, 0n);
    this.writer.exec("BEGIN IMMEDIATE");
    try {
      const remove = this.writer.query(
        "DELETE FROM _dbz_mutations WHERE session_id = ? AND request_id = ?",
      );
      for (const row of rows) remove.run(row.session_id, row.request_id);
      this.writer
        .query("UPDATE _dbz_state SET mutation_records = mutation_records - ?, mutation_result_bytes = mutation_result_bytes - ? WHERE singleton = 1")
        .run(rows.length, bytes);
      this.writer.exec("COMMIT");
      return rows.length;
    } catch (error) {
      this.writer.exec("ROLLBACK");
      throw error;
    }
  }

  /** Allocate the next version. The caller must already own an open writer transaction. */
  allocateCommitVersion(): bigint {
    const row = this.writer
      .query("UPDATE _dbz_state SET commit_version = commit_version + 1 WHERE singleton = 1 RETURNING commit_version")
      .get() as { commit_version: bigint };
    return row.commit_version;
  }

  schemaFingerprint(): string {
    return createHash("sha256").update(JSON.stringify(snapshotOf(this.schema))).digest("hex");
  }

  /** Assign stable tags to every named enum/union variant. */
  private internTags(): void {
    const select = this.writer.query("SELECT variant, tag FROM _dbz_tags WHERE type = ?");
    const insert = this.writer.query("INSERT INTO _dbz_tags (type, variant, tag) VALUES (?, ?, ?)");
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
          insert.run(typeName, variant, tag);
          map.toTag.set(variant, tag);
          map.toName.set(tag, variant);
        }
      }
      this.tags.set(typeName, map);
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
    for (const plan of this.plans.values()) this.createTablePhysical(plan);
    this.saveSnapshot(snapshotOf(this.schema));
  }

  // -- Meta ------------------------------------------------------------------

  loadSnapshot(): SchemaSnapshot | null {
    const row = this.writer.query("SELECT value FROM _dbz_meta WHERE key = 'schema'").get() as
      | { value: string }
      | null;
    return row === null ? null : (JSON.parse(row.value) as SchemaSnapshot);
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
    return {
      mode,
      busy,
      totalFrames,
      checkpointedFrames,
      residualFrames: Math.max(0, totalFrames - checkpointedFrames),
      oldestReader: null,
      durationMs: performance.now() - started,
    };
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

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.writer.query("UPDATE _dbz_state SET clean_shutdown = 1 WHERE singleton = 1").run();
      for (const reader of this.additionalReaders) reader.close();
      this.additionalReaders.clear();
      if (this.reader !== this.writer) this.reader.close();
      this.writer.close();
    } finally {
      if (this.processLock !== null) rmSync(this.processLock, { recursive: true, force: true });
    }
  }
}

export function indexSqlName(table: string, index: string): string {
  return `ix_${table}_${index}`;
}
