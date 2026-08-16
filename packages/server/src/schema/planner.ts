/**
 * The schema planner: the lower-level engine of reconciliation, owning every
 * mechanical decision a schema change turns into. It consumes the pure structural
 * diff (`diff.ts`) and its shape classification (`classify.ts`) and turns them
 * into an immutable plan — physical ops, the applied log, and the refusals it
 * could not clear — without deciding policy. Safety is a property of the change's
 * shape, never of the data underneath it: a change classified safe applies
 * identically on an empty dev table and a full prod one; a change classified
 * unsafe refuses on both. No row counts excuse anything.
 *
 * Shape-safe changes become SQL applied unconditionally:
 *   - adding a table or event table; dropping or updating an event table
 *   - converting an event table into a real table (event → table)
 *   - adding a nullable column
 *   - widening a column to nullable (a rebuild that preserves every row)
 *   - adding / reordering enum & union variants (tags are stable)
 *   - dropping any index; adding / changing a non-unique index
 *
 * Data-dependent constraints are attempted optimistically: unique indexes probe
 * duplicate groups and tightened validators scan their affected columns once
 * per table. The writer runs these guards under BEGIN IMMEDIATE before any
 * schema, data, snapshot, or history write.
 *
 * Everything else is *refused* with the presume-data question and no row-count
 * probing. The refusals ride along the plan; the reconcile entry throws them and
 * the migration engine answers them.
 *
 * Two seams the callers consume: `SchemaPlanner` (a builder that accumulates a
 * plan from selectively fed changes — the migration apply drives it directly,
 * routing probes through rename maps), and `planAndReconcile` (the shared
 * safe-reconcile core: plan stored → live, refuse or commit). Both take a
 * `PlanContext` carrying the engine, the diffed-against snapshot, and the
 * new-target plan resolver, so no positional threading crosses the seam.
 */
import type { Database } from "bun:sqlite";
import { Engine, indexSqlName, type PhysicalTablePlan } from "../database/engine.ts";
import { CorruptDatabaseError } from "../shared/errors.ts";
import { isValidationError } from "../validation/error.ts";
import { checkDescriptor } from "./descriptor-kinds.ts";
import { classifySchemaDiff, refusalSite, type OptimisticChange, type SafeChange, type SchemaRefusal } from "./classify.ts";
import { diffSnapshots, type SchemaDiff } from "./diff.ts";
import type { SchemaSnapshot, TableSnapshot } from "./snapshot.ts";
import {
  buildStoredTable,
  decodeStoredRow,
  loadStoredTags,
  pageStoredRows,
  physicalColumnsOf,
  type StoredTags,
} from "./stored-rows.ts";
import { quoteIdentifier } from "../shared/sql.ts";

export class UnsafeSchemaChange extends Error {
  readonly refusals: SchemaRefusal[];
  constructor(refusals: SchemaRefusal[]) {
    super(
      `refusing to apply unsafe schema changes; each needs a migration:\n` +
        refusals.map((r) => `  - ${refusalSite(r)}: ${r.question}`).join("\n") +
        `\n(write a migration to answer these, or wipe local data with \`acker reset\`)`,
    );
    this.refusals = refusals;
  }
}

export type Op = () => void;

/** A row-count probe bound to a writer: runs `sql` (aliasing its count `n`) and returns it. */
export function countOn(writer: Database): (sql: string, ...params: unknown[]) => number {
  return (sql, ...params) => Number((writer.query(sql).get(...(params as never[])) as { n: bigint }).n);
}

/** The immutable outcome of planning: physical ops, the applied log, and the refusals left unapplied. */
export interface SchemaPlan {
  readonly ops: readonly Op[];
  readonly applied: readonly string[];
  readonly refusals: readonly SchemaRefusal[];
  /** Replayable data guards, rerun by the writer after BEGIN IMMEDIATE. */
  readonly probes: readonly (() => readonly SchemaRefusal[])[];
}

export interface PhysicalProbeRoute {
  readonly table: string;
  column(name: string): string;
}

export interface RoutedOptimisticChange {
  readonly change: OptimisticChange;
  readonly phys: PhysicalProbeRoute;
}

export type StoredTagNames = StoredTags;

