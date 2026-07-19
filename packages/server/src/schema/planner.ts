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
 * The sole optimistic change — a unique index (or an index changed to unique) —
 * is attempted: the planner probes for duplicate groups (the one remaining data
 * probe), applies on a clean table, and records a clean refusal with the counts
 * if duplicates exist, touching nothing.
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
import { Engine, indexSqlName, type TablePlan } from "../engine.ts";
import { classifySchemaDiff, refusalSite, type OptimisticChange, type SafeChange, type SchemaRefusal } from "./classify.ts";
import { diffSnapshots, namedOf, type SchemaDiff } from "./diff.ts";
import type { SchemaSnapshot, TableSnapshot } from "../snapshot.ts";

export class UnsafeSchemaChange extends Error {
  readonly refusals: SchemaRefusal[];
  constructor(refusals: SchemaRefusal[]) {
    super(
      `refusing to apply unsafe schema changes; each needs a migration:\n` +
        refusals.map((r) => `  - ${refusalSite(r)}: ${r.question}`).join("\n") +
        `\n(write a migration to answer these, or wipe local data with \`dbz reset\`)`,
    );
    this.refusals = refusals;
  }
}

const quote = (name: string) => `"${name}"`;

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
  planOf: (table: string) => TablePlan;
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
  private readonly _refusals: SchemaRefusal[] = [];
  private readonly count: (sql: string, ...params: unknown[]) => number;

  constructor(private readonly ctx: PlanContext) {
    this.count = countOn(ctx.engine.writer);
  }

  /** The plan accumulated so far: physical ops, applied log, and the probe refusals discovered. */
  get plan(): SchemaPlan {
    return { ops: this._ops, applied: this._applied, refusals: this._refusals };
  }

  /**
   * Build the physical ops (and applied log) for one shape-safe change. The
   * context's `planOf` resolves a table name to its NEW-target plan: the
   * live-schema plan for an ordinary reconcile, an intermediate step's target
   * plan inside a migration chain.
   */
  safe(change: SafeChange): void {
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
        const columnPlan = planOf(table).columns.get(change.column)!;
        for (const phys of columnPlan.phys) {
          this._ops.push(() => writer.exec(`ALTER TABLE ${quote(table)} ADD COLUMN ${phys.ddl}`));
        }
        this._applied.push(`added nullable column ${table}.${change.column}`);
        return;
      }
      case "rebuild-table":
        rebuild(engine, planOf(table), current.tables[table]!, this._ops);
        this._applied.push(`rebuilt table ${table}`);
        return;
      case "drop-index":
        this._ops.push(() => writer.exec(`DROP INDEX IF EXISTS ${quote(indexSqlName(table, change.index))}`));
        this._applied.push(`dropped index ${table}.${change.index}`);
        return;
      case "create-index":
        this._ops.push(createIndexOp(engine, planOf(table), change.index, change.recreate));
        this._applied.push(`${change.recreate ? "recreated" : "created"} index ${table}.${change.index}`);
        return;
    }
  }

  /**
   * Probe one optimistic unique index against the live database and either
   * schedule its physical creation or record a duplicate refusal — nothing
   * touched either way. Duplicate → a clean refusal carrying the probed count;
   * clean → schedule the create (unless a sibling rebuild owns it). `phys` routes
   * the read-only probe to a physical table/columns still holding pre-rename names.
   */
  optimistic(
    opt: OptimisticChange,
    phys: { table: string; column: (c: string) => string } = { table: opt.table, column: (c) => c },
  ): void {
    const { engine, current, planOf } = this.ctx;
    const tablePlan = planOf(opt.table);
    const index = tablePlan.indexes.find((ix) => ix.name === opt.index)!;
    const refusal = probeUniqueIndex(this.count, opt.table, opt.index, index.columns, current.tables[opt.table]?.columns ?? {}, phys);
    if (refusal !== null) {
      this._refusals.push(refusal);
      return;
    }
    if (opt.viaRebuild) return; // the rebuild creates every index from the new plan
    this._ops.push(createIndexOp(engine, tablePlan, opt.index, opt.recreate));
    this._applied.push(`${opt.recreate ? "recreated" : "created"} index ${opt.table}.${opt.index}`);
  }
}

