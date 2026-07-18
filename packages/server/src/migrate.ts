/**
 * Migration application: the answer to a reconcile refusal. User code
 * *computes* — old row in, new row (or `null`, or emits) out — and this engine
 * owns every write: ids, iteration, the rebuild, the transaction, final
 * validation. A migration declares one entry per table that changed shape:
 *
 *   - a transform on a surviving table (refused, or volunteered to backfill) —
 *     the table is rebuilt from its new plan and every old row is replayed
 *     through the transform, preserving its primary key;
 *   - `null` on a dropped table — the drop acknowledgment: its data goes nowhere;
 *   - a transform on a dropped table — a salvage: the return is ignored, the
 *     transform runs only for its `ctx.insert` emits, then the table is dropped.
 *
 * Every write happens in the reconcile's single transaction. Transforms see
 * only the frozen before-state (old tables stay physically intact until every
 * transform has finished), decode through the OLD snapshot's descriptors and
 * historical tags, and never observe each other's output or emits. Any error
 * rolls the whole step back, byte-identical.
 */
import type { Database } from "bun:sqlite";
import { decode } from "@dbzz/core";
import { ValidationError, type Descriptor } from "./dbz.ts";
import type { Engine, TablePlan } from "./engine.ts";
import { classifySchemaDiff, type SchemaRefusal } from "./schema-classify.ts";
import { unwrapDesc, type SchemaDiff } from "./schema-diff.ts";
import type { SchemaSnapshot, TableSnapshot } from "./snapshot.ts";
import { applySafe, probeOptimistic, UnsafeSchemaChange, type Op } from "./reconcile.ts";

const quote = (name: string) => `"${name}"`;

export type MigrationRow = Record<string, unknown>;

/** Read-only view of one OLD table for cross-table lookups inside a transform. */
export interface BeforeTable {
  get(id: bigint): Promise<MigrationRow | null>;
  scan(): AsyncIterableIterator<MigrationRow>;
}

export interface MigrationContext {
  /** The frozen before-state, keyed by old table name. */
  readonly before: Record<string, BeforeTable>;
  /** Emit a row into any table of the NEW schema; its pk is engine-assigned. */
  insert(table: string, row: MigrationRow): void;
}

/**
 * A per-table row transform. On a surviving table the return is the new row
 * (pk stripped and re-applied by the engine), `null` deletes the row, and
 * `undefined` keeps the row it was handed. On a dropped table the return is
 * ignored — only the emits matter.
 */
export type RowTransform = (
  row: MigrationRow,
  ctx: MigrationContext,
) => MigrationRow | null | void | Promise<MigrationRow | null | void>;

export interface Migration {
  tables: Record<string, RowTransform | null>;
}

export class MigrationError extends Error {}

export function defineMigration(migration: Migration): Migration {
  if (
    migration === null ||
    typeof migration !== "object" ||
    typeof migration.tables !== "object" ||
    migration.tables === null
  ) {
    throw new MigrationError("defineMigration expects { tables: { ... } }");
  }
  for (const [name, value] of Object.entries(migration.tables)) {
    if (value !== null && typeof value !== "function") {
      throw new MigrationError(`migration entry for "${name}" must be a transform function or null`);
    }
  }
  return migration;
}

/**
 * Apply a migration against a refusing diff, in one transaction. Validation
 * runs first and touches nothing; the transaction then persists new tags,
 * applies the safe ops the migration does not own (creates first, so emits
 * into new tables land), replays every transform against the before-state,
 * swaps rebuilt tables in and drops acknowledged ones, and commits.
 */
export async function applyMigration(
  engine: Engine,
  target: SchemaSnapshot,
  current: SchemaSnapshot,
  diff: SchemaDiff,
  migration: Migration,
): Promise<{ applied: string[] }> {
  const writer = engine.writer;
  const { safe, optimistic, refusals } = classifySchemaDiff(diff);
  validateEntries(engine, current, refusals, migration);

  // A surviving table with an entry is rebuilt from its new plan; a table the
  // schema no longer keeps is dropped (after an optional salvage transform).
  const rebuilt = new Set<string>();
  const dropped = new Set<string>();
  for (const name of Object.keys(migration.tables)) {
    (engine.plans.has(name) ? rebuilt : dropped).add(name);
  }

  // Plan the safe/optimistic work for tables the migration does NOT own — a
  // rebuilt table's classified ops are absorbed by its rebuild, never doubled.
  const ops: Op[] = [];
  const applied: string[] = [];
  const probeRefusals: SchemaRefusal[] = [];
  const count = (sql: string, ...params: unknown[]): number =>
    Number((writer.query(sql).get(...(params as never[])) as { n: bigint }).n);
  for (const change of safe) if (!rebuilt.has(change.table)) applySafe(engine, change, current, ops, applied);
  for (const opt of optimistic) {
    if (!rebuilt.has(opt.table)) probeOptimistic(engine, opt, current, count, ops, applied, probeRefusals);
  }
  if (probeRefusals.length > 0) throw new UnsafeSchemaChange(probeRefusals);

  const oldTags = loadOldTags(writer);

  writer.exec("BEGIN IMMEDIATE");
  try {
    engine.persistTags();
    for (const op of ops) op();
    const tmpOf = await runTransforms(engine, current, migration, rebuilt, dropped, oldTags);
    for (const name of [...rebuilt].sort()) {
      writer.exec(`DROP TABLE ${quote(name)}`);
      writer.exec(`ALTER TABLE ${quote(tmpOf.get(name)!)} RENAME TO ${quote(name)}`);
      engine.createIndexesPhysical(engine.plan(name)); // a unique index over bad output fails here
      applied.push(`migrated table ${name}`);
    }
    for (const name of [...dropped].sort()) {
      writer.exec(`DROP TABLE ${quote(name)}`);
      applied.push(`dropped table ${name}`);
    }
    engine.saveSnapshot(target);
    writer.exec("COMMIT");
  } catch (error) {
    writer.exec("ROLLBACK");
    throw error;
  }
  return { applied };
}

