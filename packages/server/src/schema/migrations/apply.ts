/**
 * Migration application: the answer to a reconcile refusal, driven entirely by
 * snapshots. A migration is a pure function between two recorded snapshots — its
 * `pre` (the typed before-state) and its `target` (the declared contract) — so
 * nothing here reads the live `engine.schema`. That is what lets a *chain* of
 * pending migrations apply in order at startup, each reconciling toward its own
 * historical target rather than the final one.
 *
 * Each step:
 *   - derives its physical work from `diffSnapshots(applyRenames(stored), target)`
 *     — the STORED snapshot is the physical truth, so the diff is what the
 *     database actually is versus where this step is contracted to go;
 *   - encodes rows and builds DDL from the step's TARGET descriptors (index and
 *     column DDL, enum/union interned tags), never the live plan;
 *   - decodes old rows and the frozen before-state from the step's PRE
 *     descriptors, guarded by physical presence: a pre column not physically
 *     present reads `null`, a pre table not physically present reads empty. That
 *     is safe drift made real — the recorded types stay sound for every database
 *     the migration can legally meet.
 *
 * A step declares one entry per table that changed shape: a transform on a
 * surviving table (rebuilt from its new plan, every old row replayed preserving
 * its primary key), `null` on a dropped table (its data goes nowhere), or a
 * transform on a dropped table (a salvage — the return is ignored, only its
 * `ctx.insert` emits matter). Every write happens in the step's single
 * transaction, which also inserts the append-only history row; any error rolls
 * the whole step back byte-identical, leaving every earlier step applied. The
 * safe/optimistic work for tables the migration does not own is delegated to the
 * shared planner (`../planner.ts`); the machinery below owns only the rebuild,
 * transform, rename, and drop work a migration alone performs.
 */
import type { Database } from "bun:sqlite";
import { decode, encode } from "@dbzz/core";
import { ValidationError, type Descriptor } from "../../dbz.ts";
import { checkDescriptor, scalarDecoder, scalarEncoder } from "../descriptor-kinds.ts";
import { physicalColumnDdl, type ColumnPlan, type Engine, type TablePlan, type TagMap } from "../../engine.ts";
import { classifySchemaDiff, type SchemaRefusal } from "../classify.ts";
import { diffSnapshots, namedOf, unwrapDesc } from "../diff.ts";
import type { SchemaSnapshot, TableSnapshot } from "../../snapshot.ts";
import { physColsOf, SchemaPlanner, UnsafeSchemaChange } from "../planner.ts";
import { planRenames, variantSets, type RenamePlan } from "./rename.ts";
import {
  migrationIdentity,
  MigrationError,
  type BeforeTable,
  type MigrationContext,
  type MigrationRow,
  type MigrationStep,
  type RowTransform,
} from "./types.ts";

const quote = (name: string) => `"${name}"`;

/**
 * The internal page size for every row accumulation a step performs — old-row
 * iteration, `ctx.before.scan()`, and the emit-spool flush. A migration must run
 * within a bounded heap on the deployment target no matter how large a table is,
 * so this is a fixed constant, never a knob.
 */
const MIGRATE_BATCH = 1000;

/**
 * Page a physically-immutable table by primary key, `MIGRATE_BATCH` rows at a
 * time, so a step's heap never scales with table size. Sound only during the
 * transform phase, where old physical tables are frozen — emits spool, rebuilt
 * writes go to a tmp, structural renames/swaps happen after — so `pk > last`
 * walks every row exactly once.
 */
async function* pageRows(writer: Database, table: string, pk: string): AsyncIterableIterator<MigrationRow> {
  let last: bigint | undefined;
  for (;;) {
    const where = last === undefined ? "" : `WHERE ${quote(pk)} > ? `;
    const params = last === undefined ? [] : [last as never];
    const rows = writer
      .query(`SELECT * FROM ${quote(table)} ${where}ORDER BY ${quote(pk)} ASC LIMIT ${MIGRATE_BATCH}`)
      .all(...params) as MigrationRow[];
    for (const raw of rows) yield raw;
    if (rows.length < MIGRATE_BATCH) return;
    last = rows[rows.length - 1]![pk] as bigint;
  }
}

// -- one step -----------------------------------------------------------------

/** Everything a single step's transforms and swaps read, all snapshot-derived. */
interface StepScope {
  engine: Engine;
  pre: SchemaSnapshot;
  stored: SchemaSnapshot;
  target: SchemaSnapshot;
  renames: RenamePlan;
  targetPlans: Map<string, TablePlan>;
  oldTags: OldTags;
}