/**
 * The one data probe, pure over a query function: does `table` already hold
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
  if (!columns.every((c) => currentColumns[c] !== undefined)) return null;
  const physCols = columns.map((c) => quote(phys.column(c)));
  const notNull = physCols.map((c) => `${c} IS NOT NULL`).join(" AND ");
  const dupes = query(
    `SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${quote(phys.table)} WHERE ${notNull} GROUP BY ${physCols.join(", ")} HAVING COUNT(*) > 1)`,
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

function createIndexOp(engine: Engine, tablePlan: TablePlan, name: string, recreate: boolean): Op {
  const index = tablePlan.indexes.find((ix) => ix.name === name)!;
  return () => {
    const writer = engine.writer;
    if (recreate) writer.exec(`DROP INDEX IF EXISTS ${quote(indexSqlName(tablePlan.name, name))}`);
    writer.exec(engine.indexDdl(tablePlan, index));
  };
}

export function physColsOf(oldTable: TableSnapshot): Set<string> {
  return new Set(
    Object.entries(oldTable.columns).flatMap(([col, desc]) =>
      namedOf(desc)?.kind === "union" ? [col, `${col}__p`] : [col],
    ),
  );
}

/** Rebuild `table` to the new plan, preserving intersecting columns and ids. */
function rebuild(engine: Engine, tablePlan: TablePlan, oldTable: TableSnapshot, ops: Op[]): void {
  const writer = engine.writer;
  ops.push(() => {
    const oldPhys = physColsOf(oldTable);
    const copy = tablePlan.physOrder.filter((c) => oldPhys.has(c)).map(quote).join(", ");
    const tmp = `${tablePlan.name}__rebuild`;
    const seqRow = writer
      .query("SELECT seq FROM sqlite_sequence WHERE name = ?")
      .get(tablePlan.name) as { seq: bigint } | null;
    writer.exec(engine.createTableDdl(tablePlan, tmp));
    if (copy.length > 0) {
      writer.exec(`INSERT INTO ${quote(tmp)} (${copy}) SELECT ${copy} FROM ${quote(tablePlan.name)}`);
    }
    writer.exec(`DROP TABLE ${quote(tablePlan.name)}`);
    writer.exec(`ALTER TABLE ${quote(tmp)} RENAME TO ${quote(tablePlan.name)}`);
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
  });
}

/**
 * Turn a diff into an immutable plan: shape-safe changes become physical ops,
 * optimistic unique indexes are probed (the one data probe), and every refusal —
 * shape-classified or probed — rides along unapplied. Read-only over the database.
 */
export function planDiff(ctx: PlanContext, diff: SchemaDiff): SchemaPlan {
  const { safe, optimistic, refusals } = classifySchemaDiff(diff);
  const planner = new SchemaPlanner(ctx);
  for (const change of safe) planner.safe(change);
  for (const opt of optimistic) planner.optimistic(opt);
  const probed = planner.plan;
  return { ops: probed.ops, applied: probed.applied, refusals: [...refusals, ...probed.refusals] };
}

/** Apply a refusal-free plan: tags, ops, and the new snapshot in one transaction. */
export function commitPlan(engine: Engine, target: SchemaSnapshot, plan: SchemaPlan): void {
  const writer = engine.writer;
  writer.exec("BEGIN IMMEDIATE");
  try {
    engine.persistTags();
    for (const op of plan.ops) op();
    engine.saveSnapshot(target);
    writer.exec("COMMIT");
  } catch (error) {
    writer.exec("ROLLBACK");
    throw error;
  }
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