/** Reject a migration that fails to answer the diff, before anything is touched. */
function validateEntries(
  engine: Engine,
  current: SchemaSnapshot,
  refusals: SchemaRefusal[],
  migration: Migration,
): void {
  const entries = migration.tables;
  const missing = [...new Set(refusals.map((r) => r.table))].filter((t) => !(t in entries)).sort();
  if (missing.length > 0) {
    throw new MigrationError(`migration is missing a transform for refused table(s): ${missing.join(", ")}`);
  }
  for (const [name, value] of Object.entries(entries)) {
    const surviving = engine.plans.has(name);
    if (surviving) {
      if (value === null) {
        throw new MigrationError(`migration entry for "${name}" is null, but "${name}" still exists in the schema`);
      }
    } else if (current.tables[name]?.kind !== "table") {
      throw new MigrationError(`migration references unknown table "${name}"`);
    }
  }
}

/**
 * Run every transform against the before-state and return the temporary
 * physical name of each rebuilt table. Rebuilt tables are materialized empty
 * first (with their sequence seeded so emitted ids never collide with or reuse
 * a preserved one); old tables are only read, never modified, so transforms
 * observe a single frozen image regardless of order.
 */
async function runTransforms(
  engine: Engine,
  current: SchemaSnapshot,
  migration: Migration,
  rebuilt: Set<string>,
  dropped: Set<string>,
  oldTags: OldTags,
): Promise<Map<string, string>> {
  const writer = engine.writer;
  const tmpOf = new Map<string, string>();
  for (const name of [...rebuilt].sort()) {
    const tmp = `${name}__migrate`;
    tmpOf.set(name, tmp);
    writer.exec(engine.createTableDdl(engine.plan(name), tmp));
    const seq = writer.query("SELECT seq FROM sqlite_sequence WHERE name = ?").get(name) as { seq: bigint } | null;
    if (seq !== null) writer.query("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)").run(tmp, seq.seq);
  }
  const physicalOf = (table: string): string => tmpOf.get(table) ?? table;

  const ctx: MigrationContext = {
    before: buildBefore(engine, current, oldTags),
    insert(table, row) {
      if (!engine.plans.has(table)) throw new ValidationError(`migration insert: unknown table "${table}"`);
      const plan = engine.plan(table);
      physicalInsert(engine, plan, physicalOf(table), checkRow(engine, table, row, "insert"));
    },
  };

  for (const [name, fn] of Object.entries(migration.tables).sort(([a], [b]) => a.localeCompare(b))) {
    if (fn === null) continue;
    const old = buildOldTable(current.tables[name]!, oldTags);
    const rows = writer.query(`SELECT * FROM ${quote(name)} ORDER BY ${quote(old.pk)} ASC`).all() as MigrationRow[];
    if (!rebuilt.has(name)) {
      for (const raw of rows) await fn(decodeOldRow(old, raw), ctx); // salvage: emits only
      continue;
    }
    const plan = engine.plan(name);
    const tmp = tmpOf.get(name)!;
    for (const raw of rows) {
      const decoded = decodeOldRow(old, raw);
      const result = await fn(decoded, ctx);
      if (result === null) continue; // deleted
      physicalInsert(engine, plan, tmp, checkRow(engine, name, result ?? decoded, "transform"), decoded[old.pk] as bigint);
    }
  }
  return tmpOf;
}

/** Insert a validated row into `physicalName`; a supplied `pk` is preserved. */
function physicalInsert(
  engine: Engine,
  plan: TablePlan,
  physicalName: string,
  values: MigrationRow,
  pk?: bigint,
): void {
  const names: string[] = [];
  const params: unknown[] = [];
  if (pk !== undefined) {
    names.push(plan.pk);
    params.push(pk);
  }
  for (const column of plan.columns.values()) {
    if (column.kind === "pk") continue;
    for (const phys of column.phys) names.push(phys.name);
    params.push(...column.toSql(values[column.jsName]));
  }
  const sql = `INSERT INTO ${quote(physicalName)} (${names.map(quote).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`;
  engine.writer.query(sql).run(...(params as never[]));
}