/**
 * Apply one pending step against the stored snapshot, in one transaction that
 * also records the history row. Renames are a pure pre-pass whose renamed-stored
 * snapshot the diff runs against; validation runs next and touches nothing. The
 * transaction then relabels variant tags, persists this step's target tags,
 * applies the safe ops the migration does not own (creates first, so emits land),
 * replays every transform against the before-state, swaps rebuilt tables in,
 * performs pure renames last (so transforms read old physical names), drops
 * acknowledged tables, saves the target snapshot (augmented with any carried
 * columns so it keeps describing physical reality), records the history row, and
 * commits. Returns the applied lines (unprefixed) and the snapshot it saved.
 */
export async function applyStep(
  engine: Engine,
  stored: SchemaSnapshot,
  step: MigrationStep,
): Promise<{ applied: string[]; saved: SchemaSnapshot }> {
  const writer = engine.writer;
  const { pre, target, migration } = step;
  const renames = planRenames(writer, stored, target, migration);
  const diff = diffSnapshots(renames.renamedCurrent, target);
  const { safe, optimistic, refusals } = classifySchemaDiff(diff);
  const entries = migration.tables ?? {};

  const oldTags = loadOldTags(writer); // pre-rename tags, for decoding old rows
  const stepTags = internStepTags(writer, target, renames.variants); // in-memory target tag maps
  const targetPlans = buildTargetPlans(target, stepTags);
  const planOf = (t: string): TablePlan => targetPlans.get(t)!;

  validateEntries(renames.renamedCurrent, targetPlans, refusals, entries);

  // A surviving table with an entry is rebuilt from its new plan; a table the
  // schema no longer keeps is dropped (after an optional salvage transform).
  const rebuilt = new Set<string>();
  const dropped = new Set<string>();
  for (const name of Object.keys(entries)) (targetPlans.has(name) ? rebuilt : dropped).add(name);

  // A renamed table with other changes cannot ALTER-rename in place. A user
  // transform rebuilds it as usual; without one its remaining changes are
  // shape-safe (validateEntries already demanded a transform for every refusal),
  // so an engine-owned identity rebuild carries every row through the rename map.
  const identityRebuilt = new Set<string>();
  for (const change of diff) {
    if (renames.renamedTables.has(change.table) && !rebuilt.has(change.table)) identityRebuilt.add(change.table);
  }

  // Plan the safe/optimistic work for tables the migration does NOT own — a
  // rebuilt table's classified ops are absorbed by its rebuild, never doubled.
  const planner = new SchemaPlanner({ engine, current: renames.renamedCurrent, planOf });
  for (const change of safe) {
    if (!rebuilt.has(change.table) && !identityRebuilt.has(change.table)) planner.safe(change);
  }
  for (const opt of optimistic) {
    if (rebuilt.has(opt.table)) continue;
    if (identityRebuilt.has(opt.table)) {
      // The physical table still holds pre-rename names until the swap: route
      // the read-only probe through the rename map so the counted refusal
      // survives; the index itself is created from the new plan post-swap.
      const reverse = renames.columnReverse.get(opt.table);
      planner.optimistic(
        { ...opt, viaRebuild: true },
        { table: renames.tableOldName.get(opt.table) ?? opt.table, column: (c) => reverse?.get(c) ?? c },
      );
    } else {
      planner.optimistic(opt);
    }
  }
  const plan = planner.plan;
  if (plan.refusals.length > 0) throw new UnsafeSchemaChange([...plan.refusals]);
  const applied: string[] = [...plan.applied];

  const scope: StepScope = { engine, pre, stored, target, renames, targetPlans, oldTags };
  const driftOf = new Map<string, DriftColumn[]>();
  for (const name of [...rebuilt, ...identityRebuilt]) {
    const drift = driftColumns(scope, name);
    validateDrift(name, drift, target); // refuse illegal drift as a MigrationError before the transaction
    if (drift.length > 0) driftOf.set(name, drift);
  }
  const saved = augmentSnapshot(target, driftOf);

  writer.exec("BEGIN IMMEDIATE");
  try {
    // Variant renames keep their interned tag: relabel _dbz_tags so the
    // renamed-to variant resolves to the old integer, then persist this step's
    // target tags (renamed and new alike) before any write.
    for (const { type, from, to } of renames.variants) {
      writer.query("UPDATE _dbz_tags SET variant = ? WHERE type = ? AND variant = ?").run(to, type, from);
      applied.push(`renamed variant ${type}.${from} to ${to}`);
    }
    persistTagMaps(writer, stepTags);
    for (const op of plan.ops) op();
    const tmpOf = await runTransforms(scope, entries, rebuilt, identityRebuilt, driftOf);
    for (const name of [...tmpOf.keys()].sort()) {
      // IF EXISTS: safe drift may have left this database without the old table,
      // in which case the rebuilt tmp simply becomes the (empty) new table.
      writer.exec(`DROP TABLE IF EXISTS ${quote(renames.tableOldName.get(name) ?? name)}`);
      writer.exec(`ALTER TABLE ${quote(tmpOf.get(name)!)} RENAME TO ${quote(name)}`);
      engine.createIndexesPhysical(planOf(name)); // a unique index over bad output fails here
      applied.push(`migrated table ${name}`);
    }
    for (const name of [...renames.renamedTables].filter((t) => !tmpOf.has(t)).sort()) {
      applyPureRename(engine, name, renames, planOf, applied);
    }
    for (const name of [...dropped].sort()) {
      writer.exec(`DROP TABLE ${quote(name)}`);
      applied.push(`dropped table ${name}`);
    }
    engine.saveSnapshot(saved);
    writer
      .query("INSERT INTO _dbz_migrations (number, name, identity, applied_at) VALUES (?, ?, ?, ?)")
      .run(step.number, step.name, migrationIdentity(step), Date.now());
    writer.exec("COMMIT");
  } catch (error) {
    writer.exec("ROLLBACK");
    throw error;
  }
  return { applied, saved };
}

