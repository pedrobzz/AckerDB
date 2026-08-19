/**
 * The storage engine: bun:sqlite with WAL, one writer connection (all
 * transactions are serialized through the runtime's writer queue) and
 * isolated reader connections (queries and subscription recomputes see
 * committed snapshots only).
 *
 * Physical mapping:
 *   - primary key            INTEGER PRIMARY KEY AUTOINCREMENT (ids never reused)
 *   - string                 TEXT
 *   - int                    INTEGER
 *   - float / scheduleAt     REAL
 *   - bigint / identity      INTEGER
 *   - boolean                INTEGER (0/1)
 *   - bytes                  BLOB
 *   - enum                   INTEGER (stable interned tag, see _ackerdb_tags)
 *   - discriminated union    TEXT complete object payload
 *   - array / object / jsonb TEXT (wire-encoded, so bigints/bytes round-trip)
 *
 * Enum tags are interned once per (type name, variant) in `_ackerdb_tags` and
 * never change or get reused. Discriminated-union indexes are SQLite expression
 * indexes over the string discriminator inside the stored JSON object.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  constants as fsConstants,
  closeSync,
  copyFileSync,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Database, type Statement } from "bun:sqlite";
import { decode, encode, type DurabilityPolicy, type Identity } from "@ackerdb/core";
import type { Descriptor } from "../validation/validator.ts";
import { scalarDecoder, scalarEncoder, sqlTypeOf } from "../schema/descriptor-kinds.ts";
import { validateStoredDescriptor } from "../schema/stored-descriptor.ts";
import {
  MutationReplayLedger,
  mutationReplayOwner,
  scanMutationReplay,
  type MutationReplaySnapshot,
} from "./mutation-replay.ts";
import { CorruptDatabaseError, IncompatibleDatabaseError } from "../shared/errors.ts";
import { isSchema, type IndexDef, type Schema, type TableDef } from "../schema/definition.ts";
import {
  FRAMEWORK_TABLES,
  isFrameworkTable,
  withFrameworkTables,
} from "./framework-schema.ts";
import {
  canonicalJson,
  canonicalSnapshotJson,
  snapshotOf,
  type SchemaSnapshot,
  type TableSnapshot,
} from "../schema/snapshot.ts";
import { sha256Hex } from "../shared/digest.ts";
import { isValidationError } from "../validation/error.ts";
import {
  DatabaseOwnership,
  canonicalizeDatabasePath,
  coordinationDatabaseEntries,
} from "./ownership.ts";
import {
  initializationArtifactPaths,
  restoreArtifactPaths,
  SQLITE_SIDECAR_SUFFIXES,
} from "./artifacts.ts";
import { loadVectorRuntimeForSchema } from "./query/vector-runtime.ts";
import {
  createPredicateEnvironment,
  type PredicateEnvironment,
} from "./query/predicate.ts";
import {
  createFullTextTarget,
  dropFullTextTarget,
  fullTextCatalogObjects,
  fullTextTargetPlan,
  installFullTextSupport,
  prepareFullTextLiteral as prepareLiteralFullTextQuery,
  type FullTextTargetPlan,
} from "./full-text.ts";
import { fsyncPathSync } from "../shared/fsync.ts";
import {
  cleanupOnFailure,
  combinedFailure,
  runWithCleanup,
  runWithCleanupAsync,
} from "../shared/cleanup.ts";
import { quoteIdentifier } from "../shared/sql.ts";
import { transaction } from "./transaction.ts";

export { CorruptDatabaseError, IncompatibleDatabaseError } from "../shared/errors.ts";

export interface TagMap {
  toTag: Map<string, number>;
  toName: Map<number, string>;
}

/** Persist tag maps (insert-only). The caller owns the transaction. */
export function persistTagMaps(writer: Database, maps: ReadonlyMap<string, TagMap>): void {
  const insert = writer.query(
    "INSERT INTO _ackerdb_tags (type, variant, tag) VALUES (?, ?, ?) ON CONFLICT(type, variant) DO NOTHING",
  );
  for (const [type, map] of maps) {
    for (const [variant, tag] of map.toTag) insert.run(type, variant, tag);
  }
}

export interface ColumnPlan {
  readonly jsName: string;
  /** Unwrapped kind ("nullable" removed). */
  readonly kind: string;
  readonly nullable: boolean;
  /** For enum: the declared type name (tag map key). */
  readonly typeName?: string;
  /** For enum: encode one variant to its stable storage tag. */
  readonly variantTag?: (variant: unknown) => number | undefined;
  readonly ddl: string;
  /** Override when an index targets a value derived from the stored column. */
  readonly index?: {
    readonly expression: string;
    readonly value: (storedValue: unknown) => unknown;
  };
  readonly toSql: (value: unknown) => unknown;
  readonly fromSql: (value: unknown) => unknown;
}

export function columnIndexExpression(column: ColumnPlan): string {
  return column.index?.expression ?? quoteIdentifier(column.jsName);
}

export function columnIndexValue(column: ColumnPlan, value: unknown): unknown {
  return column.index?.value(value) ?? column.toSql(value);
}

/** Physical storage and codec ownership shared by live and snapshot-derived plans. */
export interface PhysicalTablePlan {
  /** The key exposed on the application's db object. */
  readonly logicalName: string;
  /** The physical SQLite table name. */
  readonly name: string;
  /** Qualified human-facing name used by validation. */
  readonly displayName: string;
  readonly pk: string;
  readonly scheduleAt: string | null;
  readonly columns: ReadonlyMap<string, ColumnPlan>;
  /** Column names in DDL order (pk first). */
  readonly columnOrder: readonly string[];
  /**
   * Runtime row projection. `safeIntegers` must remain enabled for exact i64
   * values, so logical ints are cast at the result boundary to avoid
   * materializing a temporary BigInt for every number-valued cell.
   */
  readonly readProjection: string;
  readonly indexes: readonly IndexDef[];
  readonly fullText: readonly FullTextTargetPlan[];
}

/** A live runtime plan additionally owns the TableDef used at every db validation boundary. */
export interface TablePlan extends PhysicalTablePlan {
  readonly table: TableDef;
  readonly environment: PredicateEnvironment;
  readonly hasVectorColumns: boolean;
}

const BORROWED_DATABASE_OWNERSHIP = Symbol("ackerdb.borrowedDatabaseOwnership");

interface InternalEngineOptions extends EngineOptions {
  readonly [BORROWED_DATABASE_OWNERSHIP]?: DatabaseOwnership;
}

const DEFAULT_SQLITE_PARAMETER_LIMIT = 32_766;
const BUN_SQLITE_PARAMETER_LIMIT = 65_535;

