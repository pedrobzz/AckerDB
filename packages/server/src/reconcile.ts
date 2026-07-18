/**
 * Schema reconciliation: diff the stored snapshot against the live schema and
 * make the database match — the MVP slice of the migrations design. It layers
 * three steps: a pure structural diff (`schema-diff.ts`), a data-dependent
 * planner that probes rows and turns the diff into ops or refusals, and one
 * transactional apply.
 *
 * Safe changes apply automatically, in one transaction:
 *   - adding a table (or event table)
 *   - adding a nullable column
 *   - any structural change to an *empty* table (rebuild in place)
 *   - widening a column to nullable / narrowing when no NULLs exist
 *   - adding/reordering enum & union variants (tags are stable)
 *   - removing a variant no rows hold
 *   - adding / removing / changing indexes (unique only over clean data)
 *   - dropping an empty table
 *
 * Anything existing rows can't satisfy is *refused* with row counts — the
 * database is never touched. (TypeScript migration files that resolve those
 * refusals are the post-MVP half of the design; `dbz reset` is the dev
 * escape hatch. Renames are not detected: they read as drop+add and refuse
 * when data exists.)
 */
import type { Descriptor } from "./dbz.ts";
import { Engine, indexSqlName, type TablePlan } from "./engine.ts";
import { diffSnapshots, namedOf, type SchemaDiff } from "./schema-diff.ts";
import { snapshotOf, type SchemaSnapshot, type TableSnapshot } from "./snapshot.ts";

export class UnsafeSchemaChange extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(
      `refusing to apply unsafe schema changes:\n${problems.map((p) => `  - ${p}`).join("\n")}\n` +
        `(resolve the data first, or wipe local data with \`dbz reset\`)`,
    );
    this.problems = problems;
  }
}

const quote = (name: string) => `"${name}"`;

type Op = () => void;

interface ReconcilePlan {
  ops: Op[];
  applied: string[];
  problems: string[];
}

function physColsOf(column: string, desc: Descriptor): string[] {
  return namedOf(desc)?.kind === "union" ? [column, `${column}__p`] : [column];
}

export function reconcile(engine: Engine): { applied: string[] } {
  const target = snapshotOf(engine.schema);
  const current = engine.loadSnapshot();
  if (current === null) {
    engine.createAll();
    return { applied: [`initialized ${Object.keys(target.tables).length} table(s)`] };
  }
  if (JSON.stringify(current) === JSON.stringify(target)) return { applied: [] };

  const plan = planReconcile(engine, current, diffSnapshots(current, target));
  if (plan.problems.length > 0) throw new UnsafeSchemaChange(plan.problems);
  applyPlan(engine, target, plan.ops);
  return { applied: plan.applied.length > 0 ? plan.applied : ["updated schema snapshot"] };
}