/**
 * Perform a pure structural rename LAST, once every transform has read the old
 * physical names. `ALTER TABLE ... RENAME TO` rewrites the table's stored DDL
 * canonically but leaves index names stale, so a renamed table drops and
 * recreates its indexes from the new plan; `RENAME COLUMN` (both physical
 * columns of a union) canonically rewrites the table and any index it touches,
 * so a name-stable table needs no index work.
 */
function applyPureRename(
  engine: Engine,
  newTable: string,
  renames: RenamePlan,
  planOf: (table: string) => TablePlan,
  applied: string[],
): void {
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
  engine.createIndexesPhysical(planOf(newTable));
  applied.push(`renamed table ${oldTable} to ${newTable}`);
}

/** Reject a migration that fails to answer the diff, before anything is touched. */
function validateEntries(
  current: SchemaSnapshot,
  targetPlans: Map<string, TablePlan>,
  refusals: SchemaRefusal[],
  entries: Record<string, RowTransform | null>,
): void {
  const missing = [...new Set(refusals.map((r) => r.table))].filter((t) => !(t in entries)).sort();
  if (missing.length > 0) {
    throw new MigrationError(`migration is missing a transform for refused table(s): ${missing.join(", ")}`);
  }
  for (const [name, value] of Object.entries(entries)) {
    const surviving = targetPlans.has(name);
    if (surviving) {
      if (value === null) {
        throw new MigrationError(`migration entry for "${name}" is null, but "${name}" still exists in the schema`);
      }
    } else if (current.tables[name]?.kind !== "table") {
      throw new MigrationError(`migration references unknown table "${name}"`);
    }
  }
}

// -- target-side codec (encode + DDL from the step's target descriptors) ------

/**
 * Build every real table's NEW-target plan from descriptors + this step's tag
 * maps. Structurally identical to the engine's live plans, so the engine's DDL
 * builders and `physicalInsert` operate on them unchanged.
 */
function buildTargetPlans(target: SchemaSnapshot, tags: Map<string, TagMap>): Map<string, TablePlan> {
  const plans = new Map<string, TablePlan>();
  for (const [name, snap] of Object.entries(target.tables)) {
    if (snap.kind === "table") plans.set(name, snapshotPlan(name, snap, tags));
  }
  return plans;
}

function snapshotPlan(name: string, snap: TableSnapshot, tags: Map<string, TagMap>): TablePlan {
  const columns = new Map<string, ColumnPlan>();
  const physOrder: string[] = [];
  let pk = "";
  let scheduleAt: string | null = null;
  for (const [col, desc] of Object.entries(snap.columns)) {
    const plan = snapshotColumnPlan(col, desc, tags);
    columns.set(col, plan);
    for (const p of plan.phys) physOrder.push(p.name);
    if (plan.kind === "pk") pk = col;
    if (plan.kind === "scheduleAt") scheduleAt = col;
  }
  return { name, pk, scheduleAt, columns, physOrder, indexes: snap.indexes };
}