function sqliteParameterLimit(database: Database): number {
  const row = database
    .query(
      "SELECT compile_options AS value FROM pragma_compile_options WHERE compile_options GLOB 'MAX_VARIABLE_NUMBER=*' LIMIT 1",
    )
    .get() as { value: string } | null;
  const encoded = row?.value.slice("MAX_VARIABLE_NUMBER=".length);
  const limit = encoded === undefined ? NaN : Number(encoded);
  const sqliteLimit = Number.isSafeInteger(limit) && limit > 0
    ? limit
    : DEFAULT_SQLITE_PARAMETER_LIMIT;
  // Bun 1.3's positional binder wraps its expected count at 65,536 even when
  // the linked SQLite library advertises a larger MAX_VARIABLE_NUMBER.
  return Math.min(sqliteLimit, BUN_SQLITE_PARAMETER_LIMIT);
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

export interface RestorePublicationHook {
  /** Exact configured subtrees that may already exist beside the target database. */
  readonly allowedTargetSubtrees?: readonly string[];
  /** Mutate the isolated verified database before it becomes canonical. */
  prepareStagedDatabase?(engine: Engine): void | Promise<void>;
  /** Make external state referenced by the staged database durable. */
  prepare(status: EngineStatus): void | Promise<void>;
  /** Remove prepared state when the database was not canonically published. */
  rollback(): void | Promise<void>;
}

/**
 * 15 promoted Identities, Identity Accounts, and Credentials out of the
 * internal object list and into the managed logical schema. Their physical
 * tables carry the same names and different shapes, so a database written by an
 * older build is refused here — cleanly, by version — rather than meeting a
 * reconcile that would try to create a table it can already see.
 */
const ENGINE_SCHEMA_VERSION = 14;
const SQLITE_HEADER = Buffer.from("SQLite format 3\0");
const WAL_HEADER_BYTES = 32;
const WAL_FORMAT_VERSION = 3_007_000;
const WAL_MAGIC_LITTLE_ENDIAN = 0x377f0682;
const WAL_MAGIC_BIG_ENDIAN = 0x377f0683;
const FULL_TEXT_OBJECT_PREFIX = "_ackerdb_fts_";

/** Compile the exact physical row shape expected by `rowFromSql`. */
export function compileReadProjection(columns: Iterable<ColumnPlan>): string {
  const selected: string[] = [];
  let castsInt = false;
  for (const column of columns) {
    if (column.kind === "int") castsInt = true;
    const name = quoteIdentifier(column.jsName);
    selected.push(column.kind === "int" ? `CAST(${name} AS REAL) AS ${name}` : name);
  }
  return castsInt ? selected.join(", ") : "*";
}

interface StoredObject {
  type: "table" | "index" | "trigger";
  name: string;
  table: string;
  sql: string;
}

const INTERNAL_OBJECTS: StoredObject[] = [
  {
    type: "table",
    name: "_ackerdb_meta",
    table: "_ackerdb_meta",
    sql: "CREATE TABLE _ackerdb_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  },
  {
    type: "table",
    name: "_ackerdb_tags",
    table: "_ackerdb_tags",
    sql: "CREATE TABLE _ackerdb_tags (type TEXT NOT NULL, variant TEXT NOT NULL, tag INTEGER NOT NULL, PRIMARY KEY (type, variant))",
  },
  {
    type: "table",
    name: "_ackerdb_state",
    table: "_ackerdb_state",
    sql: `CREATE TABLE _ackerdb_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      commit_version INTEGER NOT NULL CHECK (commit_version >= 0),
      mutation_sequence INTEGER NOT NULL CHECK (mutation_sequence >= 0),
      clean_shutdown INTEGER NOT NULL CHECK (clean_shutdown IN (0, 1)),
      mutation_records INTEGER NOT NULL CHECK (mutation_records >= 0),
      mutation_result_bytes INTEGER NOT NULL CHECK (mutation_result_bytes >= 0),
      last_checkpoint_at REAL
    )`,
  },
  {
    type: "table",
    name: "_ackerdb_mutations",
    table: "_ackerdb_mutations",
    sql: `CREATE TABLE _ackerdb_mutations (
      sequence INTEGER PRIMARY KEY CHECK (sequence > 0),
      commit_version INTEGER NOT NULL CHECK (commit_version >= 0),
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
    name: "_ackerdb_migrations",
    table: "_ackerdb_migrations",
    sql: "CREATE TABLE _ackerdb_migrations (number INTEGER PRIMARY KEY, name TEXT NOT NULL, identity TEXT NOT NULL, applied_at REAL NOT NULL)",
  },
];

const INTERNAL_OBJECT_NAMES = new Set(INTERNAL_OBJECTS.map((object) => object.name));
const STORED_NAME = /^[a-zA-Z][a-zA-Z0-9_]*$/;

function canonicalSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

/**
 * Application-table DDL comparison is column-ORDER-insensitive: a shape-safe
 * ADD COLUMN is a physical append while the stored snapshot keeps declaration
 * order, so the same table legitimately renders in two orders. Column order is
 * not part of physical truth — every row access is name-keyed — but the column
 * set, types, and constraints still must match exactly. Our generated DDL has
 * no parentheses inside the column list; anything that does not parse as that
 * one shape falls back to the strict comparison and is flagged as before.
 */
function canonicalTableSql(sql: string): string {
  const canonical = canonicalSql(sql);
  const m = /^(CREATE TABLE .*?\()(.*)(\))$/.exec(canonical);
  if (m === null || /[()]/.test(m[2]!)) return canonical;
  const columns = m[2]!.split(",").map((column) => column.trim()).sort();
  return `${m[1]!}${columns.join(", ")}${m[3]!}`;
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

/** Table names: application identifiers plus framework-owned logical tables. */
function storedTableName(value: unknown, path: string): string {
  if (isFrameworkTable(value)) return value;
  return storedName(value, path);
}

export function columnDdl(name: string, descriptor: Descriptor, path: string): string {
  if (!storedRecord(descriptor) || typeof descriptor["k"] !== "string") {
    corruptSnapshot(`${path} is not a validator descriptor`);
  }
  const nullable = descriptor["k"] === "nullable";
  const base = (nullable ? descriptor["inner"] : descriptor) as Descriptor;
  if (!storedRecord(base) || typeof base["k"] !== "string") {
    corruptSnapshot(`${path} has an invalid nullable descriptor`);
  }
  const notNull = nullable ? "" : " NOT NULL";
  if (base["k"] === "pk") return `${quoteIdentifier(name)} INTEGER PRIMARY KEY AUTOINCREMENT`;
  const sqlType = sqlTypeOf(base["k"] as string);
  if (sqlType === undefined) corruptSnapshot(`${path} cannot be stored as a table column`);
  return `${quoteIdentifier(name)} ${sqlType}${notNull}`;
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function descriptorIndexExpression(name: string, descriptor: Descriptor): string {
  const base = descriptor["k"] === "nullable" ? descriptor["inner"] as Descriptor : descriptor;
  if (base["k"] !== "discriminatedUnion") return quoteIdentifier(name);
  const path = `$.${JSON.stringify(base["discriminator"] as string)}`;
  return `json_extract(${quoteIdentifier(name)}, ${sqlString(path)})`;
}

/** Resolve one named enum type to the tag map owning its stable storage tags. */
export type TagsOf = (typeName: string) => TagMap;

/**
 * The one descriptor-to-column codec: DDL, index/predicate expression, and the
 * encode/decode pair, for every site that puts a column on disk.
 *
 * Only the tag maps differ between those sites, so they are the only thing
 * passed in: a live plan resolves them through the Engine's interned tags,
 * a migration step through the maps it interned for its own target. Resolution
 * stays lazy because both sides can rebuild a map underneath a long-lived plan —
 * a migration relabels variants, and `reinternTags` then re-derives them.
 * `stored-rows.ts` deliberately stays separate: historical reads decode only,
 * and must tolerate a column the database does not physically have.
 */
export function columnPlan(
  jsName: string,
  descriptor: Descriptor,
  tagsOf: TagsOf,
  path: string,
): ColumnPlan {
  const ddl = columnDdl(jsName, descriptor, path);
  const nullable = descriptor["k"] === "nullable";
  const base = (nullable ? descriptor["inner"] : descriptor) as Descriptor;
  const kind = base["k"] as string;

  if (kind === "pk") {
    return { jsName, kind, nullable: false, ddl, toSql: (value) => value, fromSql: (value) => value };
  }

  const shared = { jsName, kind, nullable, ddl };
  if (kind === "discriminatedUnion") {
    const discriminator = base["discriminator"] as string;
    return {
      ...shared,
      index: {
        expression: descriptorIndexExpression(jsName, descriptor),
        value: (value: unknown) => value === null
          ? null
          : (value as Record<string, unknown>)[discriminator],
      },
      toSql: (value) => value === null ? null : encode(value),
      fromSql: (value) => value === null ? null : decode(value as string),
    };
  }
  if (kind === "enum") {
    const typeName = base["name"] as string;
    return {
      ...shared,
      typeName,
      variantTag: (variant) => typeof variant === "string"
        ? tagsOf(typeName).toTag.get(variant)
        : undefined,
      toSql: (value) => {
        if (value === null) return null;
        const tagInt = tagsOf(typeName).toTag.get(value as string);
        if (tagInt === undefined) throw new Error(`${path}: unknown ${typeName} variant "${String(value)}"`);
        return tagInt;
      },
      fromSql: (value) => (value === null ? null : tagsOf(typeName).toName.get(Number(value))!),
    };
  }
  const encodeScalar = scalarEncoder(base);
  const decodeScalar = scalarDecoder(base, path);
  return {
    ...shared,
    toSql: (value) => value === null ? null : encodeScalar(value),
    fromSql: (value) => value === null ? null : decodeScalar(value),
  };
}

/** Build one live table plan: every column's codec plus the validation environment. */
function planTable(
  table: TableDef,
  name: string,
  tagsOf: TagsOf,
): TablePlan {
  const columns = new Map<string, ColumnPlan>();
  const columnOrder: string[] = [];
  let hasVectorColumns = false;
  for (const [jsName, validator] of Object.entries(table.columns)) {
    const plan = columnPlan(jsName, validator.descriptor(), tagsOf, `${name}.${jsName}`);
    columns.set(jsName, plan);
    if (plan.kind === "vector") hasVectorColumns = true;
    columnOrder.push(plan.jsName);
  }
  return Object.freeze({
    table,
    logicalName: name,
    name,
    displayName: name,
    pk: table.primaryKey,
    scheduleAt: table.scheduleAtColumn,
    columns,
    environment: createPredicateEnvironment({ columns, table, displayName: name }),
    hasVectorColumns,
    columnOrder: Object.freeze(columnOrder),
    readProjection: compileReadProjection(columns.values()),
    indexes: Object.freeze([...table.indexes]),
    fullText: Object.freeze(table.fullTextColumns.map((column) => fullTextTargetPlan(name, column))),
  });
}

function parseStoredSnapshot(value: string): SchemaSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    corruptSnapshot("JSON cannot be parsed");
  }
  if (!storedRecord(parsed) || parsed["version"] !== 2 || !storedRecord(parsed["tables"])) {
    corruptSnapshot("root must contain version 2 and a tables object");
  }
  for (const [tableName, value] of Object.entries(parsed["tables"])) {
    storedTableName(tableName, "table name");
    if (!storedRecord(value) || (value["kind"] !== "table" && value["kind"] !== "event")) {
      corruptSnapshot(`${tableName} has an invalid table kind`);
    }
    if (
      !storedRecord(value["columns"]) ||
      !Array.isArray(value["indexes"]) ||
      !Array.isArray(value["fullText"])
    ) {
      corruptSnapshot(`${tableName} must contain columns, indexes, and fullText`);
    }
    const storedColumns = value["columns"];
    let primaryKeys = 0;
    let scheduleColumns = 0;
    for (const [column, descriptor] of Object.entries(storedColumns)) {
      storedName(column, `${tableName} column`);
      try {
        validateStoredDescriptor(descriptor, `${tableName}.${column}`);
      } catch (error) {
        if (isValidationError(error)) corruptSnapshot(error.message);
        throw error;
      }
      if (descriptor["k"] === "pk") primaryKeys++;
      if (descriptor["k"] === "scheduleAt") scheduleColumns++;
      columnDdl(column, descriptor as Descriptor, `${tableName}.${column}`);
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
        index["columns"].some((column) =>
          typeof column !== "string" || !Object.hasOwn(storedColumns, column)
        ) ||
        new Set(index["columns"]).size !== index["columns"].length ||
        typeof index["unique"] !== "boolean" ||
        Object.keys(index).some((key) => key !== "name" && key !== "columns" && key !== "unique")
      ) {
        corruptSnapshot(`${tableName}.${name} has an invalid definition`);
      }
    }
    if (value["kind"] === "event" && value["indexes"].length > 0) {
      corruptSnapshot(`${tableName} event table has physical indexes`);
    }
    const fullText = value["fullText"];
    if (
      fullText.some((column) =>
        typeof column !== "string" ||
        !Object.hasOwn(storedColumns, column) ||
        column.toLowerCase() === "rank" ||
        column.toLowerCase() === "rowid"
      ) ||
      new Set(fullText).size !== fullText.length
    ) {
      corruptSnapshot(`${tableName} has invalid full-text targets`);
    }
    for (const column of fullText) {
      const descriptor = storedColumns[column] as Descriptor;
      const base = descriptor["k"] === "nullable"
        ? descriptor["inner"] as Descriptor
        : descriptor;
      if (base["k"] !== "string") {
        corruptSnapshot(`${tableName}.${column} is not a string full-text target`);
      }
    }
    if (value["kind"] === "event" && fullText.length > 0) {
      corruptSnapshot(`${tableName} event table has full-text targets`);
    }
  }
  return parsed as unknown as SchemaSnapshot;
}

/** Hash the persisted application schema without consulting or mutating an Engine. */
function schemaSnapshotFingerprint(root: SchemaSnapshot): string {
  return sha256Hex(canonicalSnapshotJson(root));
}

/** Fingerprint the exact logical storage layout requested by an application schema. */
export function schemaFingerprintFor(schema: Schema): string {
  if (!isSchema(schema)) throw new TypeError("schema must be created with defineSchema(...)");
  return schemaSnapshotFingerprint(snapshotOf(withFrameworkTables(schema)));
}

function persistedSchemaFingerprint(connection: Database): string {
  const storedRoot = connection
    .query("SELECT value FROM _ackerdb_meta WHERE key = 'schema'")
    .get() as { value: string } | null;
  if (storedRoot === null) throw new CorruptDatabaseError("artifact is missing its schema snapshot");
  const root = parseStoredSnapshot(storedRoot.value);
  return schemaSnapshotFingerprint(root);
}

interface StoredNamedDefinition {
  readonly descriptor: string;
  readonly variants: readonly string[];
}

function namedDefinitionsOf(snapshot: SchemaSnapshot): ReadonlyMap<string, StoredNamedDefinition> {
  const definitions = new Map<string, StoredNamedDefinition>();
  const visit = (descriptor: Descriptor): void => {
    const kind = descriptor["k"];
    if (kind === "nullable" || kind === "optional" || kind === "nullish") {
      visit(descriptor["inner"] as Descriptor);
      return;
    }
    if (kind === "array") {
      visit(descriptor["el"] as Descriptor);
      return;
    }
    if (kind === "object") {
      for (const field of Object.values(descriptor["shape"] as Record<string, Descriptor>)) visit(field);
      return;
    }
    if (kind === "discriminatedUnion") {
      for (const member of Object.values(descriptor["members"] as Record<string, Descriptor>)) visit(member);
      return;
    }
    if (kind !== "enum") return;
    const name = storedName(descriptor["name"], "named type");
    const variants = descriptor["values"];
    if (
      !Array.isArray(variants) ||
      variants.length === 0 ||
      variants.some((value) => typeof value !== "string")
    ) {
      corruptSnapshot(`${name} has invalid variants`);
    }
    const definition = {
      descriptor: JSON.stringify(canonicalJson(descriptor)),
      variants: variants as string[],
    };
    const previous = definitions.get(name);
    if (previous !== undefined && previous.descriptor !== definition.descriptor) {
      corruptSnapshot(`named type ${name} has conflicting definitions`);
    }
    definitions.set(name, definition);
  };
  for (const table of Object.values(snapshot.tables)) {
    for (const descriptor of Object.values(table.columns)) visit(descriptor);
  }
  return definitions;
}

function expectedApplicationObjects(snapshot: SchemaSnapshot): StoredObject[] {
  const objects: StoredObject[] = [];
  for (const [tableName, table] of Object.entries(snapshot.tables)) {
    if (table.kind === "event") continue;
    const columns = Object.entries(table.columns).map(([column, descriptor]) =>
      columnDdl(column, descriptor, `${tableName}.${column}`),
    );
    objects.push({
      type: "table",
      name: tableName,
      table: tableName,
      sql: `CREATE TABLE ${quoteIdentifier(tableName)} (${columns.join(", ")})`,
    });
    for (const index of table.indexes) {
      const name = indexSqlName(tableName, index.name);
      objects.push({
        type: "index",
        name,
        table: tableName,
        sql: `CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${quoteIdentifier(name)} ON ${quoteIdentifier(tableName)} (${index.columns.map((column) => descriptorIndexExpression(column, table.columns[column]!)).join(", ")})`,
      });
    }
    const scheduleAt = Object.entries(table.columns).find(([, descriptor]) => descriptor["k"] === "scheduleAt")?.[0];
    if (scheduleAt !== undefined) {
      const name = `ix__sched_${tableName}`;
      objects.push({
        type: "index",
        name,
        table: tableName,
        sql: `CREATE INDEX ${quoteIdentifier(name)} ON ${quoteIdentifier(tableName)} (${quoteIdentifier(scheduleAt)})`,
      });
    }
    const primaryKey = Object.entries(table.columns)
      .find(([, descriptor]) => descriptor["k"] === "pk")![0];
    for (const column of table.fullText) {
      objects.push(
        ...fullTextCatalogObjects(
          tableName,
          primaryKey,
          fullTextTargetPlan(tableName, column),
        ),
      );
    }
  }
  return objects;
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
  return runWithCleanup(() => {
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
  }, () => closeSync(fd), `database header validation and descriptor close both failed: ${path}`);
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
  return runWithCleanup(() => {
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
  }, () => closeSync(fd), `database WAL validation and descriptor close both failed: ${walPath}`);
}

function initializeInternalObjects(connection: Database): void {
  transaction(connection, () => {
    connection.exec(INTERNAL_OBJECTS.map((object) => object.sql).join(";"));
    connection
      .query("INSERT INTO _ackerdb_meta (key, value) VALUES ('engine_schema', ?)")
      .run(String(ENGINE_SCHEMA_VERSION));
    connection
      .query("INSERT INTO _ackerdb_state (singleton, commit_version, mutation_sequence, clean_shutdown, mutation_records, mutation_result_bytes, last_checkpoint_at) VALUES (1, 0, 0, 1, 0, 0, NULL)")
      .run();
  });
}

function removeStaleInitializationArtifacts(path: string): void {
  const stale = initializationArtifactPaths(path);
  if (stale.length === 0) return;
  for (const artifact of stale) rmSync(artifact, { force: true });
  fsyncPathSync(dirname(path));
}

function removeRestoreArtifacts(path: string): boolean {
  const artifacts = restoreArtifactPaths(path);
  for (const artifact of artifacts) rmSync(artifact, { force: true });
  if (artifacts.length > 0) fsyncPathSync(dirname(path));
  return artifacts.length > 0;
}

function publishMissingDatabase(path: string): boolean {
  if (!existsSync(path) && SQLITE_SIDECAR_SUFFIXES.some((suffix) => existsSync(`${path}${suffix}`))) {
    throw new CorruptDatabaseError("database main file is missing while SQLite sidecars exist");
  }
  if (existsSync(path)) return false;
  const directory = dirname(path);
  const stagingPath = `${path}.ackerdb-init-${randomUUID()}`;
  let staged = false;
  let failed = false;
  let failure: unknown;
  let published: boolean | undefined;
  try {
    const fd = openSync(stagingPath, "wx", 0o600);
    closeSync(fd);
    staged = true;
    const database = new Database(stagingPath, { create: true, safeIntegers: true });
    runWithCleanup(() => {
      initializeInternalObjects(database);
    }, () => database.close(false), `database initialization and SQLite close both failed: ${stagingPath}`);
    fsyncPathSync(stagingPath);
    if (SQLITE_SIDECAR_SUFFIXES.some((suffix) => existsSync(`${path}${suffix}`))) {
      throw new CorruptDatabaseError("database main file is missing while SQLite sidecars exist");
    }
    try {
      linkSync(stagingPath, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        published = false;
      } else {
        throw error;
      }
    }
    if (published !== false) {
      fsyncPathSync(directory);
      published = true;
    }
  } catch (error) {
    failed = true;
    failure = error;
  }
  const cleanupErrors: unknown[] = [];
  if (staged) {
    for (const artifact of [stagingPath, ...SQLITE_SIDECAR_SUFFIXES.map((suffix) => `${stagingPath}${suffix}`)]) {
      try {
        rmSync(artifact, { force: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      fsyncPathSync(directory);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (failed) {
    throw combinedFailure(
      failure,
      cleanupErrors,
      `database initialization and staging cleanup both failed: ${path}`,
    );
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, `database initialization staging cleanup failed: ${path}`);
  }
  if (published === undefined) {
    throw new Error(`database initialization completed without a publication outcome: ${path}`);
  }
  return published;
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

function checkRows(db: Database, pragma: "quick_check" | "integrity_check"): string[] {
  const rows = db.query(`PRAGMA ${pragma}`).all() as Record<string, unknown>[];
  return rows.map((row) => String(Object.values(row)[0]));
}

function inspectArtifact(path: string): Pick<BackupManifest, "format" | "schemaFingerprint" | "commitVersion"> {
  const db = new Database(path, { readonly: true, safeIntegers: true });
  return runWithCleanup(() => {
    const checks = checkRows(db, "quick_check").filter((value) => value !== "ok");
    const foreignKeys = db.query("PRAGMA foreign_key_check").all() as Record<string, unknown>[];
    if (foreignKeys.length > 0) checks.push(`${foreignKeys.length} foreign-key violation(s)`);
    if (checks.length > 0) throw new CorruptDatabaseError(checks.join("; "));
    const version = db
      .query("SELECT value FROM _ackerdb_meta WHERE key = 'engine_schema'")
      .get() as { value: string } | null;
    if (version?.value !== String(ENGINE_SCHEMA_VERSION)) {
      throw new IncompatibleDatabaseError("artifact has an incompatible AckerDB engine schema");
    }
    const mutationReplay = scanMutationReplay(db);
    return {
      format: 1,
      schemaFingerprint: persistedSchemaFingerprint(db),
      commitVersion: mutationReplay.commitVersion,
    };
  }, () => db.close(false), `backup inspection and SQLite close both failed: ${path}`);
}

function restoreArtifact(source: string, destination: string, manifest: BackupManifest): void {
  if (existsSync(destination)) throw new Error(`restore destination already exists: ${destination}`);
  const bytes = statSync(source).size;
  const sha256 = sha256Hex(readFileSync(source));
  if (bytes !== manifest.bytes || sha256 !== manifest.sha256) {
    throw new CorruptDatabaseError("backup artifact does not match its manifest");
  }
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination, fsConstants.COPYFILE_EXCL);
  cleanupOnFailure(
    () => {
      fsyncPathSync(destination);
      const inspected = inspectArtifact(destination);
      if (inspected.commitVersion !== manifest.commitVersion) {
        throw new CorruptDatabaseError("restored commit version does not match the manifest");
      }
      if (inspected.schemaFingerprint !== manifest.schemaFingerprint) {
        throw new CorruptDatabaseError("restored schema does not match the manifest");
      }
    },
    () => rmSync(destination, { force: true }),
    `restore artifact validation and staging cleanup both failed: ${destination}`,
  );
}

export class Engine {
  readonly schema: Schema;
  readonly writer: Database;
  readonly reader: Database;
  readonly [mutationReplayOwner]: MutationReplayLedger;
  readonly path: string;
  readonly durability: DurabilityPolicy;
  /** Maximum bind parameters accepted by one statement in the active SQLite library. */
  readonly sqliteParameterLimit: number;
  readonly recoveredFromCrash: boolean;
  /** The application's tag plan; `persistTagMaps` is what commits it. */
  readonly tags = new Map<string, TagMap>();
  /** The application's physical table plans. */
  readonly plans: ReadonlyMap<string, TablePlan>;
  private readonly databaseOwnership: DatabaseOwnership | null;
  private readonly releasesDatabaseOwnership: boolean;
  private readonly sqlitePath: string;
  private readonly busyTimeoutMs: number;
  private readonly additionalReaders = new Set<Database>();
  private fullTextTokenizer: Database | null = null;
  private lastCheckpoint: CheckpointReport | null = null;
  private closed = false;

  constructor(
    schema: Schema,
    path: string,
    options: EngineOptions = {},
  ) {
    // Every root schema carries framework tables: storage, migrations,
    // reactivity, and backups treat it exactly like an application table.
    schema = withFrameworkTables(schema);
    this.schema = schema;
    loadVectorRuntimeForSchema(schema);
    this.durability = options.durability ?? "production";
    const busyTimeoutMs = positiveInt(options.busyTimeoutMs ?? 5_000, "busyTimeoutMs");
    this.busyTimeoutMs = busyTimeoutMs;
    const borrowedOwnership = (options as InternalEngineOptions)[BORROWED_DATABASE_OWNERSHIP];
    this.databaseOwnership = path === ":memory:"
      ? null
      : borrowedOwnership ?? DatabaseOwnership.acquire(path);
    this.releasesDatabaseOwnership = borrowedOwnership === undefined;
    const databasePath = path === ":memory:"
      ? path
      : borrowedOwnership === undefined
        ? this.databaseOwnership!.path
        : canonicalizeDatabasePath(path);
    this.path = databasePath;
    const sqlitePath = databasePath === ":memory:"
      ? `file:ackerdb-${randomUUID()}?mode=memory&cache=shared`
      : databasePath;
    this.sqlitePath = sqlitePath;
    let writer: Database | null = null;
    let reader: Database | null = null;
    let mutationReplay: MutationReplaySnapshot | null = null;
    try {
      if (databasePath !== ":memory:") {
        const restoreArtifacts = restoreArtifactPaths(databasePath);
        if (!existsSync(databasePath) && restoreArtifacts.length > 0) {
          throw new Error(
            `database initialization refused because an interrupted restore exists for ${databasePath}; rerun acker restore to recover or clear its exact staging files`,
          );
        }
        if (existsSync(databasePath)) removeRestoreArtifacts(databasePath);
        removeStaleInitializationArtifacts(databasePath);
      }
      const bootstrap = databasePath === ":memory:" || publishMissingDatabase(databasePath);
      if (databasePath !== ":memory:" && !bootstrap) {
        mutationReplay = this.validateExistingStorage(
          databasePath,
          busyTimeoutMs,
          options.integrityCheck ?? "quick",
        );
      }
      writer = new Database(sqlitePath, { create: databasePath === ":memory:", safeIntegers: true });
      writer.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
      writer.exec("PRAGMA foreign_keys = ON");
      this.writer = writer;
      this.sqliteParameterLimit = sqliteParameterLimit(writer);
      if (bootstrap) {
        mutationReplay = this.validateStorage(writer, options.integrityCheck ?? "quick", true);
      }
      if (mutationReplay === null) throw new Error("mutation replay ledger was not loaded");
      this[mutationReplayOwner] = new MutationReplayLedger(writer, mutationReplay);
      this.plans = this.buildPlans();
      if ([...this.plans.values()].some((plan) => plan.fullText.length > 0)) {
        this.enableFullTextSupport();
      }
      writer.exec("PRAGMA journal_mode = WAL");
      writer.exec(`PRAGMA synchronous = ${this.durability === "production" ? "FULL" : "NORMAL"}`);
      if (databasePath === ":memory:") {
        reader = new Database(sqlitePath, { create: true, safeIntegers: true });
        reader.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
        reader.exec("PRAGMA foreign_keys = ON");
      } else {
        reader = new Database(databasePath, { readonly: true, safeIntegers: true });
        reader.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
        reader.exec("PRAGMA foreign_keys = ON");
      }
      this.reader = reader;
      const state = this.writer
        .query("SELECT clean_shutdown FROM _ackerdb_state WHERE singleton = 1")
        .get() as { clean_shutdown: bigint };
      this.recoveredFromCrash = state.clean_shutdown === 0n;
      this.writer.query("UPDATE _ackerdb_state SET clean_shutdown = 0 WHERE singleton = 1").run();
    } catch (error) {
      const failure = normalizeStorageError(error);
      const cleanup: unknown[] = [];
      if (reader !== null && reader !== writer) {
        try {
          reader.close(false);
        } catch (closeError) {
          cleanup.push(closeError);
        }
      }
      if (this.fullTextTokenizer !== null) {
        try {
          this.fullTextTokenizer.close(false);
          this.fullTextTokenizer = null;
        } catch (closeError) {
          cleanup.push(closeError);
        }
      }
      if (writer !== null) {
        try {
          writer.close(false);
        } catch (closeError) {
          cleanup.push(closeError);
        }
      }
      if (this.releasesDatabaseOwnership && this.databaseOwnership !== null) {
        try {
          this.databaseOwnership.release();
        } catch (releaseError) {
          cleanup.push(releaseError);
        }
      }
      throw combinedFailure(failure, cleanup, `database open and cleanup both failed: ${databasePath}`);
    }
  }

  /** Open another isolated snapshot reader owned by this engine. */
  createReader(): Database {
    if (this.closed) throw new Error("engine is closed");
    const reader = this.path === ":memory:"
      ? new Database(this.sqlitePath, { create: true, safeIntegers: true })
      : new Database(this.sqlitePath, { readonly: true, safeIntegers: true });
    return cleanupOnFailure(
      () => {
        reader.exec(`PRAGMA busy_timeout = ${this.busyTimeoutMs}`);
        reader.exec("PRAGMA foreign_keys = ON");
        this.additionalReaders.add(reader);
        return reader;
      },
      () => reader.close(false),
      `database reader initialization and close both failed: ${this.path}`,
    );
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
      ? mkdtempSync(join(tmpdir(), "ackerdb-storage-validation-"))
      : null;
    const validationPath = directory === null ? path : join(directory, "data.db");
    const recoveryFreePageSize = directory === null ? existingDatabasePageSize(path) : null;
    let database: Database | null = null;
    let failed = false;
    let failure: unknown;
    let mutationReplay: MutationReplaySnapshot | undefined;
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
      mutationReplay = this.validateStorage(database, integrityCheck, false);
      const databasePageSize = recoveryFreePageSize ?? existingDatabasePageSize(validationPath);
      if (walPageSize !== null && walPageSize !== databasePageSize) {
        throw new CorruptDatabaseError("database WAL page size does not match its main file");
      }
    } catch (error) {
      failed = true;
      failure = error;
    }
    const cleanup: unknown[] = [];
    if (database !== null) {
      try {
        database.close(false);
      } catch (closeError) {
        cleanup.push(closeError);
      }
    }
    if (directory !== null) {
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch (cleanupError) {
        cleanup.push(cleanupError);
      }
    }
    if (failed) {
      throw combinedFailure(
        failure,
        cleanup,
        `database validation and temporary cleanup both failed: ${path}`,
      );
    }
    if (cleanup.length === 1) throw cleanup[0];
    if (cleanup.length > 1) throw new AggregateError(cleanup, `database validation cleanup failed: ${path}`);
    return mutationReplay!;
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
    // Called for its verification, not its value: the stored snapshot must parse
    // and must agree with `sqlite_master` and the interned
    // tags before this database is opened for writing. The value is deliberately
    // NOT handed onward to reconciliation — `reconcile` repeats the pass because
    // physical drift can appear after the Engine is open (see its comment).
    this.loadSnapshot(connection);
    return mutationReplay;
  }

  private initializeInternalSchema(bootstrap: boolean, connection: Database = this.writer): void {
    const objects = connection
      .query("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
      .all() as { type: string; name: string; tbl_name: string; sql: string | null }[];
    const meta = objects.find((object) => object.type === "table" && object.name === "_ackerdb_meta");
    if (meta === undefined) {
      if (!bootstrap || objects.length > 0) {
        throw new CorruptDatabaseError("pre-existing database has no AckerDB metadata; refusing to initialize it");
      }
      initializeInternalObjects(connection);
      return;
    }

    const expectedMeta = INTERNAL_OBJECTS[0]!;
    if (canonicalSql(meta.sql ?? "") !== canonicalSql(expectedMeta.sql)) {
      throw new IncompatibleDatabaseError("database internal table _ackerdb_meta has an incompatible shape");
    }

    const version = connection
      .query("SELECT value FROM _ackerdb_meta WHERE key = 'engine_schema'")
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
        (object.name.startsWith("_ackerdb_") || object.name.startsWith("ix__ackerdb_")) &&
        !object.name.startsWith(FULL_TEXT_OBJECT_PREFIX) &&
        // Framework tables live in the logical schema; their shapes are
        // verified against the snapshot like application tables.
        !FRAMEWORK_TABLES.has(object.tbl_name) &&
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
      .query("SELECT key FROM _ackerdb_meta WHERE key NOT IN ('engine_schema', 'schema', 'file_store_binding') LIMIT 1")
      .get() as { key: string } | null;
    if (unknownMeta !== null) throw new CorruptDatabaseError(`unknown AckerDB metadata key ${unknownMeta.key}`);
    const stateRows = connection
      .query("SELECT COUNT(*) AS count FROM _ackerdb_state")
      .get() as { count: bigint };
    if (stateRows.count !== 1n) throw new CorruptDatabaseError("AckerDB state must contain exactly one singleton row");
    const invalidTag = connection
      .query(
        "SELECT 1 FROM _ackerdb_tags WHERE typeof(type) <> 'text' OR length(type) = 0 OR typeof(variant) <> 'text' OR length(variant) = 0 OR typeof(tag) <> 'integer' OR tag < 0 LIMIT 1",
      )
      .get();
    const invalidTagGroup = connection
      .query(
        "SELECT 1 FROM _ackerdb_tags GROUP BY type HAVING MIN(tag) <> 0 OR MAX(tag) + 1 <> COUNT(*) OR COUNT(DISTINCT tag) <> COUNT(*) LIMIT 1",
      )
      .get();
    if (invalidTag !== null || invalidTagGroup !== null) {
      throw new CorruptDatabaseError("AckerDB tag assignments are invalid");
    }
    const invalidMigration = connection
      .query(
        "SELECT 1 FROM _ackerdb_migrations WHERE typeof(number) <> 'integer' OR number <= 0 OR typeof(name) <> 'text' OR length(name) = 0 OR typeof(identity) <> 'text' OR length(identity) <> 64 OR typeof(applied_at) NOT IN ('integer', 'real') LIMIT 1",
      )
      .get();
    if (invalidMigration !== null) throw new CorruptDatabaseError("AckerDB migration history is invalid");
  }

  commitVersion(connection: Database = this.writer): bigint {
    const row = connection
      .query("SELECT commit_version FROM _ackerdb_state WHERE singleton = 1")
      .get() as { commit_version: bigint };
    return row.commit_version;
  }

  /** Allocate the next non-replay version. The caller must own an open writer transaction. */
  allocateCommitVersion(): bigint {
    const row = this.writer
      .query("UPDATE _ackerdb_state SET commit_version = commit_version + 1 WHERE singleton = 1 RETURNING commit_version")
      .get() as { commit_version: bigint };
    return row.commit_version;
  }

  schemaFingerprint(): string {
    return persistedSchemaFingerprint(this.writer);
  }

  /**
   * Assign stable tags to every named enum variant in the application
   * schema. Reads `_ackerdb_tags` but never writes it — `persistTagMaps` commits
   * the assignment in the caller-owned schema transaction.
   */
  private internTags(): void {
    const select = this.writer.query("SELECT variant, tag FROM _ackerdb_tags WHERE type = ?");
    for (const [typeName, validator] of this.schema.namedTypes) {
      if (validator.kind !== "enum") continue;
      const variants = [...(validator as unknown as { values: readonly string[] }).values];
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

  /**
   * Re-derive every in-memory tag map from `_ackerdb_tags` + the live schema. Run
   * after a migration relabels variants (`UPDATE _ackerdb_tags`) so the renamed-to
   * variant resolves to its original tag instead of the speculative one the
   * constructor assigned; column plans read `this.tags` lazily, so they pick the
   * rebuilt maps up on their next encode.
   */
  reinternTags(): void {
    this.tags.clear();
    this.internTags();
  }

  /**
   * Literal tokenization never borrows an application reader or the serialized
   * writer. FTS-enabled Engines own one private, disposable SQLite connection
   * containing only the native tokenizer interface.
   */
  private enableFullTextSupport(): void {
    if (this.fullTextTokenizer !== null) return;
    const tokenizer = new Database(":memory:", {
      create: true,
      safeIntegers: true,
    });
    cleanupOnFailure(
      () => {
        // Literal queries are bounded to 257 tokenizer rows. Keep any native
        // ORDER BY scratch state in memory so query construction never creates
        // transient filesystem storage.
        tokenizer.exec("PRAGMA temp_store = MEMORY");
        installFullTextSupport(tokenizer);
        this.fullTextTokenizer = tokenizer;
      },
      () => tokenizer.close(false),
      "full-text capability initialization and cleanup both failed",
    );
  }

  prepareFullTextLiteral(
    input: unknown,
    path = "fullText",
  ): string | null {
    this.enableFullTextSupport();
    return prepareLiteralFullTextQuery(this.fullTextTokenizer!, input, path);
  }

  private buildPlans(): ReadonlyMap<string, TablePlan> {
    this.internTags();
    // The closure reads `this.tags` lazily, so migration relabeling can replace
    // a map underneath the live column plans without rebuilding them.
    const tagsOf: TagsOf = (typeName) => this.tags.get(typeName)!;
    const plans = new Map<string, TablePlan>();
    for (const [logicalName, table] of Object.entries(this.schema.tables)) {
      if (table.kind === "event") continue;
      plans.set(
        logicalName,
        planTable(table, logicalName, tagsOf),
      );
    }
    return plans;
  }

  // -- DDL -------------------------------------------------------------------

  createTableDdl(plan: PhysicalTablePlan, nameOverride?: string, extraColumnDdls: string[] = []): string {
    const cols = [...plan.columns.values()].map((column) => column.ddl);
    cols.push(...extraColumnDdls); // rebuilds append carried columns absent from the plan
    return `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(nameOverride ?? plan.name)} (${cols.join(", ")})`;
  }

  /** Create one table plus every ordinary and derived storage artifact it owns. */
  createTablePhysical(plan: PhysicalTablePlan): void {
    this.writer.exec(this.createTableDdl(plan));
    this.createIndexesPhysical(plan);
    this.createFullTextPhysical(plan);
  }

  createIndexesPhysical(plan: PhysicalTablePlan): void {
    for (const index of plan.indexes) this.writer.exec(this.indexDdl(plan, index));
    if (plan.scheduleAt !== null) {
      this.writer.exec(
        `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`ix__sched_${plan.name}`)} ON ${quoteIdentifier(plan.name)} (${quoteIdentifier(plan.scheduleAt)})`,
      );
    }
  }

  indexDdl(plan: PhysicalTablePlan, index: IndexDef): string {
    const unique = index.unique ? "UNIQUE " : "";
    const cols = index.columns.map((column) => columnIndexExpression(plan.columns.get(column)!)).join(", ");
    return `CREATE ${unique}INDEX IF NOT EXISTS ${quoteIdentifier(indexSqlName(plan.name, index.name))} ON ${quoteIdentifier(plan.name)} (${cols})`;
  }

  createFullTextPhysical(plan: PhysicalTablePlan): void {
    for (const target of plan.fullText) this.createFullTextTargetPhysical(plan, target.column);
  }

  createFullTextTargetPhysical(plan: PhysicalTablePlan, column: string): void {
    const target = plan.fullText.find((candidate) => candidate.column === column);
    if (target === undefined) {
      throw new Error(`${plan.displayName}.${column}: unknown full-text target`);
    }
    createFullTextTarget(this.writer, plan.name, plan.pk, target);
  }

  dropFullTextTargetPhysical(
    table: string,
    column: string,
  ): void {
    dropFullTextTarget(
      this.writer,
      fullTextTargetPlan(table, column),
    );
  }

  dropStoredFullTextPhysical(table: string, snapshot: TableSnapshot): void {
    for (const column of snapshot.fullText) {
      dropFullTextTarget(
        this.writer,
        fullTextTargetPlan(table, column),
      );
    }
  }

  /** Create all tables and indexes for a fresh database and store the snapshot. */
  createAll(): void {
    transaction(this.writer, () => {
      persistTagMaps(this.writer, this.tags);
      for (const plan of this.plans.values()) this.createTablePhysical(plan);
      this.saveSnapshot(snapshotOf(this.schema));
    });
  }

  // -- Meta ------------------------------------------------------------------

  loadSnapshot(connection: Database = this.writer): SchemaSnapshot | null {
    const row = connection.query("SELECT value FROM _ackerdb_meta WHERE key = 'schema'").get() as
      | { value: string }
      | null;
    const snapshot = row === null ? null : parseStoredSnapshot(row.value);
    this.verifyApplicationSchema(snapshot, connection);
    this.verifySnapshotTags(snapshot, connection);
    return snapshot;
  }

  private verifyApplicationSchema(
    snapshot: SchemaSnapshot | null,
    connection: Database,
  ): void {
    const actual = connection
      .query("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
      .all() as { type: string; name: string; tbl_name: string; sql: string | null }[];
    const expected = new Map(
      [
        ...INTERNAL_OBJECTS,
        ...(snapshot === null ? [] : expectedApplicationObjects(snapshot)),
      ]
        .map((object) => [object.name, object]),
    );
    const extra = actual.find((object) => !expected.has(object.name));
    if (extra !== undefined) {
      const reason = snapshot === null ? "without a schema snapshot" : "outside the stored schema snapshot";
      throw new CorruptDatabaseError(`database object ${extra.name} exists ${reason}`);
    }
    for (const object of expected.values()) {
      const stored = actual.find((candidate) => candidate.name === object.name);
      const canonical = object.type === "table" ? canonicalTableSql : canonicalSql;
      if (
        stored === undefined ||
        stored.type !== object.type ||
        stored.tbl_name !== object.table ||
        canonical(stored.sql ?? "") !== canonical(object.sql)
      ) {
        if (INTERNAL_OBJECT_NAMES.has(object.name)) continue;
        throw new CorruptDatabaseError(
          `database ${object.type} ${object.name} does not match the stored schema snapshot`,
        );
      }
    }
  }

  private verifySnapshotTags(
    snapshot: SchemaSnapshot | null,
    connection: Database,
  ): void {
    const rootDefinitions: ReadonlyMap<string, StoredNamedDefinition> = snapshot === null
      ? new Map()
      : namedDefinitionsOf(snapshot);
    const stored = new Map<string, Set<string>>();
    for (const row of connection.query("SELECT type, variant FROM _ackerdb_tags").all() as { type: string; variant: string }[]) {
      const variants = stored.get(row.type) ?? new Set<string>();
      variants.add(row.variant);
      stored.set(row.type, variants);
    }
    for (const [type, definition] of rootDefinitions) {
      const missing = definition.variants.find((variant) => !stored.get(type)?.has(variant));
      if (missing !== undefined) {
        throw new CorruptDatabaseError(`AckerDB tag assignment is missing ${type}.${missing}`);
      }
    }
  }

  saveSnapshot(snapshot: SchemaSnapshot): void {
    this.writer
      .query("INSERT INTO _ackerdb_meta (key, value) VALUES ('schema', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(snapshot));
  }

  // -- Row codec + basic CRUD (ctx.db composes richer queries on top) --------

  plan(table: string): TablePlan {
    const plan = this.plans.get(table);
    if (plan === undefined) throw new Error(`unknown table "${table}"`);
    return plan;
  }

  /** Decode one SQL result object (keyed by physical column name) to a JS row. */
  rowFromSql(plan: TablePlan, sqlRow: Record<string, unknown>): Record<string, unknown> {
    const row: Record<string, unknown> = {};
    for (const column of plan.columns.values()) {
      row[column.jsName] = column.fromSql(sqlRow[column.jsName]);
    }
    return row;
  }

  insertSql(plan: TablePlan): { sql: string; bind(row: Record<string, unknown>): unknown[] } {
    const columns = [...plan.columns.values()].filter((c) => c.kind !== "pk");
    const physicalColumns = columns.map((column) => column.jsName);
    // A table whose only column is its key — `_ackerdb_identities`, where the
    // Identity *is* the row — has no column list to bind, and SQLite spells
    // that case differently.
    const values = physicalColumns.length === 0
      ? "DEFAULT VALUES"
      : `(${physicalColumns.map(quoteIdentifier).join(", ")}) VALUES (${physicalColumns.map(() => "?").join(", ")})`;
    const sql = `INSERT INTO ${quoteIdentifier(plan.name)} ${values} RETURNING ${quoteIdentifier(plan.pk)}`;
    return {
      sql,
      bind: (row) => columns.map((column) => column.toSql(row[column.jsName])),
    };
  }

  statement(conn: Database, sql: string): Statement {
    return conn.query(sql);
  }

  status(): EngineStatus {
    const state = this.writer
      .query("SELECT commit_version, mutation_records, mutation_result_bytes, last_checkpoint_at FROM _ackerdb_state WHERE singleton = 1")
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
      .query("UPDATE _ackerdb_state SET last_checkpoint_at = ? WHERE singleton = 1")
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
    let published = false;
    try {
      this.writer.exec(`VACUUM INTO ${sqlString(temporary)}`);
      fsyncPathSync(temporary);
      const inspected = inspectArtifact(temporary);
      if (inspected.schemaFingerprint !== this.schemaFingerprint()) {
        throw new CorruptDatabaseError("backup schema fingerprint does not match the running schema");
      }
      renameSync(temporary, destination);
      published = true;
      fsyncPathSync(dirname(destination));
      const bytes = statSync(destination).size;
      const sha256 = sha256Hex(readFileSync(destination));
      return {
        ...inspected,
        sha256,
        bytes,
        durability: this.durability,
        verifiedAt: Date.now(),
      };
    } catch (error) {
      const cleanup: unknown[] = [];
      for (const artifact of published ? [temporary, destination] : [temporary]) {
        try {
          rmSync(artifact, { force: true });
        } catch (cleanupError) {
          cleanup.push(cleanupError);
        }
      }
      if (cleanup.length > 0) {
        throw new AggregateError(
          [error, ...cleanup],
          `backup creation and artifact cleanup both failed: ${destination}`,
        );
      }
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
    const failures: unknown[] = [];
    const attempt = (work: () => void) => {
      try {
        work();
      } catch (error) {
        failures.push(error);
      }
    };
    if (shutdown === "clean") {
      attempt(() => {
        this.writer.query("UPDATE _ackerdb_state SET clean_shutdown = 1 WHERE singleton = 1").run();
      });
    }
    for (const reader of this.additionalReaders) attempt(() => reader.close());
    this.additionalReaders.clear();
    if (this.reader !== this.writer) attempt(() => this.reader.close());
    if (this.fullTextTokenizer !== null) {
      attempt(() => this.fullTextTokenizer!.close());
      this.fullTextTokenizer = null;
    }
    if (shutdown === "clean") attempt(() => this.writer.exec("PRAGMA wal_checkpoint(TRUNCATE)"));
    attempt(() => this.writer.close());
    if (this.releasesDatabaseOwnership && this.databaseOwnership !== null) {
      attempt(() => this.databaseOwnership!.release());
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, `database close failed: ${this.path}`);
  }
}

/**
 * Exclusive, same-directory staging and no-clobber publication for one
 * canonical restore target. The canonical path is never written directly.
 */
export class DatabaseRestoreTarget {
  readonly path: string;
  readonly stagingPath: string;
  private readonly ownership: DatabaseOwnership;
  private readonly allowedTargetSubtrees: readonly string[];
  private manifest: BackupManifest | null = null;
  private restored = false;
  private linked = false;
  private publicationDurable = false;
  private closed = false;

  private constructor(
    path: string,
    ownership: DatabaseOwnership,
    allowedTargetSubtrees: readonly string[],
  ) {
    this.path = path;
    this.ownership = ownership;
    this.allowedTargetSubtrees = allowedTargetSubtrees;
    this.stagingPath = `${path}.ackerdb-restore-${randomUUID()}`;
  }

  static acquire(path: string, allowedTargetSubtrees: readonly string[] = []): DatabaseRestoreTarget {
    if (path === ":memory:") throw new TypeError("restore requires a file-backed database target");
    try {
      if (lstatSync(path).isSymbolicLink()) {
        throw new TypeError(`restore target must not be a symbolic link: ${path}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true });
    const ownership = DatabaseOwnership.acquire(path);
    const database = ownership.path;
    return cleanupOnFailure(
      () => {
        const restoreArtifacts = new Set(
          restoreArtifactPaths(database).map((artifact) => basename(artifact)),
        );
        assertRestoreTargetFresh(database, restoreArtifacts, allowedTargetSubtrees);
        removeRestoreArtifacts(database);
        return new DatabaseRestoreTarget(database, ownership, allowedTargetSubtrees);
      },
      () => ownership.release(),
      `restore target acquisition and ownership cleanup both failed: ${database}`,
    );
  }

  get published(): boolean {
    return this.linked;
  }

  assertVacant(): void {
    this.assertOpen();
    assertRestoreTargetFresh(this.path, new Set(), this.allowedTargetSubtrees);
  }

  restore(source: string, manifest: BackupManifest): void {
    this.assertOpen();
    if (this.restored) throw new Error("restore artifact has already been staged");
    restoreArtifact(source, this.stagingPath, manifest);
    this.manifest = manifest;
    this.restored = true;
  }

  open(schema: Schema, options: EngineOptions = {}): Engine {
    this.assertOpen();
    if (!this.restored || !existsSync(this.stagingPath)) {
      throw new Error("restore artifact must be staged before it is opened");
    }
    return new Engine(schema, this.stagingPath, {
      ...options,
      [BORROWED_DATABASE_OWNERSHIP]: this.ownership,
    } as InternalEngineOptions);
  }

  publish(): void {
    this.assertOpen();
    if (!this.restored || !existsSync(this.stagingPath)) {
      throw new Error("restore artifact must be staged and verified before publication");
    }
    const database = new Database(this.stagingPath, { safeIntegers: true });
    runWithCleanup(() => {
      const mode = database.query("PRAGMA journal_mode = DELETE").get() as Record<string, unknown>;
      if (String(Object.values(mode)[0]).toLowerCase() !== "delete") {
        throw new Error("restore staging could not become a self-contained SQLite main file");
      }
    }, () => database.close(false), `restore finalization and SQLite close both failed: ${this.stagingPath}`);
    const inspected = inspectArtifact(this.stagingPath);
    if (
      this.manifest === null ||
      inspected.commitVersion !== this.manifest.commitVersion ||
      inspected.schemaFingerprint !== this.manifest.schemaFingerprint
    ) {
      throw new CorruptDatabaseError("restore staging changed during publication finalization");
    }
    fsyncPathSync(this.stagingPath);
    for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
      const sidecar = `${this.stagingPath}${suffix}`;
      if (!existsSync(sidecar)) continue;
      // SQLite's shared-memory index is reconstructible and carries no commit
      // state. A nonempty WAL or rollback journal is meaningful and must not
      // be detached from the staged main file.
      if (suffix !== "-shm" && statSync(sidecar).size > 0) {
        throw new Error(`verified restore staging has meaningful SQLite sidecar state: ${sidecar}`);
      }
      rmSync(sidecar);
    }
    const canonicalSidecar = SQLITE_SIDECAR_SUFFIXES.find((suffix) => existsSync(`${this.path}${suffix}`));
    if (canonicalSidecar !== undefined) {
      throw new Error(
        `restore target changed before publication; canonical SQLite sidecar exists: ${this.path}${canonicalSidecar}`,
      );
    }
    try {
      linkSync(this.stagingPath, this.path);
      this.linked = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`restore target changed before publication; database already exists: ${this.path}`);
      }
      throw error;
    }
    try {
      fsyncPathSync(dirname(this.path));
      this.publicationDurable = true;
    } catch (error) {
      throw new Error(
        `restore database was published at ${this.path}, but its directory durability is unknown; staging evidence remains at ${this.stagingPath}`,
        { cause: error },
      );
    }
    try {
      rmSync(this.stagingPath);
      this.restored = false;
    } catch (error) {
      throw new Error(
        `restore database was durably published at ${this.path}, but staging cleanup failed; evidence remains at ${this.stagingPath}`,
        { cause: error },
      );
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const failures: unknown[] = [];
    if (!this.linked) {
      try {
        this.removeStaging();
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      this.ownership.release();
    } catch (error) {
      failures.push(this.linked
        ? new Error(
          this.publicationDurable
            ? `restore database was already durably published at ${this.path}, but canonical database ownership release failed; the canonical database was not removed`
            : `restore database was published at ${this.path}, but directory durability remains unknown and canonical database ownership release also failed; the canonical database and staging evidence were not removed`,
          { cause: error },
        )
        : error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, `restore target cleanup failed: ${this.path}`);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("restore target is closed");
    if (this.linked) throw new Error("restore target has already been published");
  }

  private removeStaging(): void {
    const failures: unknown[] = [];
    for (const artifact of [
      this.stagingPath,
      ...SQLITE_SIDECAR_SUFFIXES.map((suffix) => `${this.stagingPath}${suffix}`),
    ]) {
      try {
        rmSync(artifact, { force: true });
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, `restore staging cleanup failed: ${this.stagingPath}`);
    }
  }
}

function assertRestoreTargetFresh(
  path: string,
  allowedEntries: ReadonlySet<string>,
  allowedTargetSubtrees: readonly string[] = [],
): void {
  if (existsSync(path)) {
    throw new Error(`restore requires a fresh target; database already exists: ${path}`);
  }
  const canonicalSidecar = SQLITE_SIDECAR_SUFFIXES.find((suffix) => existsSync(`${path}${suffix}`));
  if (canonicalSidecar !== undefined) {
    throw new Error(
      `restore requires a fresh target; canonical SQLite sidecar exists: ${path}${canonicalSidecar}`,
    );
  }
  const directory = dirname(path);
  const allowedSubtrees = allowedTargetSubtrees
    .map(canonicalizeRestoreSubtree)
    .filter((subtree) => {
      const fromDirectory = relative(directory, subtree);
      return fromDirectory !== "" && !isAbsolute(fromDirectory) &&
        fromDirectory !== ".." && !fromDirectory.startsWith(`..${sep}`);
    });
  const ownershipEntries = new Set(coordinationDatabaseEntries(path).map((entry) => basename(entry)));
  const unrelated = readdirSync(directory, { withFileTypes: true }).find(
    (entry) => !ownershipEntries.has(entry.name) && !allowedEntries.has(entry.name) &&
      !isAllowedRestoreSubtree(join(directory, entry.name), allowedSubtrees),
  );
  if (unrelated !== undefined) {
    throw new Error(
      `restore requires a vacant target directory; unrelated entry exists: ${join(directory, unrelated.name)}`,
    );
  }
}

function canonicalizeRestoreSubtree(path: string): string {
  let existing = resolve(path);
  const missing: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    missing.unshift(basename(existing));
    existing = parent;
  }
  return join(canonicalizeDatabasePath(existing), ...missing);
}