export interface OptimisticProbeOptions {
  /** Already-resolved tag names, used by migration apply before tag rows move. */
  readonly storedTags?: StoredTagNames;
  /** Logical variant renames for a CLI post-answer preview over old tag rows. */
  readonly variantRenames?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/** What the planner needs to translate a classified change into physical work, carried once instead of threaded. */
export interface PlanContext {
  engine: Engine;
  /** The snapshot the diff ran against: the stored one for a reconcile, the renamed-stored one inside a migration step. */
  current: SchemaSnapshot;
  /**
   * Resolve a table name to its NEW-target plan: the live-schema plan for an
   * ordinary reconcile, an intermediate step's target plan inside a migration chain.
   */
  planOf: (table: string) => PhysicalTablePlan;
  /** Optional post-rename tag names for migration probes before tag rows move. */
  storedTags?: StoredTags;
}

/**
 * A mutable builder that accumulates a `SchemaPlan` from selectively fed changes.
 * The reconcile path feeds it a whole classification; the migration apply feeds
 * it only the changes it does not own and routes optimistic probes through rename
 * maps. Its arrays are private — the caller reads the immutable `plan`, never
 * mutates one it was handed.
 */
export class SchemaPlanner {
  private readonly _ops: Op[] = [];
  private readonly _applied: string[] = [];
  private readonly queued: RoutedOptimisticChange[] = [];
  private completed: SchemaPlan | undefined;

  constructor(private readonly ctx: PlanContext) {}

  /** The sealed plan: physical ops, applied log, shape refusals, and deferred writer guards. */
  get plan(): SchemaPlan {
    if (this.completed === undefined) this.completed = this.finish();
    return this.completed;
  }

  /**
   * Build the physical ops (and applied log) for one shape-safe change. The
   * context's `planOf` resolves a table name to its NEW-target plan: the
   * live-schema plan for an ordinary reconcile, an intermediate step's target
   * plan inside a migration chain.
   */
  safe(change: SafeChange): void {
    if (this.completed !== undefined) throw new Error("cannot add safe work after reading the schema plan");
    const { engine, current, planOf } = this.ctx;
    const writer = engine.writer;
    const table = change.table;
    switch (change.op) {
      case "create-table":
        this._ops.push(() => engine.createTablePhysical(planOf(table)));
        this._applied.push(`created table ${table}`);
        return;
      case "add-event-table":
        this._applied.push(`added event table ${table}`);
        return;
      case "drop-event-table":
        this._applied.push(`dropped event table ${table}`);
        return;
      case "update-event-table":
        this._applied.push(`updated event table ${table}`);
        return;
      case "event-to-table":
        this._ops.push(() => engine.createTablePhysical(planOf(table)));
        this._applied.push(`converted ${table} to a table`);
        return;
      case "add-column": {
        const tablePlan = planOf(table);
        const columnPlan = tablePlan.columns.get(change.column)!;
        for (const phys of columnPlan.phys) {
          this._ops.push(() => writer.exec(`ALTER TABLE ${quoteIdentifier(tablePlan.name)} ADD COLUMN ${phys.ddl}`));
        }
        this._applied.push(`added nullable column ${table}.${change.column}`);
        return;
      }
      case "loosen-constraints":
        this._applied.push(`loosened constraints ${table}.${change.column}`);
        return;
      case "rebuild-table":
        rebuild(engine, planOf(table), current.tables[table]!, this._ops);
        this._applied.push(`rebuilt table ${table}`);
        return;
      case "drop-index": {
        const tablePlan = planOf(table);
        this._ops.push(() => writer.exec(`DROP INDEX IF EXISTS ${quoteIdentifier(indexSqlName(tablePlan.name, change.index))}`));
        this._applied.push(`dropped index ${table}.${change.index}`);
        return;
      }
      case "create-index":
        this._ops.push(createIndexOp(engine, planOf(table), change.index, change.recreate));
        this._applied.push(`${change.recreate ? "recreated" : "created"} index ${table}.${change.index}`);
        return;
      case "create-full-text": {
        const tablePlan = planOf(table);
        this._ops.push(() => engine.createFullTextTargetPhysical(tablePlan, change.column));
        this._applied.push(`created full-text target ${table}.${change.column}`);
        return;
      }
      case "drop-full-text": {
        const tablePlan = planOf(table);
        this._ops.push(() =>
          engine.dropFullTextTargetPhysical(tablePlan.name, change.column)
        );
        this._applied.push(`dropped full-text target ${table}.${change.column}`);
        return;
      }
    }
  }

