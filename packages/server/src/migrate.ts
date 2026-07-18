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
import { diffSnapshots, unwrapDesc, type SchemaDiff } from "./schema-diff.ts";
import type { SchemaSnapshot, TableSnapshot } from "./snapshot.ts";
import { applySafe, physColsOf, probeOptimistic, UnsafeSchemaChange, type Op } from "./reconcile.ts";

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

/**
 * Rename declarations: which dropped-plus-added names are the same thing
 * renamed, so data and identity carry over. `tables` maps old table name to
 * new; `columns` is keyed by the table's name in the TARGET schema; `variants`
 * is keyed by the enum/union type name. Applied to the diff first (see
 * `applyRenames`): a pure rename yields no diff, a rename with a change pairs up
 * and the normal transform machinery fires.
 */
export interface Renames {
  tables?: Record<string, string>;
  columns?: Record<string, Record<string, string>>;
  variants?: Record<string, Record<string, string>>;
}

export interface Migration {
  renames?: Renames;
  tables?: Record<string, RowTransform | null>;
}

export class MigrationError extends Error {}

export function defineMigration(migration: Migration): Migration {
  if (migration === null || typeof migration !== "object") {
    throw new MigrationError("defineMigration expects a migration object");
  }
  const tables = migration.tables;
  if (tables !== undefined) {
    if (typeof tables !== "object" || tables === null) {
      throw new MigrationError("migration tables must be an object");
    }
    for (const [name, value] of Object.entries(tables)) {
      if (value !== null && typeof value !== "function") {
        throw new MigrationError(`migration entry for "${name}" must be a transform function or null`);
      }
    }
  }
  checkRenamesShape(migration.renames);
  return migration;
}

/** Shallow shape guard for `renames`; existence/conflict checks run in `planRenames`. */
function checkRenamesShape(renames: Renames | undefined): void {
  if (renames === undefined) return;
  if (typeof renames !== "object" || renames === null) throw new MigrationError("migration renames must be an object");
  const isStringMap = (value: unknown): boolean =>
    typeof value === "object" && value !== null && Object.values(value).every((v) => typeof v === "string");
  if (renames.tables !== undefined && !isStringMap(renames.tables)) {
    throw new MigrationError("migration renames.tables must map old names to new names");
  }
  for (const key of ["columns", "variants"] as const) {
    const nested = renames[key];
    if (nested === undefined) continue;
    if (typeof nested !== "object" || nested === null || !Object.values(nested).every(isStringMap)) {
      throw new MigrationError(`migration renames.${key} must map each name to a { old: new } object`);
    }
  }
}

/**
 * Apply a migration against a refusing diff, in one transaction. Renames are a
 * pure pre-pass (`planRenames`) whose renamed-current snapshot the diff runs
 * against; validation runs next and touches nothing. The transaction then
 * relabels variant tags and re-interns, persists new tags, applies the safe ops
 * the migration does not own (creates first, so emits into new tables land),
 * replays every transform against the before-state, swaps rebuilt tables in
 * (user transforms and engine-owned identity rebuilds alike), performs the pure
 * structural renames last (so transforms still read old physical names), drops
 * acknowledged tables, and commits.
 */