function isAllowedRestoreSubtree(path: string, allowedSubtrees: readonly string[]): boolean {
  if (allowedSubtrees.includes(path)) return true;
  const descendant = allowedSubtrees.some((subtree) => {
    const fromPath = relative(path, subtree);
    return fromPath !== "" && !isAbsolute(fromPath) &&
      fromPath !== ".." && !fromPath.startsWith(`..${sep}`);
  });
  if (!descendant) return false;
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) return false;
  return readdirSync(path).every((entry) =>
    isAllowedRestoreSubtree(join(path, entry), allowedSubtrees));
}

function proveRestoredNextCommit(engine: Engine): void {
  const terminal = engine.commitVersion();
  // Not a `transaction()` site: this probe rolls back on SUCCESS, because
  // proving the next commit version must not consume it.
  engine.writer.exec("BEGIN IMMEDIATE");
  runWithCleanup(
    () => {
      const next = engine.allocateCommitVersion();
      if (next !== terminal + 1n) {
        throw new Error(`next commit version was ${next}; expected ${terminal + 1n}`);
      }
    },
    () => engine.writer.exec("ROLLBACK"),
    "restore commit probe and rollback both failed",
  );
  transaction(engine.writer, () => {
    engine.writer
      .query("UPDATE _ackerdb_state SET commit_version = commit_version WHERE singleton = 1")
      .run();
  });
  if (engine.commitVersion() !== terminal) {
    throw new Error("restore commit probe changed the terminal commit version");
  }
}

