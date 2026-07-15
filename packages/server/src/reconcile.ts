/**
 * Schema reconciliation: diff the stored snapshot against the live schema
 * and make the database match — the MVP slice of the migrations design.
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
import { snapshotOf, type TableSnapshot } from "./snapshot.ts";

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

interface Named {
  kind: "enum" | "union";
  name: string;
  variants: string[];
  members?: Record<string, Descriptor>;
}

function unwrapDesc(desc: Descriptor): { base: Descriptor; nullable: boolean } {
  return desc["k"] === "nullable"
    ? { base: desc["inner"] as Descriptor, nullable: true }
    : { base: desc, nullable: false };
}

function namedOf(desc: Descriptor): Named | null {
  const { base } = unwrapDesc(desc);
  if (base["k"] === "enum") {
    return { kind: "enum", name: base["name"] as string, variants: [...(base["values"] as string[])] };
  }
  if (base["k"] === "union") {
    const members = base["members"] as Record<string, Descriptor>;
    return { kind: "union", name: base["name"] as string, variants: Object.keys(members), members };
  }
  return null;
}

function physColsOf(column: string, desc: Descriptor): string[] {
  return namedOf(desc)?.kind === "union" ? [column, `${column}__p`] : [column];
}

type Op = () => void;

export function reconcile(engine: Engine): { applied: string[] } {
  const target = snapshotOf(engine.schema);
  const current = engine.loadSnapshot();
  if (current === null) {
    engine.createAll();
    return { applied: [`initialized ${Object.keys(target.tables).length} table(s)`] };
  }
  if (JSON.stringify(current) === JSON.stringify(target)) return { applied: [] };

  const problems: string[] = [];
  const ops: Op[] = [];
  const applied: string[] = [];
  const writer = engine.writer;

  const count = (sql: string, ...params: unknown[]): number =>
    Number((writer.query(sql).get(...(params as never[])) as { n: bigint }).n);
  const rowCount = (table: string): number => count(`SELECT COUNT(*) AS n FROM ${quote(table)}`);

  const dropIndex = (table: string, index: string) =>
    ops.push(() => writer.exec(`DROP INDEX IF EXISTS ${quote(indexSqlName(table, index))}`));
  const createIndex = (plan: TablePlan, name: string) => {
    const index = plan.indexes.find((ix) => ix.name === name)!;
    if (index.unique) {
      const cols = index.columns.map(quote).join(", ");
      const dupes = count(
        `SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${quote(plan.name)} GROUP BY ${cols} HAVING COUNT(*) > 1)`,
      );
      if (dupes > 0) {
        problems.push(
          `${plan.name}.${name}: unique index over (${index.columns.join(", ")}), but ${dupes} group(s) of duplicate rows exist`,
        );
        return;
      }
    }
    ops.push(() => writer.exec(engine.indexDdl(plan, index)));
  };

  /** Rebuild `table` to the new plan, preserving intersecting columns and ids. */
  const rebuild = (plan: TablePlan, oldTable: TableSnapshot) => {
    ops.push(() => {
      const oldPhys = new Set(
        Object.entries(oldTable.columns).flatMap(([col, desc]) => physColsOf(col, desc)),
      );
      const copy = plan.physOrder.filter((c) => oldPhys.has(c)).map(quote).join(", ");
      const tmp = `${plan.name}__rebuild`;
      const seqRow = writer
        .query("SELECT seq FROM sqlite_sequence WHERE name = ?")
        .get(plan.name) as { seq: bigint } | null;
      writer.exec(engine.createTableDdl(plan, tmp));
      if (copy.length > 0) {
        writer.exec(`INSERT INTO ${quote(tmp)} (${copy}) SELECT ${copy} FROM ${quote(plan.name)}`);
      }
      writer.exec(`DROP TABLE ${quote(plan.name)}`);
      writer.exec(`ALTER TABLE ${quote(tmp)} RENAME TO ${quote(plan.name)}`);
      if (seqRow !== null) {
        // never reuse ids: restore the sequence high-water mark
        const changed = writer
          .query("UPDATE sqlite_sequence SET seq = ? WHERE name = ? AND seq < ?")
          .run(seqRow.seq, plan.name, seqRow.seq);
        if (changed.changes === 0 && count("SELECT COUNT(*) AS n FROM sqlite_sequence WHERE name = ?", plan.name) === 0) {
          writer.query("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)").run(plan.name, seqRow.seq);
        }
      }
      engine.createIndexesPhysical(plan);
    });
  };

  /**
   * Variant-level diff for a top-level enum/union column with an unchanged
   * type name. Returns true when it fully handled the change (safely or by
   * recording problems); false when this is really a column type change.
   */
  const diffVariants = (table: string, column: string, oldDesc: Descriptor, newDesc: Descriptor): boolean => {
    const oldNamed = namedOf(oldDesc);
    const newNamed = namedOf(newDesc);
    if (
      oldNamed === null ||
      newNamed === null ||
      oldNamed.kind !== newNamed.kind ||
      oldNamed.name !== newNamed.name ||
      unwrapDesc(oldDesc).nullable !== unwrapDesc(newDesc).nullable
    ) {
      return false;
    }
    const tags = engine.tags.get(newNamed.name)!;
    const holders = (variant: string): number => {
      const tag = tags.toTag.get(variant);
      if (tag === undefined) return 0;
      return count(`SELECT COUNT(*) AS n FROM ${quote(table)} WHERE ${quote(column)} = ?`, tag);
    };
    for (const variant of oldNamed.variants) {
      if (!newNamed.variants.includes(variant)) {
        const n = holders(variant);
        if (n > 0) {
          problems.push(`${table}.${column}: variant '${variant}' removed, but ${n} row(s) still hold it`);
        }
      } else if (
        oldNamed.kind === "union" &&
        JSON.stringify(oldNamed.members![variant]) !== JSON.stringify(newNamed.members![variant])
      ) {
        const n = holders(variant);
        if (n > 0) {
          problems.push(
            `${table}.${column}: variant '${variant}' payload type changed, but ${n} row(s) still hold it`,
          );
        }
      }
    }
    return true; // added/reordered variants are free — tags are stable
  };

  const allTables = new Set([...Object.keys(current.tables), ...Object.keys(target.tables)]);
  for (const table of [...allTables].sort()) {
    const oldTable = current.tables[table];
    const newTable = target.tables[table];

    // -- added / removed / kind change ---------------------------------------
    if (oldTable === undefined) {
      if (newTable!.kind === "table") {
        ops.push(() => engine.createTablePhysical(engine.plan(table)));
        applied.push(`created table ${table}`);
      } else {
        applied.push(`added event table ${table}`);
      }
      continue;
    }
    if (newTable === undefined || oldTable.kind !== newTable.kind) {
      const becoming = newTable === undefined ? "dropped" : `changed to an ${newTable.kind} table`;
      if (oldTable.kind === "table") {
        const n = rowCount(table);
        if (n > 0) {
          problems.push(`table ${table} ${becoming}, but it still holds ${n} row(s)`);
          continue;
        }
        ops.push(() => writer.exec(`DROP TABLE IF EXISTS ${quote(table)}`));
      }
      applied.push(`${becoming === "dropped" ? "dropped" : "converted"} ${table}`);
      if (newTable !== undefined && newTable.kind === "table") {
        ops.push(() => engine.createTablePhysical(engine.plan(table)));
      }
      continue;
    }
    if (oldTable.kind === "event") {
      // event tables have no storage; column changes are free
      if (JSON.stringify(oldTable) !== JSON.stringify(newTable)) {
        applied.push(`updated event table ${table}`);
      }
      continue;
    }

    // -- column diff ----------------------------------------------------------
    const plan = engine.plan(table);
    const rows = rowCount(table);
    let needsRebuild = false;
    const alterAdds: string[] = [];

    for (const column of Object.keys(newTable.columns)) {
      const oldDesc = oldTable.columns[column];
      const newDesc = newTable.columns[column]!;
      if (oldDesc === undefined) {
        const { nullable } = unwrapDesc(newDesc);
        if (nullable) {
          alterAdds.push(column);
        } else if (rows === 0) {
          needsRebuild = true;
        } else {
          problems.push(
            `${table}.${column}: required column added, but the table has ${rows} row(s) with no value for it`,
          );
        }
        continue;
      }
      if (JSON.stringify(oldDesc) === JSON.stringify(newDesc)) continue;
      if (diffVariants(table, column, oldDesc, newDesc)) continue;

      const old = unwrapDesc(oldDesc);
      const next = unwrapDesc(newDesc);
      const sameBase = JSON.stringify(old.base) === JSON.stringify(next.base);
      if (sameBase && !old.nullable && next.nullable) {
        needsRebuild = true; // widen: keep data, relax NOT NULL
        continue;
      }
      if (sameBase && old.nullable && !next.nullable) {
        const nulls = count(`SELECT COUNT(*) AS n FROM ${quote(table)} WHERE ${quote(column)} IS NULL`);
        if (nulls > 0) {
          problems.push(`${table}.${column}: made required, but ${nulls} row(s) hold NULL`);
        } else {
          needsRebuild = true;
        }
        continue;
      }
      if (rows === 0) {
        needsRebuild = true;
      } else {
        problems.push(
          `${table}.${column}: type changed, but ${rows} row(s) would need converting`,
        );
      }
    }

    for (const column of Object.keys(oldTable.columns)) {
      if (newTable.columns[column] !== undefined) continue;
      if (rows === 0) {
        needsRebuild = true;
      } else {
        problems.push(`${table}.${column}: column dropped, but the table still holds ${rows} row(s)`);
      }
    }

    // -- index diff -------------------------------------------------------------
    const oldIndexes = new Map(oldTable.indexes.map((ix) => [ix.name, ix]));
    const newIndexes = new Map(newTable.indexes.map((ix) => [ix.name, ix]));
    if (needsRebuild) {
      rebuild(plan, oldTable); // recreates every index from the new plan
      applied.push(`rebuilt table ${table}`);
    } else {
      for (const column of alterAdds) {
        const columnPlan = plan.columns.get(column)!;
        for (const phys of columnPlan.phys) {
          ops.push(() => writer.exec(`ALTER TABLE ${quote(table)} ADD COLUMN ${phys.ddl}`));
        }
        applied.push(`added nullable column ${table}.${column}`);
      }
      for (const [name, oldIx] of oldIndexes) {
        const newIx = newIndexes.get(name);
        if (newIx === undefined || JSON.stringify(oldIx) !== JSON.stringify(newIx)) {
          dropIndex(table, name);
          if (newIx === undefined) applied.push(`dropped index ${table}.${name}`);
        }
      }
      for (const [name, newIx] of newIndexes) {
        const oldIx = oldIndexes.get(name);
        if (oldIx === undefined || JSON.stringify(oldIx) !== JSON.stringify(newIx)) {
          createIndex(plan, name);
          applied.push(`${oldIx === undefined ? "created" : "recreated"} index ${table}.${name}`);
        }
      }
    }
  }

  if (problems.length > 0) throw new UnsafeSchemaChange(problems);

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
  return { applied: applied.length > 0 ? applied : ["updated schema snapshot"] };
}