/** Turn a structural diff into concrete ops or refusals by probing live data. Read-only. */
function planReconcile(engine: Engine, current: SchemaSnapshot, diff: SchemaDiff): ReconcilePlan {
  const ops: Op[] = [];
  const applied: string[] = [];
  const problems: string[] = [];
  const writer = engine.writer;

  const count = (sql: string, ...params: unknown[]): number =>
    Number((writer.query(sql).get(...(params as never[])) as { n: bigint }).n);
  const rowCount = (table: string): number => count(`SELECT COUNT(*) AS n FROM ${quote(table)}`);

  const dropIndex = (table: string, index: string) =>
    ops.push(() => writer.exec(`DROP INDEX IF EXISTS ${quote(indexSqlName(table, index))}`));
  const createIndex = (tablePlan: TablePlan, name: string) => {
    const index = tablePlan.indexes.find((ix) => ix.name === name)!;
    if (index.unique) {
      const cols = index.columns.map(quote).join(", ");
      const dupes = count(
        `SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${quote(tablePlan.name)} GROUP BY ${cols} HAVING COUNT(*) > 1)`,
      );
      if (dupes > 0) {
        problems.push(
          `${tablePlan.name}.${name}: unique index over (${index.columns.join(", ")}), but ${dupes} group(s) of duplicate rows exist`,
        );
        return;
      }
    }
    ops.push(() => writer.exec(engine.indexDdl(tablePlan, index)));
  };

  /** Rebuild `table` to the new plan, preserving intersecting columns and ids. */
  const rebuild = (tablePlan: TablePlan, oldTable: TableSnapshot) => {
    ops.push(() => {
      const oldPhys = new Set(
        Object.entries(oldTable.columns).flatMap(([col, desc]) => physColsOf(col, desc)),
      );
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
        if (changed.changes === 0 && count("SELECT COUNT(*) AS n FROM sqlite_sequence WHERE name = ?", tablePlan.name) === 0) {
          writer.query("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)").run(tablePlan.name, seqRow.seq);
        }
      }
      engine.createIndexesPhysical(tablePlan);
    });
  };

  for (const change of diff) {
    const table = change.table;
    switch (change.op) {
      case "table-added": {
        if (change.kind === "table") {
          ops.push(() => engine.createTablePhysical(engine.plan(table)));
          applied.push(`created table ${table}`);
        } else {
          applied.push(`added event table ${table}`);
        }
        break;
      }
      case "table-dropped": {
        if (change.kind === "table") {
          const n = rowCount(table);
          if (n > 0) {
            problems.push(`table ${table} dropped, but it still holds ${n} row(s)`);
            break;
          }
          ops.push(() => writer.exec(`DROP TABLE IF EXISTS ${quote(table)}`));
        }
        applied.push(`dropped ${table}`);
        break;
      }
      case "table-kind-changed": {
        if (change.from === "table") {
          const n = rowCount(table);
          if (n > 0) {
            problems.push(`table ${table} changed to an ${change.to} table, but it still holds ${n} row(s)`);
            break;
          }
          ops.push(() => writer.exec(`DROP TABLE IF EXISTS ${quote(table)}`));
        }
        applied.push(`converted ${table}`);
        if (change.to === "table") ops.push(() => engine.createTablePhysical(engine.plan(table)));
        break;
      }
      case "event-updated": {
        applied.push(`updated event table ${table}`);
        break;
      }
      case "table-altered": {
        const tablePlan = engine.plan(table);
        const rows = rowCount(table);
        let needsRebuild = false;
        const alterAdds: string[] = [];

        for (const col of change.columns) {
          switch (col.op) {
            case "added":
              if (col.nullable) alterAdds.push(col.column);
              else if (rows === 0) needsRebuild = true;
              else
                problems.push(
                  `${table}.${col.column}: required column added, but the table has ${rows} row(s) with no value for it`,
                );
              break;
            case "dropped":
              if (rows === 0) needsRebuild = true;
              else problems.push(`${table}.${col.column}: column dropped, but the table still holds ${rows} row(s)`);
              break;
            case "type-changed":
              if (rows === 0) needsRebuild = true;
              else problems.push(`${table}.${col.column}: type changed, but ${rows} row(s) would need converting`);
              break;
            case "nullability-changed":
              if (col.to === "nullable") {
                needsRebuild = true; // widen: keep data, relax NOT NULL
              } else {
                const nulls = count(`SELECT COUNT(*) AS n FROM ${quote(table)} WHERE ${quote(col.column)} IS NULL`);
                if (nulls > 0) problems.push(`${table}.${col.column}: made required, but ${nulls} row(s) hold NULL`);
                else needsRebuild = true;
              }
              break;
            case "variants-changed": {
              const tags = engine.tags.get(col.typeName)!;
              const holders = (variant: string): number => {
                const tag = tags.toTag.get(variant);
                if (tag === undefined) return 0;
                return count(`SELECT COUNT(*) AS n FROM ${quote(table)} WHERE ${quote(col.column)} = ?`, tag);
              };
              for (const v of col.variants) {
                if (v.op === "removed") {
                  const n = holders(v.variant);
                  if (n > 0) problems.push(`${table}.${col.column}: variant '${v.variant}' removed, but ${n} row(s) still hold it`);
                } else if (v.op === "payload-changed") {
                  const n = holders(v.variant);
                  if (n > 0)
                    problems.push(
                      `${table}.${col.column}: variant '${v.variant}' payload type changed, but ${n} row(s) still hold it`,
                    );
                }
              }
              break;
            }
          }
        }

        if (needsRebuild) {
          rebuild(tablePlan, current.tables[table]!); // recreates every index from the new plan
          applied.push(`rebuilt table ${table}`);
        } else {
          for (const column of alterAdds) {
            const columnPlan = tablePlan.columns.get(column)!;
            for (const phys of columnPlan.phys) {
              ops.push(() => writer.exec(`ALTER TABLE ${quote(table)} ADD COLUMN ${phys.ddl}`));
            }
            applied.push(`added nullable column ${table}.${column}`);
          }
          for (const ix of change.indexes) {
            if (ix.op === "dropped" || ix.op === "changed") dropIndex(table, ix.name);
            if (ix.op === "dropped") applied.push(`dropped index ${table}.${ix.name}`);
          }
          for (const ix of change.indexes) {
            if (ix.op === "added" || ix.op === "changed") {
              createIndex(tablePlan, ix.name);
              applied.push(`${ix.op === "added" ? "created" : "recreated"} index ${table}.${ix.name}`);
            }
          }
        }
        break;
      }
    }
  }

  return { ops, applied, problems };
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