  /**
   * Queue one optimistic guard. Physical work is scheduled in the sealed plan;
   * the guard itself remains deferred until the writer transaction. `phys`
   * routes a migration guard to still-old table/column names before renames.
   */
  optimistic(
    opt: OptimisticChange,
    phys?: PhysicalProbeRoute,
  ): void {
    if (this.completed !== undefined) throw new Error("cannot add optimistic work after reading the schema plan");
    this.queued.push({
      change: opt,
      phys: phys ?? { table: this.ctx.planOf(opt.table).name, column: (column) => column },
    });
  }

  private finish(): SchemaPlan {
    const { engine, current, planOf, storedTags } = this.ctx;
    const runProbes = () => probeOptimisticChanges(
      engine.writer,
      current,
      this.queued,
      (table, index) => planOf(table).indexes.find((candidate) => candidate.name === index)!.columns,
      { storedTags },
    );
    for (const { change } of this.queued) {
      if (change.op === "tighten-constraints") {
        this._applied.push(`tightened constraints ${change.table}.${change.column}`);
        continue;
      }
      if (change.viaRebuild) continue;
      const tablePlan = planOf(change.table);
      this._ops.push(createIndexOp(engine, tablePlan, change.index, change.recreate));
      this._applied.push(`${change.recreate ? "recreated" : "created"} index ${change.table}.${change.index}`);
    }
    return {
      ops: this._ops,
      applied: this._applied,
      refusals: [],
      probes: this.queued.length === 0 ? [] : [runProbes],
    };
  }
}

/**
 * The unique-index data probe, pure over a query function: does `table` already hold
 * duplicate groups for a would-be unique index's `columns`, and if so what is
 * the refusal? The probe mirrors the constraint exactly: SQLite unique indexes
 * treat NULLs as distinct, so rows holding NULL in any indexed column can never
 * collide and are excluded — and an index touching a column that is not physical
 * yet (added in this same change, so absent from `currentColumns`) cannot have
 * duplicates at all. `phys` routes the read-only probe to a physical
 * table/columns still holding pre-rename names; the refusal keeps naming the
 * target-world `table`/`index`. Returns `null` when the table is clean. Shared by
 * the reconcile planner (Engine writer) and the migration plan (a read-only
 * `bun:sqlite` peek), so both run byte-identical SQL and yield identical refusals.
 */
export function probeUniqueIndex(
  query: (sql: string) => number,
  table: string,
  index: string,
  columns: readonly string[],
  currentColumns: Record<string, unknown>,
  phys: { table: string; column: (c: string) => string } = { table, column: (c) => c },
): SchemaRefusal | null {
  if (!columns.every((column) => Object.hasOwn(currentColumns, column))) return null;
  const physCols = columns.map((c) => quoteIdentifier(phys.column(c)));
  const notNull = physCols.map((c) => `${c} IS NOT NULL`).join(" AND ");
  const dupes = query(
    `SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${quoteIdentifier(phys.table)} WHERE ${notNull} GROUP BY ${physCols.join(", ")} HAVING COUNT(*) > 1)`,
  );
  if (dupes === 0) return null;
  return {
    table,
    index,
    reason: "unique-index-duplicates",
    question: `unique index over (${columns.join(", ")}); ${dupes} duplicate group(s) exist`,
    count: dupes,
  };
}

type IndexColumns = (table: string, index: string) => readonly string[];

interface ConstraintProbeGroup {
  readonly table: string;
  readonly phys: PhysicalProbeRoute;
  readonly changes: Extract<OptimisticChange, { op: "tighten-constraints" }>[];
}

/**
 * Execute every optimistic data guard. Unique indexes retain their exact SQL
 * probe. Constraint tightenings are grouped by physical table, decoded from the
 * recorded descriptor/tag context, and served by one bounded page scan per
 * table regardless of how many columns tightened.
 */
export function probeOptimisticChanges(
  writer: Database,
  current: SchemaSnapshot,
  routed: readonly RoutedOptimisticChange[],
  indexColumns: IndexColumns,
  options: OptimisticProbeOptions = {},
): SchemaRefusal[] {
  const uniqueRefusals = new Map<OptimisticChange, SchemaRefusal>();
  const constraintCounts = new Map<OptimisticChange, number>();
  const groups = new Map<string, ConstraintProbeGroup>();
  const count = countOn(writer);

  for (const item of routed) {
    const change = item.change;
    if (change.op === "unique-index") {
      const currentTable = Object.hasOwn(current.tables, change.table)
        ? current.tables[change.table]
        : undefined;
      const refusal = probeUniqueIndex(
        count,
        change.table,
        change.index,
        indexColumns(change.table, change.index),
        currentTable?.columns ?? {},
        item.phys,
      );
      if (refusal !== null) uniqueRefusals.set(change, refusal);
      continue;
    }
    const key = `${change.table}\0${item.phys.table}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { table: change.table, phys: item.phys, changes: [change] });
    } else {
      group.changes.push(change);
    }
    constraintCounts.set(change, 0);
  }

  if (groups.size > 0) {
    const loadedTags = options.storedTags ?? loadStoredTags(writer);
    const tags = options.variantRenames === undefined
      ? loadedTags
      : renameStoredTagNames(loadedTags, options.variantRenames);
    for (const group of groups.values()) {
      const table = current.tables[group.table];
      if (table === undefined || table.kind !== "table") continue;
      const selected = new Set(group.changes.map((change) => change.column));
      const physical = new Set([...physicalColumnsOf(table)].map(group.phys.column));
      const decoder = buildStoredTable(table, physical, tags, group.phys.column, selected);
      const projection = decoder.columns.filter((column) => column.present).flatMap((column) => column.phys);

      for (const raw of pageStoredRows(writer, group.phys.table, decoder.physicalPk, projection)) {
        const row = decodeStoredRow(decoder, raw);
        for (const change of group.changes) {
          const value = row[change.column];
          let currentValue: unknown;
          try {
            currentValue = checkDescriptor(
              change.current,
              value,
              `${change.table}.${change.column} stored row ${String(row[decoder.pk])}`,
            );
          } catch (error) {
            if (!isValidationError(error)) throw error;
            throw new CorruptDatabaseError(
              `stored value violates the recorded descriptor for ${change.table}.${change.column}: ${error.message}`,
            );
          }
          if (currentValue === null) continue;
          try {
            checkDescriptor(change.target, currentValue, `${change.table}.${change.column}`);
          } catch (error) {
            if (!isValidationError(error)) throw error;
            constraintCounts.set(change, constraintCounts.get(change)! + 1);
          }
        }
      }
    }
  }

  const refusals: SchemaRefusal[] = [];
  for (const { change } of routed) {
    if (change.op === "unique-index") {
      const refusal = uniqueRefusals.get(change);
      if (refusal !== undefined) refusals.push(refusal);
      continue;
    }
    const violations = constraintCounts.get(change) ?? 0;
    if (violations === 0) continue;
    refusals.push({
      table: change.table,
      column: change.column,
      reason: "constraint-violations",
      question: `constraints tightened; ${violations} existing row(s) violate the target validator`,
      count: violations,
    });
  }
  return refusals;
}

function renameStoredTagNames(
  tags: StoredTagNames,
  renames: NonNullable<OptimisticProbeOptions["variantRenames"]>,
): StoredTagNames {
  const renamed = new Map(tags);
  for (const [typeName, variants] of Object.entries(renames)) {
    const names = tags.get(typeName);
    if (names === undefined) continue;
    renamed.set(typeName, new Map([...names].map(([tag, name]) => [
      tag,
      Object.hasOwn(variants, name) ? variants[name]! : name,
    ])));
  }
  return renamed;
}

function createIndexOp(engine: Engine, tablePlan: PhysicalTablePlan, name: string, recreate: boolean): Op {
  const index = tablePlan.indexes.find((ix) => ix.name === name)!;
  return () => {
    const writer = engine.writer;
    if (recreate) writer.exec(`DROP INDEX IF EXISTS ${quoteIdentifier(indexSqlName(tablePlan.name, name))}`);
    writer.exec(engine.indexDdl(tablePlan, index));
  };
}

/** Rebuild `table` to the new plan, preserving intersecting columns and ids. */
function rebuild(engine: Engine, tablePlan: PhysicalTablePlan, oldTable: TableSnapshot, ops: Op[]): void {
  const writer = engine.writer;
  ops.push(() => {
    const oldPhys = physicalColumnsOf(oldTable);
    const copy = tablePlan.physOrder.filter((c) => oldPhys.has(c)).map(quoteIdentifier).join(", ");
    const tmp = `${tablePlan.name}__rebuild`;
    const seqRow = writer
      .query("SELECT seq FROM sqlite_sequence WHERE name = ?")
      .get(tablePlan.name) as { seq: bigint } | null;
    engine.dropStoredFullTextPhysical(tablePlan.name, oldTable);
    writer.exec(engine.createTableDdl(tablePlan, tmp));
    if (copy.length > 0) {
      writer.exec(`INSERT INTO ${quoteIdentifier(tmp)} (${copy}) SELECT ${copy} FROM ${quoteIdentifier(tablePlan.name)}`);
    }
    writer.exec(`DROP TABLE ${quoteIdentifier(tablePlan.name)}`);
    writer.exec(`ALTER TABLE ${quoteIdentifier(tmp)} RENAME TO ${quoteIdentifier(tablePlan.name)}`);
    if (seqRow !== null) {
      // never reuse ids: restore the sequence high-water mark
      const changed = writer
        .query("UPDATE sqlite_sequence SET seq = ? WHERE name = ? AND seq < ?")
        .run(seqRow.seq, tablePlan.name, seqRow.seq);
      const missing = Number(
        (writer.query("SELECT COUNT(*) AS n FROM sqlite_sequence WHERE name = ?").get(tablePlan.name) as { n: bigint }).n,
      );
      if (changed.changes === 0 && missing === 0) {
        writer.query("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)").run(tablePlan.name, seqRow.seq);
      }
    }
    engine.createIndexesPhysical(tablePlan);
    engine.createFullTextPhysical(tablePlan);
  });
}

/**
 * Turn a diff into an immutable plan: shape-safe changes become physical ops,
 * optimistic work becomes deferred writer guards, and every shape refusal rides
 * along unapplied. Planning performs no database scan.
 */
export function planDiff(ctx: PlanContext, diff: SchemaDiff): SchemaPlan {
  const { safe, optimistic, refusals } = classifySchemaDiff(diff);
  const planner = new SchemaPlanner(ctx);
  for (const change of safe) planner.safe(change);
  for (const opt of optimistic) planner.optimistic(opt);
  const probed = planner.plan;
  return {
    ops: probed.ops,
    applied: probed.applied,
    refusals: [...refusals, ...probed.refusals],
    probes: probed.probes,
  };
}

/** Apply a refusal-free plan: tags, ops, and the new snapshot in one transaction. */
export function commitPlan(engine: Engine, target: SchemaSnapshot, plan: SchemaPlan): void {
  const writer = engine.writer;
  writer.exec("BEGIN IMMEDIATE");
  try {
    verifyPlanProbes(plan);
    engine.persistTags();
    for (const op of plan.ops) op();
    engine.saveSnapshot(target);
    writer.exec("COMMIT");
  } catch (error) {
    writer.exec("ROLLBACK");
    throw error;
  }
}

/** Refuse a stale optimistic plan before its transaction performs any writes. */
export function verifyPlanProbes(plan: SchemaPlan): void {
  const refusals = plan.probes.flatMap((probe) => [...probe()]);
  if (refusals.length > 0) throw new UnsafeSchemaChange(refusals);
}

/**
 * The shared safe-reconcile core: plan the diff from the stored `current` to
 * `target`, refuse it whole (throwing `UnsafeSchemaChange`) if any change is
 * shape-unsafe, or commit every op with the new snapshot in one transaction.
 * `reconcile`'s live pass runs it after its fresh-DB and no-op guards; a
 * migration chain's trailing hop runs it against the live schema once every step
 * has applied — so the chain never calls the reconcile entry back. Returns the
 * applied lines.
 */
export function planAndReconcile(engine: Engine, current: SchemaSnapshot, target: SchemaSnapshot): string[] {
  const plan = planDiff({ engine, current, planOf: (table) => engine.plan(table) }, diffSnapshots(current, target));
  if (plan.refusals.length > 0) throw new UnsafeSchemaChange([...plan.refusals]);
  commitPlan(engine, target, plan);
  return plan.applied.length > 0 ? [...plan.applied] : ["updated schema snapshot"];
}