/** Validate a transform output / emit against the NEW schema, stripping the pk. */
function checkRow(engine: Engine, table: string, row: unknown, op: string): MigrationRow {
  if (row === null || typeof row !== "object" || Array.isArray(row)) {
    throw new ValidationError(`${table}.${op}: expected a row object`);
  }
  const input = row as MigrationRow;
  const def = engine.schema.tables[table]!;
  const pk = engine.plan(table).pk;
  const out: MigrationRow = {};
  for (const [name, validator] of Object.entries(def.columns)) {
    if (name === pk) continue;
    out[name] = validator.check(input[name], `${table}.${op}.${name}`);
  }
  for (const key of Object.keys(input)) {
    if (key !== pk && !(key in def.columns) && input[key] !== undefined) {
      throw new ValidationError(`${table}.${op}: unknown field "${key}"`);
    }
  }
  return out;
}

// -- old-snapshot decoding ----------------------------------------------------

type OldTags = Map<string, Map<number, string>>;
interface OldColumn {
  col: string;
  phys: string[];
  decode: (values: unknown[]) => unknown;
}
interface OldTable {
  pk: string;
  columns: OldColumn[];
}

/**
 * Every historical (type, variant) → tag map, read straight from `_dbz_tags`.
 * The engine's live `tags` only cover types the current schema names, so a
 * type that survives only in the old snapshot (a dropped table's enum) would
 * be missing; tags are insert-only, so every variant ever stored is here.
 */
function loadOldTags(writer: Database): OldTags {
  const tags: OldTags = new Map();
  for (const row of writer.query("SELECT type, variant, tag FROM _dbz_tags").all() as {
    type: string;
    variant: string;
    tag: bigint;
  }[]) {
    let map = tags.get(row.type);
    if (map === undefined) {
      map = new Map();
      tags.set(row.type, map);
    }
    map.set(Number(row.tag), row.variant);
  }
  return tags;
}

/** Build the descriptor-driven decoder for one old table (never the live plan). */
function buildOldTable(snap: TableSnapshot, oldTags: OldTags): OldTable {
  let pk = "";
  const columns: OldColumn[] = [];
  for (const [col, desc] of Object.entries(snap.columns)) {
    if (desc["k"] === "pk") pk = col;
    columns.push(oldColumn(col, desc, oldTags));
  }
  return { pk, columns };
}

function decodeOldRow(old: OldTable, sqlRow: MigrationRow): MigrationRow {
  const row: MigrationRow = {};
  for (const c of old.columns) row[c.col] = c.decode(c.phys.map((p) => sqlRow[p]));
  return row;
}

function oldColumn(col: string, desc: Descriptor, oldTags: OldTags): OldColumn {
  const { base } = unwrapDesc(desc);
  const kind = base["k"] as string;
  if (kind === "union") {
    const typeName = base["name"] as string;
    return {
      col,
      phys: [col, `${col}__p`],
      decode: (v) =>
        v[0] === null ? null : { tag: oldTags.get(typeName)!.get(Number(v[0]))!, value: decode(v[1] as string) },
    };
  }
  if (kind === "enum") {
    const typeName = base["name"] as string;
    return { col, phys: [col], decode: (v) => (v[0] === null ? null : oldTags.get(typeName)!.get(Number(v[0]))!) };
  }
  return { col, phys: [col], decode: (v) => (v[0] === null ? null : decodeScalar(kind, v[0])) };
}

function decodeScalar(kind: string, value: unknown): unknown {
  switch (kind) {
    case "number":
    case "scheduleAt":
      return Number(value);
    case "boolean":
      return value === 1n || value === 1;
    case "array":
    case "object":
    case "jsonb":
      return decode(value as string);
    default:
      return value; // pk / string / bigint / identity / bytes round-trip as-is
  }
}

/** Read-only before-state over every old real table, decoded old-snapshot style. */
function buildBefore(engine: Engine, current: SchemaSnapshot, oldTags: OldTags): Record<string, BeforeTable> {
  const writer = engine.writer;
  const before: Record<string, BeforeTable> = {};
  for (const [name, snap] of Object.entries(current.tables)) {
    if (snap.kind !== "table") continue;
    const old = buildOldTable(snap, oldTags);
    before[name] = {
      async get(id) {
        const raw = writer
          .query(`SELECT * FROM ${quote(name)} WHERE ${quote(old.pk)} = ?`)
          .get(id as never) as MigrationRow | null;
        return raw === null ? null : decodeOldRow(old, raw);
      },
      async *scan() {
        const rows = writer.query(`SELECT * FROM ${quote(name)} ORDER BY ${quote(old.pk)} ASC`).all() as MigrationRow[];
        for (const raw of rows) yield decodeOldRow(old, raw);
      },
    };
  }
  return before;
}
