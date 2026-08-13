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
 *   - union                  INTEGER tag column + TEXT payload column "<col>__p"
 *   - array / object / jsonb TEXT (wire-encoded, so bigints/bytes round-trip)
 *
 * Enum/union tags are interned once per (type name, variant name) in
 * `_ackerdb_tags` and never change and are never reused: reordering variants is
 * cosmetic, renames keep storage, deletions retire the tag forever.
 *
 * Direct indexes execute as SQLite b-tree indexes: same API and semantics;
 * the array-backed layout is a later optimization if benchmarks demand it
 * (the same "only if it wins" rule the wiki applies to sized numerics).
 */
import { createHash, randomUUID } from "node:crypto";
import { compareCodeUnits } from "../shared/ordering.ts";
import {
  constants as fsConstants,
  closeSync,
  copyFileSync,
  existsSync,
  fstatSync,
  fsyncSync,
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
import {
  CREDENTIAL_INTERNAL_OBJECTS,
  CredentialVault,
  credentialVaultOwner,
  verifyCredentialVaultState,
} from "../auth/credential-vault.ts";
import type { ExternalAccount } from "../auth/credentials.ts";
import { CorruptDatabaseError, IncompatibleDatabaseError } from "../shared/errors.ts";
import { isSchema, type IndexDef, type Schema, type TableDef } from "../schema/definition.ts";
import { JOBS_TABLE } from "../jobs/table.ts";
import {
  FRAMEWORK_TABLES,
  isFrameworkTable,
  withFrameworkTables,
} from "./framework-schema.ts";
import {
  canonicalSnapshotJson,
  snapshotOf,
  type SchemaSnapshot,
  type TableSnapshot,
} from "../schema/snapshot.ts";
import { isValidationError, ValidationError } from "../validation/error.ts";
import { isPluginDefinitionId, isPluginIdentifier } from "../plugins/identifiers.ts";
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

export { CorruptDatabaseError, IncompatibleDatabaseError } from "../shared/errors.ts";
export interface TagMap {
  toTag: Map<string, number>;
  toName: Map<number, string>;
}

interface PhysCol {
  readonly name: string;
  readonly ddl: string;
}

export interface ColumnPlan {
  readonly jsName: string;
  /** Unwrapped kind ("nullable" removed). */
  readonly kind: string;
  readonly nullable: boolean;
  /** For enum/union: the declared type name (tag map key). */
  readonly typeName?: string;
  /** For enum/union: encode one declared variant to its stable storage tag. */
  readonly variantTag?: (variant: string) => number | undefined;
  readonly phys: readonly PhysCol[];
  readonly toSql: (value: unknown) => unknown[];
  readonly fromSql: (values: unknown[]) => unknown;
}

/** Physical storage and codec ownership shared by live and snapshot-derived plans. */
export interface PhysicalTablePlan {
  /** The key exposed on this scope's db object. */
  readonly logicalName: string;
  /** The physical SQLite table name. */
  readonly name: string;
  /** Qualified human-facing name used by validation. */
  readonly displayName: string;
  /** Resolve a logical named type to this scope's stable storage identity. */
  tagIdentity(typeName: string): string;
  readonly pk: string;
  readonly scheduleAt: string | null;
  readonly columns: ReadonlyMap<string, ColumnPlan>;
  /** Physical column names in DDL order (pk first). */
  readonly physOrder: readonly string[];
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

/** One logical schema bound to its isolated physical storage plans. */
export interface StorageScope {
  /** `null` is the application root; Plugin scopes carry their manifest mount. */
  readonly mount: string | null;
  readonly schema: Schema;
  readonly plans: ReadonlyMap<string, TablePlan>;
  /**
   * This scope's tag plan, keyed by storage identity. A planned scope owns it
   * privately; activation publishes it to the Engine, and `persistTags` writes
   * it to `_ackerdb_tags`. The root scope's map IS the Engine's, so
   * `reinternTags` can rebuild it underneath the root's live plans.
   */
  readonly tags: ReadonlyMap<string, TagMap>;
  tagIdentity(typeName: string): string;
  plan(logicalName: string): TablePlan;
}

/** One verified row from the persisted Plugin storage inventory. */
export interface StoredPluginStorage {
  readonly mount: string;
  readonly definitionId: string;
  readonly snapshot: SchemaSnapshot;
  readonly encodedSnapshot: string;
}

export interface NormalizedPluginSnapshot {
  readonly snapshot: SchemaSnapshot;
  readonly encoded: string;
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

const ENGINE_SCHEMA_VERSION = 13;
const SQLITE_HEADER = Buffer.from("SQLite format 3\0");
const WAL_HEADER_BYTES = 32;
const WAL_FORMAT_VERSION = 3_007_000;
const WAL_MAGIC_LITTLE_ENDIAN = 0x377f0682;
const WAL_MAGIC_BIG_ENDIAN = 0x377f0683;
const PLUGIN_TABLE_PREFIX = "_ackerdb_plugin_";
const PLUGIN_INDEX_PREFIX = `ix_${PLUGIN_TABLE_PREFIX}`;
const FULL_TEXT_OBJECT_PREFIX = "_ackerdb_fts_";
const quote = (name: string) => `"${name}"`;

/** Length-prefixing makes mount/table boundaries injective even when either contains `_`. */
function pluginStoragePrefix(mount: string): string {
  return `${PLUGIN_TABLE_PREFIX}${mount.length}:${mount}`;
}

export function pluginPhysicalTableName(mount: string, logicalName: string): string {
  return `${pluginStoragePrefix(mount)}${logicalName}`;
}

export function pluginTagIdentity(mount: string, typeName: string): string {
  return `${mount.length}:${mount}${typeName}`;
}

/** Compile the exact physical row shape expected by `rowFromSql`. */
export function compileReadProjection(columns: Iterable<ColumnPlan>): string {
  const selected: string[] = [];
  let castsInt = false;
  for (const column of columns) {
    if (column.kind === "int") castsInt = true;
    for (const physical of column.phys) {
      const name = quote(physical.name);
      selected.push(column.kind === "int" ? `CAST(${name} AS REAL) AS ${name}` : name);
    }
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
    name: "_ackerdb_plugins",
    table: "_ackerdb_plugins",
    sql: "CREATE TABLE _ackerdb_plugins (mount TEXT PRIMARY KEY, definition_identity TEXT NOT NULL, schema TEXT NOT NULL)",
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
    name: "_ackerdb_identities",
    table: "_ackerdb_identities",
    sql: "CREATE TABLE _ackerdb_identities (identity INTEGER PRIMARY KEY AUTOINCREMENT)",
  },
  {
    type: "table",
    name: "_ackerdb_identity_accounts",
    table: "_ackerdb_identity_accounts",
    sql: `CREATE TABLE _ackerdb_identity_accounts (
      issuer TEXT NOT NULL CHECK (length(issuer) > 0),
      subject TEXT NOT NULL CHECK (length(subject) > 0),
      identity INTEGER NOT NULL REFERENCES _ackerdb_identities(identity) ON UPDATE RESTRICT ON DELETE RESTRICT,
      PRIMARY KEY (issuer, subject)
    )`,
  },
  {
    type: "index",
    name: "ix__ackerdb_identity_accounts_identity",
    table: "_ackerdb_identity_accounts",
    sql: "CREATE INDEX ix__ackerdb_identity_accounts_identity ON _ackerdb_identity_accounts (identity)",
  },
  {
    type: "table",
    name: "_ackerdb_migrations",
    table: "_ackerdb_migrations",
    sql: "CREATE TABLE _ackerdb_migrations (number INTEGER PRIMARY KEY, name TEXT NOT NULL, identity TEXT NOT NULL, applied_at REAL NOT NULL)",
  },
  ...CREDENTIAL_INTERNAL_OBJECTS,
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

export function physicalColumnDdl(name: string, descriptor: Descriptor, path: string): string[] {
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
  const sqlType = sqlTypeOf(base["k"] as string);
  if (sqlType === undefined) corruptSnapshot(`${path} cannot be stored as a table column`);
  return [`${quote(name)} ${sqlType}${notNull}`];
}

/** Resolve one named enum/union type to the tag map owning its stable storage tags. */
export type TagsOf = (typeName: string) => TagMap;

/**
 * The one descriptor-to-physical-column codec: DDL, physical column names, and
 * the encode/decode pair, for every site that has to put a column on disk.
 *
 * Only the tag maps differ between those sites, so they are the only thing
 * passed in: a live plan resolves them through the Engine's scope-interned tags,
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
  const ddls = physicalColumnDdl(jsName, descriptor, path);
  const nullable = descriptor["k"] === "nullable";
  const base = (nullable ? descriptor["inner"] : descriptor) as Descriptor;
  const kind = base["k"] as string;
  const phys = ddls.length === 2
    ? [{ name: jsName, ddl: ddls[0]! }, { name: `${jsName}__p`, ddl: ddls[1]! }]
    : [{ name: jsName, ddl: ddls[0]! }];

  if (kind === "pk") {
    return { jsName, kind, nullable: false, phys, toSql: (value) => [value], fromSql: (values) => values[0] };
  }

  const shared = { jsName, kind, nullable, phys };
  if (kind === "union") {
    const typeName = base["name"] as string;
    return {
      ...shared,
      typeName,
      variantTag: (variant) => tagsOf(typeName).toTag.get(variant),
      toSql: (value) => {
        if (value === null) return [null, null];
        const { tag, value: payload } = value as { tag: string; value: unknown };
        const tagInt = tagsOf(typeName).toTag.get(tag);
        if (tagInt === undefined) throw new Error(`${path}: unknown ${typeName} variant "${tag}"`);
        return [tagInt, encode(payload)];
      },
      fromSql: (values) =>
        values[0] === null
          ? null
          : { tag: tagsOf(typeName).toName.get(Number(values[0]))!, value: decode(values[1] as string) },
    };
  }
  if (kind === "enum") {
    const typeName = base["name"] as string;
    return {
      ...shared,
      typeName,
      variantTag: (variant) => tagsOf(typeName).toTag.get(variant),
      toSql: (value) => {
        if (value === null) return [null];
        const tagInt = tagsOf(typeName).toTag.get(value as string);
        if (tagInt === undefined) throw new Error(`${path}: unknown ${typeName} variant "${String(value)}"`);
        return [tagInt];
      },
      fromSql: (values) => (values[0] === null ? null : tagsOf(typeName).toName.get(Number(values[0]))!),
    };
  }
  const encodeScalar = scalarEncoder(base);
  const decodeScalar = scalarDecoder(base, path);
  return {
    ...shared,
    toSql: (value) => [value === null ? null : encodeScalar(value)],
    fromSql: (values) => (values[0] === null ? null : decodeScalar(values[0])),
  };
}

/** Build one live table plan: every column's codec plus the validation environment. */
function planTable(
  table: TableDef,
  logicalName: string,
  name: string,
  displayName: string,
  tagIdentity: StorageScope["tagIdentity"],
  tagsOf: TagsOf,
): TablePlan {
  const columns = new Map<string, ColumnPlan>();
  const physOrder: string[] = [];
  let hasVectorColumns = false;
  for (const [jsName, validator] of Object.entries(table.columns)) {
    const plan = columnPlan(jsName, validator.descriptor(), tagsOf, `${displayName}.${jsName}`);
    columns.set(jsName, plan);
    if (plan.kind === "vector") hasVectorColumns = true;
    for (const phys of plan.phys) physOrder.push(phys.name);
  }
  return Object.freeze({
    table,
    logicalName,
    name,
    displayName,
    tagIdentity,
    pk: table.primaryKey,
    scheduleAt: table.scheduleAtColumn,
    columns,
    environment: createPredicateEnvironment({ columns, table, displayName }),
    hasVectorColumns,
    physOrder: Object.freeze(physOrder),
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
        index["columns"].some((column) =>
          typeof column !== "string" || !Object.hasOwn(storedColumns, column)
        ) ||
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

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!storedRecord(value)) return value;
  const normalized = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value).sort()) normalized[key] = canonicalJson(value[key]);
  return normalized;
}

/** Canonical Plugin inventory representation: validated JSON with recursively sorted object keys. */
export function normalizePluginSnapshot(snapshot: SchemaSnapshot): NormalizedPluginSnapshot {
  const encoded = canonicalSnapshotJson(snapshot);
  return Object.freeze({ snapshot: parseStoredSnapshot(encoded), encoded });
}

function verifyPluginSnapshotShape(mount: string, snapshot: SchemaSnapshot): void {
  for (const [tableName, table] of Object.entries(snapshot.tables)) {
    if (table.kind === "event") {
      throw new CorruptDatabaseError(
        `stored Plugin "${mount}" schema contains event table ${tableName}`,
      );
    }
    if (Object.values(table.columns).some((descriptor) => descriptor["k"] === "scheduleAt")) {
      throw new CorruptDatabaseError(
        `stored Plugin "${mount}" schema contains scheduled table ${tableName}`,
      );
    }
  }
}

/** Load and fully validate the persisted Plugin inventory in deterministic mount order. */
export function readStoredPluginInventory(
  connection: Database,
): ReadonlyMap<string, StoredPluginStorage> {
  const inventory = new Map<string, StoredPluginStorage>();
  const rows = connection
    .query("SELECT mount, definition_identity, schema FROM _ackerdb_plugins ORDER BY mount")
    .all() as { mount: unknown; definition_identity: unknown; schema: unknown }[];
  for (const row of rows) {
    if (typeof row.mount !== "string" || !isPluginIdentifier(row.mount)) {
      throw new CorruptDatabaseError("stored Plugin inventory contains an invalid mount");
    }
    if (
      typeof row.definition_identity !== "string" ||
      !isPluginDefinitionId(row.definition_identity)
    ) {
      throw new CorruptDatabaseError(
        `stored Plugin "${row.mount}" has an invalid definition identity`,
      );
    }
    if (typeof row.schema !== "string") {
      throw new CorruptDatabaseError(`stored Plugin "${row.mount}" schema is not text`);
    }
    const parsed = parseStoredSnapshot(row.schema);
    const normalized = normalizePluginSnapshot(parsed);
    if (row.schema !== normalized.encoded) {
      throw new CorruptDatabaseError(
        `stored Plugin "${row.mount}" schema snapshot is not normalized`,
      );
    }
    verifyPluginSnapshotShape(row.mount, normalized.snapshot);
    inventory.set(row.mount, Object.freeze({
      mount: row.mount,
      definitionId: row.definition_identity,
      snapshot: normalized.snapshot,
      encodedSnapshot: normalized.encoded,
    }));
  }
  return inventory;
}

export interface StorageLayoutPlugin {
  readonly mount: string;
  readonly definitionId: string;
  readonly schema: SchemaSnapshot;
}

/** Hash one complete logical storage layout without consulting or mutating an Engine. */
export function storageLayoutFingerprint(
  root: SchemaSnapshot,
  plugins: readonly StorageLayoutPlugin[],
): string {
  const sortedPlugins = [...plugins].sort((left, right) => compareCodeUnits(left.mount, right.mount));
  return createHash("sha256")
    .update(JSON.stringify(canonicalJson({ root, plugins: sortedPlugins })))
    .digest("hex");
}

function persistedLayoutFingerprint(connection: Database): string {
  const storedRoot = connection
    .query("SELECT value FROM _ackerdb_meta WHERE key = 'schema'")
    .get() as { value: string } | null;
  if (storedRoot === null) throw new CorruptDatabaseError("artifact is missing its schema snapshot");
  const root = parseStoredSnapshot(storedRoot.value);
  const plugins = [...readStoredPluginInventory(connection).values()].map((plugin) => ({
    mount: plugin.mount,
    definitionId: plugin.definitionId,
    schema: plugin.snapshot,
  }));
  return storageLayoutFingerprint(root, plugins);
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
    if (kind !== "enum" && kind !== "union") return;
    const name = storedName(descriptor["name"], "named type");
    const variants = kind === "enum"
      ? descriptor["values"]
      : storedRecord(descriptor["members"])
        ? Object.keys(descriptor["members"])
        : null;
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
    if (kind === "union") {
      for (const member of Object.values(descriptor["members"] as Record<string, Descriptor>)) visit(member);
    }
  };
  for (const table of Object.values(snapshot.tables)) {
    for (const descriptor of Object.values(table.columns)) visit(descriptor);
  }
  return definitions;
}

function expectedApplicationObjects(
  snapshot: SchemaSnapshot,
  physicalTableName: (logicalName: string) => string = (logicalName) => logicalName,
  displayTableName: (logicalName: string) => string = (logicalName) => logicalName,
): StoredObject[] {
  const objects: StoredObject[] = [];
  for (const [tableName, table] of Object.entries(snapshot.tables)) {
    if (table.kind === "event") continue;
    const physicalName = physicalTableName(tableName);
    const displayName = displayTableName(tableName);
    const columns = Object.entries(table.columns).flatMap(([column, descriptor]) =>
      physicalColumnDdl(column, descriptor, `${displayName}.${column}`),
    );
    objects.push({
      type: "table",
      name: physicalName,
      table: physicalName,
      sql: `CREATE TABLE ${quote(physicalName)} (${columns.join(", ")})`,
    });
    for (const index of table.indexes) {
      const name = indexSqlName(physicalName, index.name);
      objects.push({
        type: "index",
        name,
        table: physicalName,
        sql: `CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${quote(name)} ON ${quote(physicalName)} (${index.columns.map(quote).join(", ")})`,
      });
    }
    const scheduleAt = Object.entries(table.columns).find(([, descriptor]) => descriptor["k"] === "scheduleAt")?.[0];
    if (scheduleAt !== undefined) {
      const name = `ix__sched_${physicalName}`;
      objects.push({
        type: "index",
        name,
        table: physicalName,
        sql: `CREATE INDEX ${quote(name)} ON ${quote(physicalName)} (${quote(scheduleAt)})`,
      });
    }
    const primaryKey = Object.entries(table.columns)
      .find(([, descriptor]) => descriptor["k"] === "pk")![0];
    for (const column of table.fullText) {
      objects.push(
        ...fullTextCatalogObjects(
          physicalName,
          primaryKey,
          fullTextTargetPlan(physicalName, column),
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
  connection.exec("BEGIN IMMEDIATE");
  try {
    connection.exec(INTERNAL_OBJECTS.map((object) => object.sql).join(";"));
    connection
      .query("INSERT INTO _ackerdb_meta (key, value) VALUES ('engine_schema', ?)")
      .run(String(ENGINE_SCHEMA_VERSION));
    connection
      .query("INSERT INTO _ackerdb_state (singleton, commit_version, mutation_sequence, clean_shutdown, mutation_records, mutation_result_bytes, last_checkpoint_at) VALUES (1, 0, 0, 1, 0, 0, NULL)")
      .run();
    connection.exec("COMMIT");
  } catch (error) {
    try {
      connection.exec("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "database internal initialization and rollback both failed",
      );
    }
    throw error;
  }
}

function removeStaleInitializationArtifacts(path: string): void {
  const stale = initializationArtifactPaths(path);
  if (stale.length === 0) return;
  for (const artifact of stale) rmSync(artifact, { force: true });
  fsyncPath(dirname(path));
}

function removeRestoreArtifacts(path: string): boolean {
  const artifacts = restoreArtifactPaths(path);
  for (const artifact of artifacts) rmSync(artifact, { force: true });
  if (artifacts.length > 0) fsyncPath(dirname(path));
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
    fsyncPath(stagingPath);
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
      fsyncPath(directory);
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
      fsyncPath(directory);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (failed) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [failure, ...cleanupErrors],
        `database initialization and staging cleanup both failed: ${path}`,
      );
    }
    throw failure;
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

function fsyncPath(path: string): void {
  const fd = openSync(path, "r");
  let failed = false;
  let failure: unknown;
  try {
    fsyncSync(fd);
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    closeSync(fd);
  } catch (closeError) {
    if (failed) throw new AggregateError([failure, closeError], `fsync and descriptor close both failed: ${path}`);
    throw closeError;
  }
  if (failed) throw failure;
}

function runWithCleanup<T>(
  work: () => T,
  cleanup: () => void,
  message: string,
): T {
  let failed = false;
  let failure: unknown;
  let value: T | undefined;
  try {
    value = work();
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    cleanup();
  } catch (cleanupError) {
    if (failed) throw new AggregateError([failure, cleanupError], message);
    throw cleanupError;
  }
  if (failed) throw failure;
  return value!;
}

/** Roll back an open SQLite transaction without losing the failure that required it. */
export function rollbackAfterFailure(
  connection: Database,
  primary: unknown,
  message: string,
): never {
  if (!connection.inTransaction) throw primary;
  try {
    connection.exec("ROLLBACK");
  } catch (rollbackError) {
    throw new AggregateError([primary, rollbackError], message);
  }
  throw primary;
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
      schemaFingerprint: persistedLayoutFingerprint(db),
      commitVersion: mutationReplay.commitVersion,
    };
  }, () => db.close(false), `backup inspection and SQLite close both failed: ${path}`);
}

function restoreArtifact(source: string, destination: string, manifest: BackupManifest): void {
  if (existsSync(destination)) throw new Error(`restore destination already exists: ${destination}`);
  const bytes = statSync(source).size;
  const sha256 = createHash("sha256").update(readFileSync(source)).digest("hex");
  if (bytes !== manifest.bytes || sha256 !== manifest.sha256) {
    throw new CorruptDatabaseError("backup artifact does not match its manifest");
  }
  mkdirSync(dirname(destination), { recursive: true });
  let copied = false;
  try {
    copyFileSync(source, destination, fsConstants.COPYFILE_EXCL);
    copied = true;
    fsyncPath(destination);
    const inspected = inspectArtifact(destination);
    if (inspected.commitVersion !== manifest.commitVersion) {
      throw new CorruptDatabaseError("restored commit version does not match the manifest");
    }
    if (inspected.schemaFingerprint !== manifest.schemaFingerprint) {
      throw new CorruptDatabaseError("restored schema does not match the manifest");
    }
  } catch (error) {
    if (copied) {
      try {
        rmSync(destination, { force: true });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `restore artifact validation and staging cleanup both failed: ${destination}`,
        );
      }
    }
    throw error;
  }
}

export class Engine {
  readonly schema: Schema;
  readonly writer: Database;
  readonly reader: Database;
  readonly [mutationReplayOwner]: MutationReplayLedger;
  readonly [credentialVaultOwner]: CredentialVault;
  readonly path: string;
  readonly durability: DurabilityPolicy;
  /** Maximum bind parameters accepted by one statement in the active SQLite library. */
  readonly sqliteParameterLimit: number;
  readonly recoveredFromCrash: boolean;
  readonly tags = new Map<string, TagMap>();
  readonly rootScope: StorageScope;
  /** The application's root physical plans. Plugin plans live on their own StorageScope. */
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
      this[credentialVaultOwner] = new CredentialVault(writer);
      // The root scope plans straight into the Engine's own tag store: it is
      // the application's own schema, so there is no consent step to wait for.
      this.rootScope = this.buildStorageScope(null, schema, this.tags);
      this.plans = this.rootScope.plans;
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
      throw cleanup.length === 0
        ? failure
        : new AggregateError([failure, ...cleanup], `database open and cleanup both failed: ${databasePath}`);
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
      try {
        reader.close(false);
      } catch (closeError) {
        throw new AggregateError(
          [error, closeError],
          `database reader initialization and close both failed: ${this.path}`,
        );
      }
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
      if (cleanup.length > 0) {
        throw new AggregateError(
          [failure, ...cleanup],
          `database validation and temporary cleanup both failed: ${path}`,
        );
      }
      throw failure;
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
    // and must agree with `sqlite_master`, the Plugin inventory and the interned
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
        !object.name.startsWith(PLUGIN_TABLE_PREFIX) &&
        !object.name.startsWith(PLUGIN_INDEX_PREFIX) &&
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
    const invalidIdentity = connection
      .query(
        "SELECT 1 FROM _ackerdb_identities WHERE typeof(identity) <> 'integer' OR identity <= 0 LIMIT 1",
      )
      .get();
    const invalidAccount = connection
      .query(
        "SELECT 1 FROM _ackerdb_identity_accounts WHERE typeof(issuer) <> 'text' OR length(issuer) = 0 OR typeof(subject) <> 'text' OR length(subject) = 0 OR typeof(identity) <> 'integer' OR identity <= 0 LIMIT 1",
      )
      .get();
    if (invalidIdentity !== null || invalidAccount !== null) {
      throw new CorruptDatabaseError("AckerDB identity directory is invalid");
    }
    const invalidMigration = connection
      .query(
        "SELECT 1 FROM _ackerdb_migrations WHERE typeof(number) <> 'integer' OR number <= 0 OR typeof(name) <> 'text' OR length(name) = 0 OR typeof(identity) <> 'text' OR length(identity) <> 64 OR typeof(applied_at) NOT IN ('integer', 'real') LIMIT 1",
      )
      .get();
    if (invalidMigration !== null) throw new CorruptDatabaseError("AckerDB migration history is invalid");
    verifyCredentialVaultState(connection);
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

  /** Look up one exact external account on any Engine-owned connection. */
  identityForAccount(connection: Database, issuer: string, subject: string): Identity | null {
    const account = connection
      .query("SELECT identity FROM _ackerdb_identity_accounts WHERE issuer = ? AND subject = ?")
      .get(issuer, subject) as { identity: bigint } | null;
    return account === null ? null : account.identity as Identity;
  }

  /**
   * Every external account one Identity answers to, read through the identity
   * index. It is the inverse of {@link identityForAccount}, and it is how a
   * delegated credential learns which upstream accounts bound its authority —
   * an invalidation names an account, never an Identity.
   */
  accountsForIdentity(connection: Database, identity: Identity): readonly ExternalAccount[] {
    return connection
      .query("SELECT issuer, subject FROM _ackerdb_identity_accounts WHERE identity = ?")
      .all(identity) as ExternalAccount[];
  }

  /** Resolve or provision one exact account. The caller must own the writer transaction. */
  resolveIdentity(issuer: string, subject: string): Identity {
    const existing = this.identityForAccount(this.writer, issuer, subject);
    if (existing !== null) return existing;

    const created = this.writer
      .query("INSERT INTO _ackerdb_identities DEFAULT VALUES RETURNING identity")
      .get() as { identity: bigint };
    this.writer
      .query("INSERT INTO _ackerdb_identity_accounts (issuer, subject, identity) VALUES (?, ?, ?)")
      .run(issuer, subject, created.identity);
    return created.identity as Identity;
  }

  /** Attach one exact account inside the caller-owned writer transaction. */
  attachIdentityAccount(identity: Identity, issuer: string, subject: string): boolean {
    const existing = this.identityForAccount(this.writer, issuer, subject);
    if (existing !== null) return existing === identity;
    this.writer
      .query("INSERT INTO _ackerdb_identity_accounts (issuer, subject, identity) VALUES (?, ?, ?)")
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
      .query(`DELETE FROM _ackerdb_identity_accounts
        WHERE issuer = ? AND subject = ? AND identity = ?
          AND 1 < (SELECT COUNT(*) FROM _ackerdb_identity_accounts WHERE identity = ?)`)
      .run(issuer, subject, identity, identity);
    return removed.changes === 1 ? "removed" : "last_account";
  }

  schemaFingerprint(): string {
    return persistedLayoutFingerprint(this.writer);
  }

  /**
   * Assign stable tags to every named enum/union variant in one storage scope,
   * into `tags`. Reads `_ackerdb_tags` but never writes it — the assignment is a
   * plan until `persistTags` commits it, so planning a scope the caller may yet
   * refuse costs nothing durable.
   */
  private internTags(
    schema: Schema,
    tagIdentity: StorageScope["tagIdentity"],
    tags: Map<string, TagMap>,
  ): void {
    const select = this.writer.query("SELECT variant, tag FROM _ackerdb_tags WHERE type = ?");
    for (const [typeName, validator] of schema.namedTypes) {
      const identity = tagIdentity(typeName);
      const variants =
        validator.kind === "enum"
          ? [...(validator as unknown as { values: readonly string[] }).values]
          : Object.keys((validator as unknown as { members: Record<string, unknown> }).members);
      const map: TagMap = { toTag: new Map(), toName: new Map() };
      let max = -1;
      for (const row of select.all(identity) as { variant: string; tag: bigint }[]) {
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
      tags.set(identity, map);
    }
  }

  /**
   * Re-derive every in-memory tag map from `_ackerdb_tags` + the live schema. Run
   * after a migration relabels variants (`UPDATE _ackerdb_tags`) so the renamed-to
   * variant resolves to its original tag instead of the speculative one the
   * constructor assigned; column plans read `this.tags` lazily, so they pick the
   * rebuilt maps up on their next encode.
   */
  reinternTags(scope: StorageScope = this.rootScope): void {
    for (const typeName of scope.schema.namedTypes.keys()) {
      this.tags.delete(scope.tagIdentity(typeName));
    }
    this.internTags(scope.schema, scope.tagIdentity, this.tags);
  }

  /** Persist one scope's tag plan. The caller owns the schema transaction. */
  persistTags(scope: StorageScope = this.rootScope): void {
    const insert = this.writer.query(
      "INSERT INTO _ackerdb_tags (type, variant, tag) VALUES (?, ?, ?) ON CONFLICT(type, variant) DO NOTHING",
    );
    for (const typeName of scope.schema.namedTypes.keys()) {
      const identity = scope.tagIdentity(typeName);
      for (const [variant, tag] of scope.tags.get(identity)!.toTag) insert.run(identity, variant, tag);
    }
  }

  private enableFullTextForScope(scope: StorageScope): void {
    if (![...scope.plans.values()].some((plan) => plan.fullText.length > 0)) return;
    this.enableFullTextSupport();
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
    try {
      // Literal queries are bounded to 257 tokenizer rows. Keep any native
      // ORDER BY scratch state in memory so query construction never creates
      // transient filesystem storage.
      tokenizer.exec("PRAGMA temp_store = MEMORY");
      installFullTextSupport(tokenizer);
      this.fullTextTokenizer = tokenizer;
    } catch (error) {
      try {
        tokenizer.close(false);
      } catch (closeError) {
        throw new AggregateError(
          [error, closeError],
          "full-text capability initialization and cleanup both failed",
        );
      }
      throw error;
    }
  }

  prepareFullTextLiteral(
    input: unknown,
    path = "fullText",
  ): string | null {
    this.enableFullTextSupport();
    return prepareLiteralFullTextQuery(this.fullTextTokenizer!, input, path);
  }

  /**
   * Plan one mounted Plugin schema's private SQLite storage. Pure with respect
   * to the Engine: it reads `_ackerdb_tags` and builds plans, but publishes no
   * tags and initializes no capabilities, so a mount that reconciliation ends up
   * refusing for want of consent leaves nothing behind. `activateScope` is the
   * commit-time other half.
   */
  planPluginScope(mount: string, schema: Schema): StorageScope {
    if (typeof mount !== "string" || !isPluginIdentifier(mount)) {
      throw new ValidationError("Plugin storage mount must be an identifier");
    }
    return this.buildStorageScope(mount, schema, new Map());
  }

  /**
   * Publish a planned scope's tags to the Engine and initialize the capabilities
   * its tables need. Call once the scope is accepted — after consent and inside
   * (or immediately before) the transaction that commits it.
   */
  activateScope(scope: StorageScope): void {
    loadVectorRuntimeForSchema(scope.schema);
    for (const [identity, map] of scope.tags) this.tags.set(identity, map);
    this.enableFullTextForScope(scope);
  }

  /** Plan and immediately activate one mounted Plugin schema. */
  createPluginScope(mount: string, schema: Schema): StorageScope {
    const scope = this.planPluginScope(mount, schema);
    this.activateScope(scope);
    return scope;
  }

  /** Resolve the scope-aware tag map used by one table plan. */
  tagMap(plan: TablePlan, typeName: string): TagMap {
    return this.tags.get(plan.tagIdentity(typeName))!;
  }

  private buildStorageScope(
    mount: string | null,
    schema: Schema,
    tags: Map<string, TagMap>,
  ): StorageScope {
    const tagIdentity: StorageScope["tagIdentity"] = mount === null
      ? (typeName) => typeName
      : (typeName) => pluginTagIdentity(mount, typeName);
    if (mount !== null) {
      for (const [logicalName, table] of Object.entries(schema.tables)) {
        const displayName = `${mount}.${logicalName}`;
        if (table.kind === "event") {
          throw new ValidationError(`${displayName}: Plugin private schemas cannot contain event tables`);
        }
        if (table.scheduleAtColumn !== null) {
          throw new ValidationError(`${displayName}: Plugin private schemas cannot contain scheduled tables`);
        }
      }
    }
    this.internTags(schema, tagIdentity, tags);
    // Lazy by construction: the root scope's store IS `this.tags`, so when a
    // migration relabels variants `reinternTags` replaces the map these plans
    // encode through. A planned Plugin scope reads its own store, which
    // activation then publishes.
    const tagsOf: TagsOf = (typeName) => tags.get(tagIdentity(typeName))!;
    const plans = new Map<string, TablePlan>();
    for (const [logicalName, table] of Object.entries(schema.tables)) {
      if (table.kind === "event") continue;
      const physicalName = mount === null
        ? logicalName
        : pluginPhysicalTableName(mount, logicalName);
      const displayName = mount === null ? logicalName : `${mount}.${logicalName}`;
      plans.set(
        logicalName,
        planTable(table, logicalName, physicalName, displayName, tagIdentity, tagsOf),
      );
    }
    const scope: StorageScope = {
      mount,
      schema,
      plans,
      tags,
      tagIdentity,
      plan(logicalName) {
        const plan = plans.get(logicalName);
        if (plan === undefined) {
          const displayName = mount === null ? logicalName : `${mount}.${logicalName}`;
          throw new Error(`unknown table "${displayName}"`);
        }
        return plan;
      },
    };
    return Object.freeze(scope);
  }

  // -- DDL -------------------------------------------------------------------

  createTableDdl(plan: PhysicalTablePlan, nameOverride?: string, extraColumnDdls: string[] = []): string {
    const cols: string[] = [];
    for (const column of plan.columns.values()) {
      for (const phys of column.phys) cols.push(phys.ddl);
    }
    cols.push(...extraColumnDdls); // rebuilds append carried columns absent from the plan
    return `CREATE TABLE IF NOT EXISTS ${quote(nameOverride ?? plan.name)} (${cols.join(", ")})`;
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
        `CREATE INDEX IF NOT EXISTS ${quote(`ix__sched_${plan.name}`)} ON ${quote(plan.name)} (${quote(plan.scheduleAt)})`,
      );
    }
  }

  indexDdl(plan: PhysicalTablePlan, index: IndexDef): string {
    const unique = index.unique ? "UNIQUE " : "";
    const cols = index.columns.map((c) => quote(c)).join(", ");
    return `CREATE ${unique}INDEX IF NOT EXISTS ${quote(indexSqlName(plan.name, index.name))} ON ${quote(plan.name)} (${cols})`;
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
    this.writer.exec("BEGIN IMMEDIATE");
    try {
      this.persistTags();
      for (const plan of this.plans.values()) this.createTablePhysical(plan);
      this.saveSnapshot(snapshotOf(this.schema));
      this.writer.exec("COMMIT");
    } catch (error) {
      rollbackAfterFailure(
        this.writer,
        error,
        "database schema creation and rollback both failed",
      );
    }
  }

  // -- Meta ------------------------------------------------------------------

  loadSnapshot(connection: Database = this.writer): SchemaSnapshot | null {
    const row = connection.query("SELECT value FROM _ackerdb_meta WHERE key = 'schema'").get() as
      | { value: string }
      | null;
    const snapshot = row === null ? null : parseStoredSnapshot(row.value);
    const plugins = readStoredPluginInventory(connection);
    this.verifyApplicationSchema(snapshot, plugins, connection);
    this.verifySnapshotTags(snapshot, plugins, connection);
    return snapshot;
  }

  private verifyApplicationSchema(
    snapshot: SchemaSnapshot | null,
    plugins: ReadonlyMap<string, StoredPluginStorage>,
    connection: Database,
  ): void {
    const actual = connection
      .query("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
      .all() as { type: string; name: string; tbl_name: string; sql: string | null }[];
    const pluginObjects = [...plugins.values()].flatMap((plugin) =>
      expectedApplicationObjects(
        plugin.snapshot,
        (table) => pluginPhysicalTableName(plugin.mount, table),
        (table) => `${plugin.mount}.${table}`,
      )
    );
    const expected = new Map(
      [
        ...INTERNAL_OBJECTS,
        ...(snapshot === null ? [] : expectedApplicationObjects(snapshot)),
        ...pluginObjects,
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
    plugins: ReadonlyMap<string, StoredPluginStorage>,
    connection: Database,
  ): void {
    const rootDefinitions: ReadonlyMap<string, StoredNamedDefinition> = snapshot === null
      ? new Map()
      : namedDefinitionsOf(snapshot);
    const pluginDefinitions = new Map<string, StoredNamedDefinition>();
    for (const plugin of plugins.values()) {
      for (const [typeName, definition] of namedDefinitionsOf(plugin.snapshot)) {
        pluginDefinitions.set(pluginTagIdentity(plugin.mount, typeName), definition);
      }
    }
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
    for (const [identity, definition] of pluginDefinitions) {
      const variants = stored.get(identity);
      const missing = definition.variants.find((variant) => !variants?.has(variant));
      if (missing !== undefined) {
        throw new CorruptDatabaseError(`AckerDB tag assignment is missing ${identity}.${missing}`);
      }
      if (variants!.size !== definition.variants.length) {
        throw new CorruptDatabaseError(`AckerDB Plugin tag assignment ${identity} has unknown variants`);
      }
    }
    const unknownPluginTag = [...stored.keys()].find(
      (identity) => !STORED_NAME.test(identity) && !pluginDefinitions.has(identity),
    );
    if (unknownPluginTag !== undefined) {
      throw new CorruptDatabaseError(`AckerDB tag assignment has unknown Plugin identity ${unknownPluginTag}`);
    }
  }

  saveSnapshot(snapshot: SchemaSnapshot): void {
    this.writer
      .query("INSERT INTO _ackerdb_meta (key, value) VALUES ('schema', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(snapshot));
  }

  // -- Row codec + basic CRUD (ctx.db composes richer queries on top) --------

  plan(table: string): TablePlan {
    return this.rootScope.plan(table);
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
      fsyncPath(temporary);
      const inspected = inspectArtifact(temporary);
      if (inspected.schemaFingerprint !== this.schemaFingerprint()) {
        throw new CorruptDatabaseError("backup schema fingerprint does not match the running schema");
      }
      renameSync(temporary, destination);
      published = true;
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
    try {
      const restoreArtifacts = new Set(
        restoreArtifactPaths(database).map((artifact) => basename(artifact)),
      );
      assertRestoreTargetFresh(database, restoreArtifacts, allowedTargetSubtrees);
      removeRestoreArtifacts(database);
      return new DatabaseRestoreTarget(database, ownership, allowedTargetSubtrees);
    } catch (error) {
      try {
        ownership.release();
      } catch (releaseError) {
        throw new AggregateError(
          [error, releaseError],
          `restore target acquisition and ownership cleanup both failed: ${database}`,
        );
      }
      throw error;
    }
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
    fsyncPath(this.stagingPath);
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
      fsyncPath(dirname(this.path));
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
  let transactionOpen = false;
  try {
    engine.writer.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    const next = engine.allocateCommitVersion();
    if (next !== terminal + 1n) {
      throw new Error(`next commit version was ${next}; expected ${terminal + 1n}`);
    }
    engine.writer.exec("ROLLBACK");
    transactionOpen = false;

    engine.writer.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    engine.writer
      .query("UPDATE _ackerdb_state SET commit_version = commit_version WHERE singleton = 1")
      .run();
    engine.writer.exec("COMMIT");
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) {
      try {
        engine.writer.exec("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "restore commit probe and rollback both failed",
        );
      }
    }
    throw error;
  }
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
    let verificationFailed = false;
    let verificationFailure: unknown;
    try {
      if (engine.schemaFingerprint() !== manifest.schemaFingerprint) {
        throw new CorruptDatabaseError("restore staging layout does not match the manifest");
      }
      status = engine.status();
      if (status.commitVersion !== manifest.commitVersion) {
        throw new CorruptDatabaseError("restore staging commit version does not match the manifest");
      }
      proveRestoredNextCommit(engine);
      await publication?.prepareStagedDatabase?.(engine);
    } catch (error) {
      verificationFailed = true;
      verificationFailure = error;
    }
    try {
      engine.close("clean");
    } catch (closeError) {
      if (verificationFailed) {
        throw new AggregateError(
          [verificationFailure, closeError],
          `restore staging verification and database close both failed: ${target}`,
        );
      }
      throw closeError;
    }
    if (verificationFailed) throw verificationFailure;
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