export async function applyMigration(
  engine: Engine,
  target: SchemaSnapshot,
  current: SchemaSnapshot,
  migration: Migration,
): Promise<{ applied: string[] }> {
  const writer = engine.writer;
  const renames = planRenames(engine, current, target, migration);
  const diff = diffSnapshots(renames.renamedCurrent, target);
  const { safe, optimistic, refusals } = classifySchemaDiff(diff);
  const entries = migration.tables ?? {};
  validateEntries(engine, renames.renamedCurrent, refusals, entries);

  // A surviving table with an entry is rebuilt from its new plan; a table the
  // schema no longer keeps is dropped (after an optional salvage transform).
  const rebuilt = new Set<string>();
  const dropped = new Set<string>();
  for (const name of Object.keys(entries)) {
    (engine.plans.has(name) ? rebuilt : dropped).add(name);
  }

  // A renamed table with other changes cannot ALTER-rename in place. A user
  // transform rebuilds it as usual; without one its remaining changes are
  // shape-safe here (validateEntries already demanded a transform for every
  // refusal), so an engine-owned identity rebuild carries every row through the
  // rename map with no per-row JS.
  const identityRebuilt = new Set<string>();
  for (const change of diff) {
    if (renames.renamedTables.has(change.table) && !rebuilt.has(change.table)) identityRebuilt.add(change.table);
  }

  // Plan the safe/optimistic work for tables the migration does NOT own — a
  // rebuilt table's classified ops are absorbed by its rebuild, never doubled.
  const ops: Op[] = [];
  const applied: string[] = [];
  const probeRefusals: SchemaRefusal[] = [];
  const count = (sql: string, ...params: unknown[]): number =>
    Number((writer.query(sql).get(...(params as never[])) as { n: bigint }).n);
  for (const change of safe) {
    if (!rebuilt.has(change.table) && !identityRebuilt.has(change.table)) {
      applySafe(engine, change, renames.renamedCurrent, ops, applied);
    }
  }
  for (const opt of optimistic) {
    if (rebuilt.has(opt.table)) continue;
    if (identityRebuilt.has(opt.table)) {
      // The physical table still holds pre-rename names until the swap: route
      // the read-only probe through the rename map so the counted refusal
      // survives; the index itself is created from the new plan post-swap.
      const reverse = renames.columnReverse.get(opt.table);
      probeOptimistic(engine, { ...opt, viaRebuild: true }, renames.renamedCurrent, count, ops, applied, probeRefusals, {
        table: renames.tableOldName.get(opt.table) ?? opt.table,
        column: (c) => reverse?.get(c) ?? c,
      });
    } else {
      probeOptimistic(engine, opt, renames.renamedCurrent, count, ops, applied, probeRefusals);
    }
  }
  if (probeRefusals.length > 0) throw new UnsafeSchemaChange(probeRefusals);

  const oldTags = loadOldTags(writer);

  writer.exec("BEGIN IMMEDIATE");
  try {
    // Variant renames keep their interned tag: relabel _dbz_tags, then re-intern
    // so the renamed-to variant resolves to the old integer before any write.
    for (const { type, from, to } of renames.variants) {
      writer.query("UPDATE _dbz_tags SET variant = ? WHERE type = ? AND variant = ?").run(to, type, from);
      applied.push(`renamed variant ${type}.${from} to ${to}`);
    }
    if (renames.variants.length > 0) engine.reinternTags();
    engine.persistTags();
    for (const op of ops) op();
    const tmpOf = await runTransforms(engine, current, renames, entries, rebuilt, identityRebuilt, oldTags);
    for (const name of [...tmpOf.keys()].sort()) {
      writer.exec(`DROP TABLE ${quote(renames.tableOldName.get(name) ?? name)}`);
      writer.exec(`ALTER TABLE ${quote(tmpOf.get(name)!)} RENAME TO ${quote(name)}`);
      engine.createIndexesPhysical(engine.plan(name)); // a unique index over bad output fails here
      applied.push(`migrated table ${name}`);
    }
    for (const name of [...renames.renamedTables].filter((t) => !tmpOf.has(t)).sort()) {
      applyPureRename(engine, name, renames, applied);
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

/**
 * Perform a pure structural rename LAST, once every transform has read the old
 * physical names. `ALTER TABLE ... RENAME TO` rewrites the table's stored DDL
 * canonically but leaves index names stale, so a renamed table drops and
 * recreates its indexes from the new plan; `RENAME COLUMN` (both physical
 * columns of a union) canonically rewrites the table and any index it touches,
 * so a name-stable table needs no index work.
 */
function applyPureRename(engine: Engine, newTable: string, renames: RenamePlan, applied: string[]): void {
  const writer = engine.writer;
  const oldTable = renames.tableOldName.get(newTable);
  if (oldTable !== undefined) writer.exec(`ALTER TABLE ${quote(oldTable)} RENAME TO ${quote(newTable)}`);
  for (const [oldPhys, newPhys] of renames.columnPhys.get(newTable) ?? []) {
    writer.exec(`ALTER TABLE ${quote(newTable)} RENAME COLUMN ${quote(oldPhys)} TO ${quote(newPhys)}`);
  }
  if (oldTable === undefined) {
    applied.push(`renamed column(s) on ${newTable}`);
    return;
  }
  const stale = writer
    .query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name NOT LIKE 'sqlite_%'")
    .all(newTable) as { name: string }[];
  for (const ix of stale) writer.exec(`DROP INDEX ${quote(ix.name)}`);
  engine.createIndexesPhysical(engine.plan(newTable));
  applied.push(`renamed table ${oldTable} to ${newTable}`);
}

/** Reject a migration that fails to answer the diff, before anything is touched. */
function validateEntries(
  engine: Engine,
  current: SchemaSnapshot,
  refusals: SchemaRefusal[],
  entries: Record<string, RowTransform | null>,
): void {
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
 * A physical write destination for one NEW-plan table: its physical name and a
 * translator from new physical column names to the ones actually on disk. For a
 * rebuilt table that is its tmp under new names (identity); for a purely-renamed
 * table (renamed LAST) it is the still-old-named physical table and the old
 * column names, so emits during the transform phase land correctly.
 */
interface EmitTarget {
  name: string;
  translate: (col: string) => string;
}

/**
 * Run every transform against the before-state and return the temporary
 * physical name of each rebuilt table. Rebuilt tables are materialized empty
 * first (with their sequence seeded so emitted ids never collide with or reuse
 * a preserved one); old tables are only read, never modified, so transforms
 * observe a single frozen image regardless of order. A rebuilt+renamed table
 * reads its rows from its OLD physical name and old descriptors. Identity
 * rebuilds (renamed tables whose other changes are all shape-safe, no user
 * transform) are copied wholesale through the rename map before any transform
 * runs, so emits into them land in the tmp alongside the carried rows.
 */
async function runTransforms(
  engine: Engine,
  current: SchemaSnapshot,
  renames: RenamePlan,
  entries: Record<string, RowTransform | null>,
  rebuilt: Set<string>,
  identityRebuilt: Set<string>,
  oldTags: OldTags,
): Promise<Map<string, string>> {
  const writer = engine.writer;
  const tmpOf = new Map<string, string>();
  for (const name of [...rebuilt, ...identityRebuilt].sort()) {
    const oldPhys = renames.tableOldName.get(name) ?? name;
    const tmp = `${name}__migrate`;
    tmpOf.set(name, tmp);
    writer.exec(engine.createTableDdl(engine.plan(name), tmp));
    const seq = writer.query("SELECT seq FROM sqlite_sequence WHERE name = ?").get(oldPhys) as { seq: bigint } | null;
    if (seq !== null) writer.query("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)").run(tmp, seq.seq);
  }

  // Identity rebuild: one INSERT..SELECT per table, new physical columns fed
  // from their pre-rename names; columns absent from the old table are omitted
  // (new nullable columns land NULL). No per-row JS ever runs.
  for (const name of [...identityRebuilt].sort()) {
    const oldPhysName = renames.tableOldName.get(name) ?? name;
    const reverse = renames.columnReverse.get(name);
    const oldCols = physColsOf(current.tables[oldPhysName]!);
    const pairs = engine
      .plan(name)
      .physOrder.map((c) => [reverse?.get(c) ?? c, c] as const)
      .filter(([old]) => oldCols.has(old));
    writer.exec(
      `INSERT INTO ${quote(tmpOf.get(name)!)} (${pairs.map(([, c]) => quote(c)).join(", ")}) ` +
        `SELECT ${pairs.map(([old]) => quote(old)).join(", ")} FROM ${quote(oldPhysName)}`,
    );
  }
  const emitTargetOf = (table: string): EmitTarget => {
    if (tmpOf.has(table)) return { name: tmpOf.get(table)!, translate: (c) => c };
    if (!renames.renamedTables.has(table)) return { name: table, translate: (c) => c };
    const reverse = renames.columnReverse.get(table); // undefined for a table-only rename
    return { name: renames.tableOldName.get(table) ?? table, translate: (c) => reverse?.get(c) ?? c };
  };

  const ctx: MigrationContext = {
    before: buildBefore(engine, current, oldTags),
    insert(table, row) {
      if (!engine.plans.has(table)) throw new ValidationError(`migration insert: unknown table "${table}"`);
      physicalInsert(engine, engine.plan(table), emitTargetOf(table), checkRow(engine, table, row, "insert"));
    },
  };

  for (const [name, fn] of Object.entries(entries).sort(([a], [b]) => a.localeCompare(b))) {
    if (fn === null) continue;
    const oldPhys = renames.tableOldName.get(name) ?? name;
    const old = buildOldTable(current.tables[oldPhys]!, oldTags);
    const rows = writer.query(`SELECT * FROM ${quote(oldPhys)} ORDER BY ${quote(old.pk)} ASC`).all() as MigrationRow[];
    if (!rebuilt.has(name)) {
      for (const raw of rows) await fn(decodeOldRow(old, raw), ctx); // salvage: emits only
      continue;
    }
    const plan = engine.plan(name);
    const target = emitTargetOf(name); // the tmp under new names
    for (const raw of rows) {
      const decoded = decodeOldRow(old, raw);
      const result = await fn(decoded, ctx);
      if (result === null) continue; // deleted
      physicalInsert(engine, plan, target, checkRow(engine, name, result ?? decoded, "transform"), decoded[old.pk] as bigint);
    }
  }
  return tmpOf;
}

/** Insert a validated row into `target`; a supplied `pk` is preserved. */
function physicalInsert(
  engine: Engine,
  plan: TablePlan,
  target: EmitTarget,
  values: MigrationRow,
  pk?: bigint,
): void {
  const names: string[] = [];
  const params: unknown[] = [];
  if (pk !== undefined) {
    names.push(target.translate(plan.pk));
    params.push(pk);
  }
  for (const column of plan.columns.values()) {
    if (column.kind === "pk") continue;
    for (const phys of column.phys) names.push(target.translate(phys.name));
    params.push(...column.toSql(values[column.jsName]));
  }
  const sql = `INSERT INTO ${quote(target.name)} (${names.map(quote).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`;
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

// -- renames ------------------------------------------------------------------

interface NormalizedRenames {
  tables: Record<string, string>; // old -> new
  columns: Record<string, Record<string, string>>; // NEW table name -> { oldCol -> newCol }
  variants: Record<string, Record<string, string>>; // type name -> { oldVariant -> newVariant }
}

interface RenamePlan {
  /** The current snapshot with every rename applied — what the diff runs against. */
  renamedCurrent: SchemaSnapshot;
  /** new table name -> old table name, for tables whose name changed. */
  tableOldName: Map<string, string>;
  /** new table name -> physical [old, new] column pairs (a union contributes both). */
  columnPhys: Map<string, [string, string][]>;
  /** new table name -> new physical column name -> old physical column name. */
  columnReverse: Map<string, Map<string, string>>;
  variants: { type: string; from: string; to: string }[];
  /** Every new table name touched by a table or column rename. */
  renamedTables: Set<string>;
}

/**
 * Validate the rename declarations (MigrationError, nothing touched) and derive
 * the renamed-current snapshot plus the physical rename work. `columns` are
 * keyed by the TARGET table name, so table renames are resolved first.
 */
function planRenames(engine: Engine, current: SchemaSnapshot, target: SchemaSnapshot, migration: Migration): RenamePlan {
  const raw: NormalizedRenames = {
    tables: migration.renames?.tables ?? {},
    columns: migration.renames?.columns ?? {},
    variants: migration.renames?.variants ?? {},
  };
  validateRenames(engine, current, target, raw);

  const tableOldName = new Map<string, string>();
  for (const [oldT, newT] of Object.entries(raw.tables)) tableOldName.set(newT, oldT);

  const columnPhys = new Map<string, [string, string][]>();
  const columnReverse = new Map<string, Map<string, string>>();
  for (const [table, cols] of Object.entries(raw.columns)) {
    const pairs: [string, string][] = [];
    const reverse = new Map<string, string>();
    for (const [oldCol, newCol] of Object.entries(cols)) {
      pairs.push([oldCol, newCol]);
      reverse.set(newCol, oldCol);
      if (engine.plan(table).columns.get(newCol)!.phys.length === 2) {
        pairs.push([`${oldCol}__p`, `${newCol}__p`]);
        reverse.set(`${newCol}__p`, `${oldCol}__p`);
      }
    }
    columnPhys.set(table, pairs);
    columnReverse.set(table, reverse);
  }

  const variants: RenamePlan["variants"] = [];
  for (const [type, vmap] of Object.entries(raw.variants)) {
    for (const [from, to] of Object.entries(vmap)) variants.push({ type, from, to });
  }

  return {
    renamedCurrent: applyRenames(current, raw),
    tableOldName,
    columnPhys,
    columnReverse,
    variants,
    renamedTables: new Set([...tableOldName.keys(), ...Object.keys(raw.columns)]),
  };
}

function validateRenames(engine: Engine, current: SchemaSnapshot, target: SchemaSnapshot, raw: NormalizedRenames): void {
  const tableTargets = new Set<string>();
  for (const [oldT, newT] of Object.entries(raw.tables)) {
    if (current.tables[oldT]?.kind !== "table") throw new MigrationError(`rename source table "${oldT}" does not exist`);
    if (target.tables[newT] === undefined) throw new MigrationError(`rename target table "${newT}" is not in the schema`);
    if (target.tables[oldT] !== undefined) {
      throw new MigrationError(`rename source table "${oldT}" still exists in the schema; it was not dropped`);
    }
    if (current.tables[newT] !== undefined) {
      throw new MigrationError(`rename target table "${newT}" already exists; cannot rename onto a live table`);
    }
    if (tableTargets.has(newT)) throw new MigrationError(`two renames target table "${newT}"`);
    tableTargets.add(newT);
  }

  for (const [table, cols] of Object.entries(raw.columns)) {
    if (target.tables[table] === undefined) throw new MigrationError(`rename target table "${table}" is not in the schema`);
    const oldTable = Object.keys(raw.tables).find((o) => raw.tables[o] === table) ?? table;
    const from = current.tables[oldTable]?.columns ?? {};
    const to = target.tables[table]!.columns;
    const colTargets = new Set<string>();
    for (const [oldCol, newCol] of Object.entries(cols)) {
      if (from[oldCol] === undefined) throw new MigrationError(`rename source column "${table}.${oldCol}" does not exist`);
      if (to[newCol] === undefined) throw new MigrationError(`rename target column "${table}.${newCol}" is not in the schema`);
      if (to[oldCol] !== undefined) {
        throw new MigrationError(`rename source column "${table}.${oldCol}" still exists in the schema; it was not dropped`);
      }
      if (from[newCol] !== undefined) {
        throw new MigrationError(`rename target column "${table}.${newCol}" already exists; cannot rename onto a live column`);
      }
      if (colTargets.has(newCol)) throw new MigrationError(`two renames target column "${table}.${newCol}"`);
      colTargets.add(newCol);
    }
  }

  const currentVariants = variantSets(current);
  const targetVariants = variantSets(target);
  const taggedVariants = new Map<string, Set<string>>();
  for (const row of engine.writer.query("SELECT type, variant FROM _dbz_tags").all() as { type: string; variant: string }[]) {
    (taggedVariants.get(row.type) ?? taggedVariants.set(row.type, new Set()).get(row.type)!).add(row.variant);
  }
  for (const [type, vmap] of Object.entries(raw.variants)) {
    const fromSet = currentVariants.get(type) ?? new Set();
    const toSet = targetVariants.get(type) ?? new Set();
    const seen = new Set<string>();
    for (const [from, to] of Object.entries(vmap)) {
      if (!fromSet.has(from)) throw new MigrationError(`rename source variant "${type}.${from}" does not exist`);
      if (!toSet.has(to)) throw new MigrationError(`rename target variant "${type}.${to}" is not in the schema`);
      if (toSet.has(from)) {
        throw new MigrationError(`rename source variant "${type}.${from}" still exists in the schema; it was not removed`);
      }
      if (fromSet.has(to)) {
        throw new MigrationError(`rename target variant "${type}.${to}" already exists; cannot rename onto a live variant`);
      }
      if (taggedVariants.get(type)?.has(to)) {
        throw new MigrationError(`rename target variant "${type}.${to}" is a retired variant; its tag is retired forever`);
      }
      if (seen.has(to)) throw new MigrationError(`two renames target variant "${type}.${to}"`);
      seen.add(to);
    }
  }
}

/** Rewrite table keys, column keys, index column references, and variant names. */
function applyRenames(current: SchemaSnapshot, raw: NormalizedRenames): SchemaSnapshot {
  const tables: Record<string, TableSnapshot> = {};
  for (const [name, snap] of Object.entries(current.tables)) tables[name] = structuredClone(snap);
  for (const [oldT, newT] of Object.entries(raw.tables)) {
    tables[newT] = tables[oldT]!;
    delete tables[oldT];
  }
  for (const [table, cols] of Object.entries(raw.columns)) {
    const snap = tables[table]!;
    const columns: Record<string, Descriptor> = {};
    for (const [col, desc] of Object.entries(snap.columns)) columns[cols[col] ?? col] = desc;
    snap.columns = columns;
    snap.indexes = snap.indexes.map((ix) => ({ ...ix, columns: ix.columns.map((c) => cols[c] ?? c) }));
  }
  for (const [type, vmap] of Object.entries(raw.variants)) {
    for (const snap of Object.values(tables)) {
      for (const col of Object.keys(snap.columns)) snap.columns[col] = renameVariants(snap.columns[col]!, type, vmap);
    }
  }
  return { version: 1, tables };
}

/**
 * Rewrite variant names of the named `type` on a TOP-LEVEL column descriptor
 * only (through nullable). A tag relabel is zero-rewrite only where variants
 * are stored as interned tags — the top level; nested enum/union values are
 * wire-encoded STRINGS, so a deep rewrite would erase the diff while stranding
 * stale variant strings the new type cannot validate. Left untouched, a nested
 * use of the renamed type surfaces as an honest type-changed refusal whose
 * transform rewrites the payloads. That is correct behavior, not a limitation.
 */
function renameVariants(desc: Descriptor, type: string, vmap: Record<string, string>): Descriptor {
  if (desc["k"] === "nullable") {
    return { ...desc, inner: renameVariants(desc["inner"] as Descriptor, type, vmap) };
  }
  if (desc["k"] === "enum" && desc["name"] === type) {
    return { ...desc, values: (desc["values"] as string[]).map((v) => vmap[v] ?? v) };
  }
  if (desc["k"] === "union" && desc["name"] === type) {
    const members: Record<string, Descriptor> = {};
    for (const [variant, d] of Object.entries(desc["members"] as Record<string, Descriptor>)) {
      members[vmap[variant] ?? variant] = d; // payload descriptors untouched: nested uses must diff
    }
    return { ...desc, members };
  }
  return desc;
}

/** Collect the variant set of every named enum/union in a snapshot, by type name. */
function variantSets(snapshot: SchemaSnapshot): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const visit = (desc: Descriptor): void => {
    switch (desc["k"]) {
      case "nullable":
        return visit(desc["inner"] as Descriptor);
      case "array":
        return visit(desc["el"] as Descriptor);
      case "object":
        return void Object.values(desc["shape"] as Record<string, Descriptor>).forEach(visit);
      case "enum": {
        const set = out.get(desc["name"] as string) ?? out.set(desc["name"] as string, new Set()).get(desc["name"] as string)!;
        for (const v of desc["values"] as string[]) set.add(v);
        return;
      }
      case "union": {
        const set = out.get(desc["name"] as string) ?? out.set(desc["name"] as string, new Set()).get(desc["name"] as string)!;
        for (const [variant, d] of Object.entries(desc["members"] as Record<string, Descriptor>)) {
          set.add(variant);
          visit(d);
        }
        return;
      }
    }
  };
  for (const table of Object.values(snapshot.tables)) for (const desc of Object.values(table.columns)) visit(desc);
  return out;
}
