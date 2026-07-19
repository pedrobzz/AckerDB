/**
 * Schema reconciliation: diff the stored snapshot against the live schema and
 * make the database match. It layers three seams: a pure structural diff
 * (`schema-diff.ts`), a pure shape classification (`schema-classify.ts`) that
 * presumes rows always exist and judges each change by its shape alone, and one
 * transactional apply.
 *
 * Safety is a property of the change's shape, never of the data underneath it —
 * a change classified safe applies identically on an empty dev table and a full
 * prod one; a change classified unsafe refuses on both. No row counts excuse
 * anything.
 *
 * Shape-safe changes apply automatically, in one transaction:
 *   - adding a table or event table; dropping or updating an event table
 *   - converting an event table into a real table (event → table)
 *   - adding a nullable column
 *   - widening a column to nullable (a rebuild that preserves every row)
 *   - adding / reordering enum & union variants (tags are stable)
 *   - dropping any index; adding / changing a non-unique index
 *
 * The sole optimistic change — a unique index (or an index changed to unique) —
 * is attempted: the planner probes for duplicate groups (the one remaining data
 * probe), applies on a clean table, and refuses cleanly with the counts if
 * duplicates exist, touching nothing.
 *
 * Everything else is *refused* — a type change, narrowing to required, a
 * required-column add, a variant removal or union payload change, a column or
 * table drop, a table → event conversion — with the presume-data question, and
 * with no row-count probing, even on a provably empty table. A migration file
 * is the answer to a refusal; `dbz reset` is the dev escape hatch.
 */
import type { Database } from "bun:sqlite";
import { Engine, indexSqlName, type TablePlan } from "./engine.ts";
import { applyStep, pendingSteps, recordChain, stepLabel, validateChain, type MigrationStep } from "./migrate.ts";
import {
  classifySchemaDiff,
  refusalSite,
  type OptimisticChange,
  type SafeChange,
  type SchemaRefusal,
} from "./schema-classify.ts";
import { diffSnapshots, namedOf, type SchemaDiff } from "./schema-diff.ts";
import { snapshotOf, type SchemaSnapshot, type TableSnapshot } from "./snapshot.ts";

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

interface ReconcilePlan {
  ops: Op[];
  applied: string[];
  refusals: SchemaRefusal[];
}

export function reconcile(engine: Engine): { applied: string[] };
export function reconcile(engine: Engine, steps: MigrationStep[]): Promise<{ applied: string[] }>;
export function reconcile(
  engine: Engine,
  steps?: MigrationStep[],
): { applied: string[] } | Promise<{ applied: string[] }> {
  if (steps !== undefined) return applyChain(engine, steps);

  const target = snapshotOf(engine.schema);
  const current = engine.loadSnapshot();
  if (current === null) {
    engine.createAll();
    return { applied: [`initialized ${Object.keys(target.tables).length} table(s)`] };
  }
  if (JSON.stringify(current) === JSON.stringify(target)) return { applied: [] };

  const plan = planReconcile(engine, current, diffSnapshots(current, target));
  if (plan.refusals.length > 0) throw new UnsafeSchemaChange(plan.refusals);
  applyPlan(engine, target, plan.ops);
  return { applied: plan.applied.length > 0 ? plan.applied : ["updated schema snapshot"] };
}

/**
 * Apply an append-only migration chain at startup. Every pending step reconciles
 * toward its own historical target in its own transaction (that same transaction
 * records the history row), so a mid-chain failure leaves every earlier step
 * applied and rolls the failing one back whole. After the chain the in-memory tag
 * maps are refreshed and the remaining diff to the live schema takes the ordinary
 * shape-safe reconcile path (auto-applies, or throws naming the recourse).
 */
async function applyChain(engine: Engine, steps: MigrationStep[]): Promise<{ applied: string[] }> {
  validateChain(steps); // reject malformed numbering before touching the database
  const stored = engine.loadSnapshot();
  if (stored === null) {
    // A fresh database is already at the live schema; stamp the whole chain
    // applied so its (number, identity) prefix holds on the next open.
    engine.createAll();
    recordChain(engine, steps);
    return { applied: [`initialized ${Object.keys(snapshotOf(engine.schema).tables).length} table(s)`] };
  }
  const pending = pendingSteps(engine.writer, steps);
  const applied: string[] = [];
  let current = stored;
  for (const step of pending) {
    // The saved snapshot (target augmented with carried columns) is physical
    // truth for the next step, so a carried column resurfaces as drift there.
    const { applied: lines, saved } = await applyStep(engine, current, step);
    const label = stepLabel(step);
    for (const line of lines.length > 0 ? lines : ["applied"]) applied.push(`${label}: ${line}`);
    current = saved;
  }
  if (pending.length > 0) engine.reinternTags();
  applied.push(...reconcile(engine).applied);
  return { applied };
}