/**
 * Verify and publish one artifact under canonical database ownership. There is
 * no public staging state machine: every successful call performs the full
 * integrity/layout/commit probe before the no-clobber link becomes visible.
 */
export async function restoreVerifiedLayout(
  source: string,
  target: string,
  manifest: BackupManifest,
  loadSchema: () => Schema | Promise<Schema>,
  publication?: RestorePublicationHook,
): Promise<EngineStatus> {
  const restoreTarget = DatabaseRestoreTarget.acquire(
    target,
    publication?.allowedTargetSubtrees ?? [],
  );
  let failed = false;
  let failure: unknown;
  let status: EngineStatus | undefined;
  let publicationStarted = false;
  try {
    const schema = await loadSchema();
    if (!isSchema(schema)) throw new TypeError("restore schema loader must return a AckerDB schema");
    restoreTarget.assertVacant();
    restoreTarget.restore(source, manifest);
    const engine = restoreTarget.open(schema, {
      durability: manifest.durability,
      integrityCheck: "full",
    });
    await runWithCleanupAsync(
      async () => {
        if (engine.schemaFingerprint() !== manifest.schemaFingerprint) {
          throw new CorruptDatabaseError("restore staging layout does not match the manifest");
        }
        status = engine.status();
        if (status.commitVersion !== manifest.commitVersion) {
          throw new CorruptDatabaseError("restore staging commit version does not match the manifest");
        }
        proveRestoredNextCommit(engine);
        await publication?.prepareStagedDatabase?.(engine);
      },
      () => engine.close("clean"),
      `restore staging verification and database close both failed: ${target}`,
    );
    // External durable state referenced by the restored database must become
    // valid while the canonical database is still absent. A failure here
    // leaves the verified SQLite staging artifact unpublished and removable.
    if (publication !== undefined) {
      publicationStarted = true;
      await publication.prepare(status!);
    }
    restoreTarget.publish();
  } catch (error) {
    failed = true;
    failure = error;
    if (publicationStarted && !restoreTarget.published) {
      try {
        await publication!.rollback();
      } catch (rollbackError) {
        failure = new AggregateError(
          [error, rollbackError],
          `restore publication preparation and rollback both failed: ${target}`,
        );
      }
    }
  }
  try {
    restoreTarget.close();
  } catch (closeError) {
    if (failed) {
      throw new AggregateError(
        [failure, closeError],
        `restore operation and target cleanup both failed: ${target}`,
      );
    }
    throw closeError;
  }
  if (failed) throw failure;
  return status!;
}

export function indexSqlName(table: string, index: string): string {
  return `ix_${table}_${index}`;
}