/** The descriptor-driven encode mirror of `oldColumn`, closing over this step's tags. */
function snapshotColumnPlan(jsName: string, desc: Descriptor, tags: Map<string, TagMap>): ColumnPlan {
  const { base, nullable } = unwrapDesc(desc);
  const kind = base["k"] as string;
  const ddls = physicalColumnDdl(jsName, desc, jsName);
  const physNames = ddls.length === 2 ? [jsName, `${jsName}__p`] : [jsName];
  const phys = physNames.map((n, i) => ({ name: n, ddl: ddls[i]! }));
  const shared = { jsName, kind, nullable, phys };

  if (kind === "union") {
    const typeName = base["name"] as string;
    return {
      ...shared,
      typeName,
      toSql: (value) => {
        if (value === null) return [null, null];
        const { tag, value: payload } = value as { tag: string; value: unknown };
        const tagInt = tags.get(typeName)!.toTag.get(tag);
        if (tagInt === undefined) throw new Error(`unknown ${typeName} variant "${tag}"`);
        return [tagInt, encode(payload)];
      },
      fromSql: (values) =>
        values[0] === null ? null : { tag: tags.get(typeName)!.toName.get(Number(values[0]))!, value: decode(values[1] as string) },
    };
  }
  if (kind === "enum") {
    const typeName = base["name"] as string;
    return {
      ...shared,
      typeName,
      toSql: (value) => {
        if (value === null) return [null];
        const tagInt = tags.get(typeName)!.toTag.get(value as string);
        if (tagInt === undefined) throw new Error(`unknown ${typeName} variant "${String(value)}"`);
        return [tagInt];
      },
      fromSql: (values) => (values[0] === null ? null : tags.get(typeName)!.toName.get(Number(values[0]))!),
    };
  }
  const enc = scalarEncoder(kind);
  const dec = scalarDecoder(kind);
  return {
    ...shared,
    toSql: (value) => [value === null ? null : enc(value)],
    fromSql: (values) => (values[0] === null ? null : dec(values[0])),
  };
}

/**
 * Insert a validated row into `target`; a supplied `pk` is preserved. `carried`
 * are stored-physical columns the target plan does not know about (safe drift
 * ahead of the step) — their raw values are copied verbatim under their stored
 * physical names, which the rebuilt tmp holds alongside the plan's columns.
 */
function physicalInsert(
  engine: Engine,
  plan: TablePlan,
  target: EmitTarget,
  values: MigrationRow,
  pk?: bigint,
  carried: { name: string; value: unknown }[] = [],
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
  for (const c of carried) {
    names.push(c.name);
    params.push(c.value);
  }
  const sql = `INSERT INTO ${quote(target.name)} (${names.map(quote).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`;
  engine.writer.query(sql).run(...(params as never[]));
}

// -- target-side validation (checkRow, descriptor-driven) ---------------------

/** Validate a transform output / emit against the NEW schema, stripping the pk. */
function checkRow(table: string, snap: TableSnapshot, row: unknown, op: string): MigrationRow {
  if (row === null || typeof row !== "object" || Array.isArray(row)) {
    throw new ValidationError(`${table}.${op}: expected a row object`);
  }
  const input = row as MigrationRow;
  const out: MigrationRow = {};
  let pk = "";
  for (const [name, desc] of Object.entries(snap.columns)) {
    if (desc["k"] === "pk") {
      pk = name;
      continue;
    }
    out[name] = checkDescriptor(desc, input[name], `${table}.${op}.${name}`);
  }
  for (const key of Object.keys(input)) {
    if (key !== pk && !(key in snap.columns) && input[key] !== undefined) {
      throw new ValidationError(`${table}.${op}: unknown field "${key}"`);
    }
  }
  return out;
}