/**
 * Turn a diff into ops or refusals. Shape-unsafe refusals come straight from
 * the classification with no probing; optimistic unique indexes are the only
 * data probe. Read-only: any refusal leaves the plan unapplied.
 */
function planReconcile(engine: Engine, current: SchemaSnapshot, diff: SchemaDiff): ReconcilePlan {
  const { safe, optimistic, refusals } = classifySchemaDiff(diff);
  const ops: Op[] = [];
  const applied: string[] = [];
  const count = countOn(engine.writer);

  const planOf = (table: string): TablePlan => engine.plan(table);
  for (const change of safe) applySafe(engine, change, current, ops, applied, planOf);
  for (const opt of optimistic) probeOptimistic(engine, opt, current, count, ops, applied, refusals, planOf);

  return { ops, applied, refusals };
}

/**
 * Build the physical ops (and applied log) for one shape-safe change. `planOf`
 * resolves a table name to its NEW-target plan: the live-schema plan for an
 * ordinary reconcile, an intermediate step's target plan inside a migration chain.
 */
export function applySafe(
  engine: Engine,
  change: SafeChange,
  current: SchemaSnapshot,
  ops: Op[],
  applied: string[],
  planOf: (table: string) => TablePlan,
): void {
  const writer = engine.writer;
  const table = change.table;
  switch (change.op) {
    case "create-table":
      ops.push(() => engine.createTablePhysical(planOf(table)));
      applied.push(`created table ${table}`);
      return;
    case "add-event-table":
      applied.push(`added event table ${table}`);
      return;
    case "drop-event-table":
      applied.push(`dropped event table ${table}`);
      return;
    case "update-event-table":
      applied.push(`updated event table ${table}`);
      return;
    case "event-to-table":
      ops.push(() => engine.createTablePhysical(planOf(table)));
      applied.push(`converted ${table} to a table`);
      return;
    case "add-column": {
      const columnPlan = planOf(table).columns.get(change.column)!;
      for (const phys of columnPlan.phys) {
        ops.push(() => writer.exec(`ALTER TABLE ${quote(table)} ADD COLUMN ${phys.ddl}`));
      }
      applied.push(`added nullable column ${table}.${change.column}`);
      return;
    }
    case "rebuild-table":
      rebuild(engine, planOf(table), current.tables[table]!, ops);
      applied.push(`rebuilt table ${table}`);
      return;
    case "drop-index":
      ops.push(() => writer.exec(`DROP INDEX IF EXISTS ${quote(indexSqlName(table, change.index))}`));
      applied.push(`dropped index ${table}.${change.index}`);
      return;
    case "create-index":
      ops.push(createIndexOp(engine, planOf(table), change.index, change.recreate));
      applied.push(`${change.recreate ? "recreated" : "created"} index ${table}.${change.index}`);
      return;
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

/**
 * Probe one optimistic unique index against the live database and either
 * schedule its physical creation or record a duplicate refusal — nothing
 * touched either way. Duplicate → a clean refusal carrying the probed count;
 * clean → schedule the create (unless a sibling rebuild owns it).
 */
export function probeOptimistic(
  engine: Engine,
  opt: OptimisticChange,
  current: SchemaSnapshot,
  count: (sql: string, ...params: unknown[]) => number,
  ops: Op[],
  applied: string[],
  refusals: SchemaRefusal[],
  planOf: (table: string) => TablePlan,
  phys: { table: string; column: (c: string) => string } = { table: opt.table, column: (c) => c },
): void {
  const tablePlan = planOf(opt.table);
  const index = tablePlan.indexes.find((ix) => ix.name === opt.index)!;
  const refusal = probeUniqueIndex(count, opt.table, opt.index, index.columns, current.tables[opt.table]?.columns ?? {}, phys);
  if (refusal !== null) {
    refusals.push(refusal);
    return;
  }
  if (opt.viaRebuild) return; // the rebuild creates every index from the new plan
  ops.push(createIndexOp(engine, tablePlan, opt.index, opt.recreate));
  applied.push(`${opt.recreate ? "recreated" : "created"} index ${opt.table}.${opt.index}`);
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

/** Apply a refusal-free plan: tags, ops, and the new snapshot in one transaction. */
function applyPlan(engine: Engine, target: SchemaSnapshot, ops: Op[]): void {
  const writer = engine.writer;
  writer.exec("BEGIN IMMEDIATE");
  try {
    engine.persistTags();
    for (const op of ops) op();
    engine.saveSnapshot(target);
    writer.exec("COMMIT");
  } catch (error) {
    writer.exec("ROLLBACK");
    throw error;
  }
}
