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
import { Engine, indexSqlName, type TablePlan } from "./engine.ts";
import { applyMigration, type Migration } from "./migrate.ts";
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

interface ReconcilePlan {
  ops: Op[];
  applied: string[];
  refusals: SchemaRefusal[];
}

export function reconcile(engine: Engine): { applied: string[] };
export function reconcile(engine: Engine, migration: Migration): Promise<{ applied: string[] }>;
export function reconcile(
  engine: Engine,
  migration?: Migration,
): { applied: string[] } | Promise<{ applied: string[] }> {
  const target = snapshotOf(engine.schema);
  const current = engine.loadSnapshot();
  if (current === null) {
    engine.createAll();
    const result = { applied: [`initialized ${Object.keys(target.tables).length} table(s)`] };
    return migration === undefined ? result : Promise.resolve(result);
  }
  if (JSON.stringify(current) === JSON.stringify(target)) {
    return migration === undefined ? { applied: [] } : Promise.resolve({ applied: [] });
  }

  const diff = diffSnapshots(current, target);
  if (migration !== undefined) return applyMigration(engine, target, current, diff, migration);

  const plan = planReconcile(engine, current, diff);
  if (plan.refusals.length > 0) throw new UnsafeSchemaChange(plan.refusals);
  applyPlan(engine, target, plan.ops);
  return { applied: plan.applied.length > 0 ? plan.applied : ["updated schema snapshot"] };
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
  const writer = engine.writer;

  const count = (sql: string, ...params: unknown[]): number =>
    Number((writer.query(sql).get(...(params as never[])) as { n: bigint }).n);

  for (const change of safe) applySafe(engine, change, current, ops, applied);
  for (const opt of optimistic) probeOptimistic(engine, opt, current, count, ops, applied, refusals);

  return { ops, applied, refusals };
}

/** Build the physical ops (and applied log) for one shape-safe change. */
export function applySafe(engine: Engine, change: SafeChange, current: SchemaSnapshot, ops: Op[], applied: string[]): void {
  const writer = engine.writer;
  const table = change.table;
  switch (change.op) {
    case "create-table":
      ops.push(() => engine.createTablePhysical(engine.plan(table)));
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
      ops.push(() => engine.createTablePhysical(engine.plan(table)));
      applied.push(`converted ${table} to a table`);
      return;
    case "add-column": {
      const columnPlan = engine.plan(table).columns.get(change.column)!;
      for (const phys of columnPlan.phys) {
        ops.push(() => writer.exec(`ALTER TABLE ${quote(table)} ADD COLUMN ${phys.ddl}`));
      }
      applied.push(`added nullable column ${table}.${change.column}`);
      return;
    }
    case "rebuild-table":
      rebuild(engine, engine.plan(table), current.tables[table]!, ops);
      applied.push(`rebuilt table ${table}`);
      return;
    case "drop-index":
      ops.push(() => writer.exec(`DROP INDEX IF EXISTS ${quote(indexSqlName(table, change.index))}`));
      applied.push(`dropped index ${table}.${change.index}`);
      return;
    case "create-index":
      ops.push(createIndexOp(engine, engine.plan(table), change.index, change.recreate));
      applied.push(`${change.recreate ? "recreated" : "created"} index ${table}.${change.index}`);
      return;
  }
}

/**
 * The one data probe: does the table already hold duplicate groups for a unique
 * index's columns? The probe mirrors the constraint exactly: SQLite unique
 * indexes treat NULLs as distinct, so rows holding NULL in any indexed column
 * can never collide and are excluded — and an index touching a column that is
 * not physical yet (added in this same change) cannot have duplicates at all.
 * Clean → schedule the create (unless a sibling rebuild owns it); duplicate →
 * a clean refusal carrying the probed count, nothing touched.
 */
export function probeOptimistic(
  engine: Engine,
  opt: OptimisticChange,
  current: SchemaSnapshot,
  count: (sql: string, ...params: unknown[]) => number,
  ops: Op[],
  applied: string[],
  refusals: SchemaRefusal[],
): void {
  const tablePlan = engine.plan(opt.table);
  const index = tablePlan.indexes.find((ix) => ix.name === opt.index)!;
  const currentColumns = current.tables[opt.table]?.columns ?? {};
  const allExist = index.columns.every((c) => currentColumns[c] !== undefined);
  const cols = index.columns.map(quote).join(", ");
  const notNull = index.columns.map((c) => `${quote(c)} IS NOT NULL`).join(" AND ");
  const dupes = allExist
    ? count(
        `SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${quote(opt.table)} WHERE ${notNull} GROUP BY ${cols} HAVING COUNT(*) > 1)`,
      )
    : 0;
  if (dupes > 0) {
    refusals.push({
      table: opt.table,
      index: opt.index,
      reason: "unique-index-duplicates",
      question: `unique index over (${index.columns.join(", ")}); ${dupes} duplicate group(s) exist`,
      count: dupes,
    });
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

function physColsOf(oldTable: TableSnapshot): Set<string> {
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