// -- old-side decode (pre descriptors, physical-presence guarded) -------------

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
 * type that survives only in an old snapshot (a dropped table's enum) would be
 * missing; tags are insert-only, so every variant ever stored is here.
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

/**
 * Build the descriptor-driven decoder for one old table from its PRE snapshot,
 * guarded by which columns are physically present: a pre-snapshot column absent
 * from the physical table reads `null` (safe drift — the column would have been
 * a nullable add this database has not yet seen).
 */
function buildOldTable(snap: TableSnapshot, physicalCols: Set<string>, oldTags: OldTags): OldTable {
  let pk = "";
  const columns: OldColumn[] = [];
  for (const [col, desc] of Object.entries(snap.columns)) {
    if (desc["k"] === "pk") pk = col;
    columns.push(oldColumn(col, desc, physicalCols, oldTags));
  }
  return { pk, columns };
}

function decodeOldRow(old: OldTable, sqlRow: MigrationRow): MigrationRow {
  const row: MigrationRow = {};
  for (const c of old.columns) row[c.col] = c.decode(c.phys.map((p) => sqlRow[p]));
  return row;
}

function oldColumn(col: string, desc: Descriptor, physicalCols: Set<string>, oldTags: OldTags): OldColumn {
  const { base } = unwrapDesc(desc);
  const kind = base["k"] as string;
  const phys = kind === "union" ? [col, `${col}__p`] : [col];
  if (!physicalCols.has(col)) return { col, phys, decode: () => null };
  if (kind === "union") {
    const typeName = base["name"] as string;
    return {
      col,
      phys,
      decode: (v) => (v[0] === null ? null : { tag: oldTags.get(typeName)!.get(Number(v[0]))!, value: decode(v[1] as string) }),
    };
  }
  if (kind === "enum") {
    const typeName = base["name"] as string;
    return { col, phys, decode: (v) => (v[0] === null ? null : oldTags.get(typeName)!.get(Number(v[0]))!) };
  }
  const dec = scalarDecoder(kind);
  return { col, phys, decode: (v) => (v[0] === null ? null : dec(v[0])) };
}

/**
 * Read-only before-state over every PRE table, guarded by physical presence: a
 * pre table not physically present reads empty (get → null, scan → nothing).
 */
function buildBefore(engine: Engine, pre: SchemaSnapshot, stored: SchemaSnapshot, oldTags: OldTags): Record<string, BeforeTable> {
  const writer = engine.writer;
  const before: Record<string, BeforeTable> = {};
  for (const [name, snap] of Object.entries(pre.tables)) {
    if (snap.kind !== "table") continue;
    const physical = stored.tables[name];
    if (physical === undefined || physical.kind !== "table") {
      before[name] = {
        async get() {
          return null;
        },
        // eslint-disable-next-line require-yield
        async *scan() {},
      };
      continue;
    }
    const old = buildOldTable(snap, physColsOf(physical), oldTags);
    before[name] = {
      async get(id) {
        const raw = writer.query(`SELECT * FROM ${quote(name)} WHERE ${quote(old.pk)} = ?`).get(id as never) as MigrationRow | null;
        return raw === null ? null : decodeOldRow(old, raw);
      },
      async *scan() {
        for await (const raw of pageRows(writer, name, old.pk)) yield decodeOldRow(old, raw);
      },
    };
  }
  return before;
}

// -- transforms ---------------------------------------------------------------

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
 * One stored-physical column the step's PRE never typed but the database already
 * physically holds — safe drift ahead of this rebuild of `name`, classified once
 * against the target:
 *   - `carried`: the target dropped it silently on a parallel branch. Its DDL is
 *     appended to the tmp and its raw values are copied verbatim on replay, so a
 *     later diff can drop it deliberately; it also augments the saved snapshot.
 *   - `defaults`: the target re-declares it. The PRE-typed transform cannot see
 *     it, so its stored value backfills any row whose output omits `jsName`.
 * A column PRE knew (a deliberate, acknowledged drop), a column the renames map
 * into the target (its data moves via the rename), the pk, and every plain target
 * column are all excluded — they are not drift.
 */
interface DriftColumn {
  kind: "carried" | "defaults";
  /** The stored/old js (column) name — where the value lives on disk. */
  oldJs: string;
  /** Target js name a `defaults` column backfills under; the kept stored name for `carried`. */
  jsName: string;
  /** Stored descriptor (kept nullable-as-stored). */
  descriptor: Descriptor;
  /** Stored physical names (a union contributes both `col` and `col__p`). */
  phys: string[];
  /** tmp DDL for a `carried` column (empty for `defaults` — the plan already declares it). */
  ddls: string[];
}

/**
 * The single drift overlay for a rebuild of `name`: every stored-physical column
 * absent from the step's `pre` (mapped through renames), each classified
 * `carried` (absent from target) or `defaults` (present in target). This is the
 * ONE source every rebuild consumer reads — tmp DDL, per-row carried copy, per-row
 * defaults injection, identity-rebuild SELECT, and `augmentSnapshot`. Validated by
 * `validateDrift` before any transaction; the classification is pure derivation.
 */
function driftColumns(scope: StepScope, name: string): DriftColumn[] {
  const { pre, stored, renames, targetPlans } = scope;
  const oldPhysName = renames.tableOldName.get(name) ?? name;
  const storedSnap = stored.tables[oldPhysName];
  if (storedSnap === undefined || storedSnap.kind !== "table") return [];
  const plan = targetPlans.get(name)!;
  const reverse = renames.columnReverse.get(name);
  const targetOldPhys = new Set(plan.physOrder.map((c) => reverse?.get(c) ?? c));
  const targetJsByOldJs = new Map<string, string>();
  for (const c of plan.columns.values()) {
    if (c.kind !== "pk") targetJsByOldJs.set(reverse?.get(c.phys[0]!.name) ?? c.jsName, c.jsName);
  }
  const preColumns = pre.tables[oldPhysName]?.columns ?? {};
  const drift: DriftColumn[] = [];
  for (const [col, desc] of Object.entries(storedSnap.columns)) {
    if (col in preColumns) continue; // the migration knew this column; a target dropping it is deliberate
    const phys = namedOf(desc)?.kind === "union" ? [col, `${col}__p`] : [col];
    if (phys.some((p) => targetOldPhys.has(p))) {
      drift.push({ kind: "defaults", oldJs: col, jsName: targetJsByOldJs.get(col)!, descriptor: desc, phys, ddls: [] });
    } else {
      drift.push({ kind: "carried", oldJs: col, jsName: col, descriptor: desc, phys, ddls: physicalColumnDdl(col, desc, col) });
    }
  }
  return drift;
}

/**
 * Refuse an illegal drift overlay UP FRONT, before anything is touched. Legal
 * safe drift only widens, so a stored-only column is always nullable; a NOT NULL
 * one (carried or defaults) means the lineage is not shape-safe drift. A defaults
 * column additionally must agree with the target's type after nullable-unwrapping
 * — the same compatibility the row-time decode+check used to enforce mid-flight,
 * now hoisted so the row-time path can never fail on descriptor grounds.
 */
function validateDrift(name: string, drift: DriftColumn[], target: SchemaSnapshot): void {
  for (const d of drift) {
    if (!unwrapDesc(d.descriptor).nullable) {
      throw new MigrationError(
        `migration on "${name}": stored column "${d.oldJs}" is NOT NULL yet neither the step's pre nor a widening add ` +
          `produced it, so this lineage is not shape-safe drift`,
      );
    }
    if (d.kind === "defaults") {
      const targetDesc = target.tables[name]!.columns[d.jsName]!;
      if (JSON.stringify(unwrapDesc(d.descriptor).base) !== JSON.stringify(unwrapDesc(targetDesc).base)) {
        throw new MigrationError(
          `migration on "${name}": stored column "${d.oldJs}" carries drift whose type conflicts with target column "${d.jsName}"`,
        );
      }
    }
  }
}

/**
 * The snapshot a step saves: its target augmented with every carried column's
 * descriptor (target order, then carried in stored order). The physical table now
 * holds columns the bare target lacks, so the stored snapshot must keep describing
 * them or the next `verifyApplicationSchema` refuses the open. Defaults columns
 * are already in the target, so only carried drift augments. The carried column
 * simply resurfaces as drift in the next step's diff and the final safe hop (live
 * schema has it → no-op; lacks it → ordinary drop refusal).
 */
function augmentSnapshot(target: SchemaSnapshot, driftOf: Map<string, DriftColumn[]>): SchemaSnapshot {
  const carriedOf = new Map<string, DriftColumn[]>();
  for (const [name, drift] of driftOf) {
    const carried = drift.filter((d) => d.kind === "carried");
    if (carried.length > 0) carriedOf.set(name, carried);
  }
  if (carriedOf.size === 0) return target;
  const tables: Record<string, TableSnapshot> = {};
  for (const [name, snap] of Object.entries(target.tables)) {
    const carried = carriedOf.get(name);
    if (carried === undefined) {
      tables[name] = snap;
      continue;
    }
    const columns: Record<string, Descriptor> = { ...snap.columns };
    for (const c of carried) columns[c.jsName] = c.descriptor;
    tables[name] = { ...snap, columns };
  }
  return { version: 1, tables };
}

/**
 * Run every transform against the before-state and return the temporary
 * physical name of each rebuilt table. Rebuilt tables are materialized empty
 * first (with their sequence seeded so emitted ids never collide with or reuse
 * a preserved one); old tables are only read, never modified, so transforms
 * observe a single frozen image regardless of order. A rebuilt+renamed table
 * reads its rows from its OLD physical name and PRE descriptors. Identity
 * rebuilds (renamed tables whose other changes are all shape-safe, no user
 * transform) are copied wholesale through the rename map before any transform
 * runs, so emits into them land in the tmp alongside the carried rows. The drift
 * overlay (`driftOf`) is the single source for both drift flavors: a `carried`
 * column extends the tmp DDL and its raw values are copied on replay, while a
 * `defaults` column backfills the old row's stored value whenever the transform's
 * raw output omits the key. Old rows are paged by primary key, and emits into
 * non-rebuilt tables spool to an engine-owned TEMP table (never the heap), then
 * flush only after every transform has run — so neither iteration nor buffering
 * scales with table size, and the frozen before-state never sees an emit.
 */
async function runTransforms(
  scope: StepScope,
  entries: Record<string, RowTransform | null>,
  rebuilt: Set<string>,
  identityRebuilt: Set<string>,
  driftOf: Map<string, DriftColumn[]>,
): Promise<Map<string, string>> {
  const { engine, pre, stored, target, renames, targetPlans, oldTags } = scope;
  const writer = engine.writer;
  const planOf = (t: string): TablePlan => targetPlans.get(t)!;
  const tmpOf = new Map<string, string>();
  for (const name of [...rebuilt, ...identityRebuilt].sort()) {
    const oldPhys = renames.tableOldName.get(name) ?? name;
    const tmp = `${name}__migrate`;
    tmpOf.set(name, tmp);
    const carriedDdls = (driftOf.get(name) ?? []).filter((c) => c.kind === "carried").flatMap((c) => c.ddls);
    writer.exec(engine.createTableDdl(planOf(name), tmp, carriedDdls));
    const seq = writer.query("SELECT seq FROM sqlite_sequence WHERE name = ?").get(oldPhys) as { seq: bigint } | null;
    if (seq !== null) writer.query("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)").run(tmp, seq.seq);
  }

  // Identity rebuild: one INSERT..SELECT per table, new physical columns fed
  // from their pre-rename names; columns absent from the old physical table are
  // omitted (new nullable columns land NULL). Carried columns keep their stored
  // names on both sides (a verbatim copy). No per-row JS ever runs.
  for (const name of [...identityRebuilt].sort()) {
    const oldPhysName = renames.tableOldName.get(name) ?? name;
    const reverse = renames.columnReverse.get(name);
    const oldCols = physColsOf(stored.tables[oldPhysName]!);
    const pairs = planOf(name)
      .physOrder.map((c) => [reverse?.get(c) ?? c, c] as const)
      .filter(([old]) => oldCols.has(old));
    const carriedPhys = (driftOf.get(name) ?? []).filter((c) => c.kind === "carried").flatMap((c) => c.phys);
    const insertCols = [...pairs.map(([, c]) => c), ...carriedPhys];
    const selectCols = [...pairs.map(([old]) => old), ...carriedPhys];
    writer.exec(
      `INSERT INTO ${quote(tmpOf.get(name)!)} (${insertCols.map(quote).join(", ")}) ` +
        `SELECT ${selectCols.map(quote).join(", ")} FROM ${quote(oldPhysName)}`,
    );
  }

  const emitTargetOf = (table: string): EmitTarget => {
    if (tmpOf.has(table)) return { name: tmpOf.get(table)!, translate: (c) => c };
    if (!renames.renamedTables.has(table)) return { name: table, translate: (c) => c };
    const reverse = renames.columnReverse.get(table); // undefined for a table-only rename
    return { name: renames.tableOldName.get(table) ?? table, translate: (c) => reverse?.get(c) ?? c };
  };

  // Emits into non-rebuilt tables write to the same connection `ctx.before`
  // reads, so they spool to an engine-owned TEMP table (bounded, never the heap)
  // and flush after every transform has run; emits into rebuilt tables go to the
  // (invisible) tmp and stay immediate. The spool stores the wire-encoded
  // *validated* row — before `toSql`, so enum/union values survive as their JS
  // forms and the plan's tag maps resolve them at flush. `_dbz_emit_spool` is
  // `_dbz`-prefixed, so `ctx.before` (which reads only named old tables) never
  // sees it. The whole step is one transaction, so a rollback discards the spool;
  // the success path drops it below.
  writer.exec("CREATE TEMP TABLE _dbz_emit_spool (target TEXT NOT NULL, row TEXT NOT NULL)");
  const spoolInsert = writer.query("INSERT INTO _dbz_emit_spool (target, row) VALUES (?, ?)");
  const ctx: MigrationContext = {
    before: buildBefore(engine, pre, stored, oldTags),
    insert(table, row) {
      if (!targetPlans.has(table)) throw new ValidationError(`migration insert: unknown table "${table}"`);
      const validated = checkRow(table, target.tables[table]!, row, "insert"); // eager: error locality stays here
      if (!tmpOf.has(table)) {
        spoolInsert.run(table, encode(validated));
        return;
      }
      physicalInsert(engine, planOf(table), emitTargetOf(table), validated);
    },
  };

  for (const [name, fn] of Object.entries(entries).sort(([a], [b]) => a.localeCompare(b))) {
    if (fn === null) continue;
    const oldPhys = renames.tableOldName.get(name) ?? name;
    const preSnap = pre.tables[oldPhys];
    const physical = stored.tables[oldPhys];
    // Safe drift: a pre table with no physical presence has no old rows to
    // replay (a rebuilt table stays the empty tmp; a salvage is a no-op).
    if (preSnap === undefined || physical === undefined || physical.kind !== "table") continue;
    const old = buildOldTable(preSnap, physColsOf(physical), oldTags);
    if (!rebuilt.has(name)) {
      for await (const raw of pageRows(writer, oldPhys, old.pk)) await fn(decodeOldRow(old, raw), ctx); // salvage: emits only
      continue;
    }
    const plan = planOf(name);
    const emit = emitTargetOf(name); // the tmp under new names
    const drift = driftOf.get(name) ?? [];
    const carried = drift.filter((d) => d.kind === "carried");
    // Defaults: target columns the PRE never typed but the database already
    // physically holds (parallel-lineage drift the target re-declares). A
    // PRE-typed transform cannot see them, so when its raw output does not
    // provide the key the stored value is decoded and used as the default.
    // `undefined` counts as absent — carrying the stored value is the data-safe
    // reading — while an explicit null is a provided value and wins.
    // `validateDrift` already refused any default whose type conflicts.
    const defaults = drift
      .filter((d) => d.kind === "defaults")
      .map((d) => ({ jsName: d.jsName, old: oldColumn(d.oldJs, d.descriptor, physColsOf(physical), oldTags) }));
    for await (const raw of pageRows(writer, oldPhys, old.pk)) {
      const decoded = decodeOldRow(old, raw);
      const result = await fn(decoded, ctx);
      if (result === null) continue; // deleted: the whole row goes, carried values included
      let out = (result ?? decoded) as MigrationRow;
      if (defaults.length > 0 && typeof out === "object" && !Array.isArray(out)) {
        out = { ...out }; // never mutate the transform's returned object
        for (const d of defaults) {
          if (out[d.jsName] === undefined) out[d.jsName] = d.old.decode(d.old.phys.map((p) => raw[p]));
        }
      }
      const carriedValues = carried.flatMap((c) => c.phys.map((p) => ({ name: p, value: raw[p] })));
      physicalInsert(engine, plan, emit, checkRow(name, target.tables[name]!, out, "transform"), decoded[old.pk] as bigint, carriedValues);
    }
  }
  // Flush the spool into its (non-rebuilt) targets, paged by rowid so the buffer
  // never lived on the heap; ids are assigned now, after every transform froze
  // the before-state. rowid preserves emit order for deterministic id assignment.
  let lastRowid: bigint | undefined;
  for (;;) {
    const where = lastRowid === undefined ? "" : "WHERE rowid > ? ";
    const params = lastRowid === undefined ? [] : [lastRowid as never];
    const spooled = writer
      .query(`SELECT rowid, target, row FROM _dbz_emit_spool ${where}ORDER BY rowid ASC LIMIT ${MIGRATE_BATCH}`)
      .all(...params) as { rowid: bigint; target: string; row: string }[];
    for (const s of spooled) physicalInsert(engine, planOf(s.target), emitTargetOf(s.target), decode(s.row) as MigrationRow);
    if (spooled.length < MIGRATE_BATCH) break;
    lastRowid = spooled[spooled.length - 1]!.rowid;
  }
  writer.exec("DROP TABLE _dbz_emit_spool");
  return tmpOf;
}

// -- tag interning for a step -------------------------------------------------

/**
 * Compute this step's target tag maps directly against `_dbz_tags` (insert-only,
 * max+1 per type in declaration order), relabelling any renamed variant so it
 * keeps its original integer. Read-only; the actual UPDATE + INSERT run inside
 * the step's transaction (`persistTagMaps`), producing the same end state.
 */
function internStepTags(writer: Database, target: SchemaSnapshot, variants: RenamePlan["variants"]): Map<string, TagMap> {
  const renameByType = new Map<string, Map<string, string>>();
  for (const { type, from, to } of variants) {
    (renameByType.get(type) ?? renameByType.set(type, new Map()).get(type)!).set(from, to);
  }
  const maps = new Map<string, TagMap>();
  for (const row of writer.query("SELECT type, variant, tag FROM _dbz_tags").all() as {
    type: string;
    variant: string;
    tag: bigint;
  }[]) {
    let map = maps.get(row.type);
    if (map === undefined) {
      map = { toTag: new Map(), toName: new Map() };
      maps.set(row.type, map);
    }
    const name = renameByType.get(row.type)?.get(row.variant) ?? row.variant;
    const tag = Number(row.tag);
    map.toTag.set(name, tag);
    map.toName.set(tag, name);
  }
  for (const [type, variantSet] of variantSets(target)) {
    let map = maps.get(type);
    if (map === undefined) {
      map = { toTag: new Map(), toName: new Map() };
      maps.set(type, map);
    }
    let max = Math.max(-1, ...map.toName.keys());
    for (const variant of variantSet) {
      if (!map.toTag.has(variant)) {
        max++;
        map.toTag.set(variant, max);
        map.toName.set(max, variant);
      }
    }
  }
  return maps;
}

/** Persist a step's tag maps (insert-only). The caller owns the transaction. */
function persistTagMaps(writer: Database, maps: Map<string, TagMap>): void {
  const insert = writer.query(
    "INSERT INTO _dbz_tags (type, variant, tag) VALUES (?, ?, ?) ON CONFLICT(type, variant) DO NOTHING",
  );
  for (const [type, map] of maps) {
    for (const [variant, tag] of map.toTag) insert.run(type, variant, tag);
  }
}
