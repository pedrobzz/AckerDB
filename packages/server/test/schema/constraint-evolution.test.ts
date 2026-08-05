import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifySchemaDiff,
  CorruptDatabaseError,
  v,
  defineSchema,
  defineTable,
  diffSnapshots,
  Engine,
  makeDbWriter,
  newWriteCollector,
  probeOptimisticChanges,
  reconcile,
  snapshotOf,
  UnsafeSchemaChange,
  type OptimisticChange,
  type Schema,
} from "@ackerdb/server";
import { commitPlan, planDiff, SchemaPlanner } from "../../src/schema/planner.ts";
import { constraintDirection } from "../../src/schema/diff.ts";
import { withFrameworkTables } from "../../src/database/framework-schema.ts";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function freshPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "ackerdb-constraints-"));
  dirs.push(dir);
  return join(dir, "data.db");
}

function writer(engine: Engine) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return makeDbWriter(engine, newWriteCollector(), () => 0n) as any;
}

async function seed(schema: Schema, path: string, rows: Record<string, unknown>[]): Promise<void> {
  const engine = new Engine(schema, path);
  reconcile(engine);
  const db = writer(engine);
  for (const row of rows) await db.items.insert(row);
  engine.close("clean");
}

describe("constraint-aware schema diff", () => {
  test("prototype-named tables and columns remain own entries through add and drop diffs", () => {
    const empty = defineSchema({});
    const tableOnly = defineSchema({
      toString: defineTable({ id: v.primaryKey() }),
    });
    const withColumn = defineSchema({
      toString: defineTable({ id: v.primaryKey(), constructor: v.string() }),
    });

    expect(diffSnapshots(snapshotOf(withFrameworkTables(empty)), snapshotOf(withFrameworkTables(tableOnly)))).toEqual([
      { op: "table-added", table: "toString", kind: "table" },
    ]);
    expect(diffSnapshots(snapshotOf(withFrameworkTables(tableOnly)), snapshotOf(withFrameworkTables(empty)))).toEqual([
      { op: "table-dropped", table: "toString", kind: "table" },
    ]);
    expect(diffSnapshots(snapshotOf(withFrameworkTables(tableOnly)), snapshotOf(withFrameworkTables(withColumn)))[0]).toMatchObject({
      op: "table-altered",
      table: "toString",
      columns: [{ op: "added", column: "constructor" }],
    });
    expect(diffSnapshots(snapshotOf(withFrameworkTables(withColumn)), snapshotOf(withFrameworkTables(tableOnly)))[0]).toMatchObject({
      op: "table-altered",
      table: "toString",
      columns: [{ op: "dropped", column: "constructor" }],
    });
  });

  test("a __proto__ object field remains structural data", () => {
    const stringField = v.object({ ["__proto__"]: v.string() });
    const intField = v.object({ ["__proto__"]: v.int() });
    expect(constraintDirection(stringField.descriptor(), intField.descriptor())).toBe("incompatible");
  });

  test("recurses through composite descriptors without treating field names as constraint slots", () => {
    const before = v.object({
      min: v.string(),
      payload: v.array(v.union("Payload", {
        text: v.object({ regex: v.string(), score: v.int() }),
        count: v.bigint(),
      })),
    });
    const tightened = v.object({
      min: v.string(),
      payload: v.array(v.union("Payload", {
        text: v.object({ regex: v.string(), score: v.int().min(0) }),
        count: v.bigint(),
      })),
    });
    expect(constraintDirection(before.descriptor(), tightened.descriptor())).toBe("tighten");

    const changedField = v.object({
      min: v.int(),
      payload: v.array(v.union("Payload", {
        text: v.object({ regex: v.string(), score: v.int() }),
        count: v.bigint(),
      })),
    });
    expect(constraintDirection(before.descriptor(), changedField.descriptor())).toBe("incompatible");
  });

  test("classifies widen/remove as loosen and mixed movement or regex changes as tighten", () => {
    expect(constraintDirection(v.bigint().min(10n).max(20n).descriptor(), v.bigint().min(5n).max(30n).descriptor()))
      .toBe("loosen");
    expect(constraintDirection(v.string().min(2).max(8).descriptor(), v.string().min(1).max(4).descriptor()))
      .toBe("tighten");
    expect(constraintDirection(v.string().regex(/^a/).descriptor(), v.string().regex(/^b/).descriptor()))
      .toBe("tighten");
    expect(constraintDirection(v.string().regex(/^a/).descriptor(), v.string().descriptor())).toBe("loosen");
  });

  test("emits a constraint atom only when the whole column is structurally identical", () => {
    const before = defineSchema({ items: defineTable({ id: v.primaryKey(), value: v.array(v.string()) }) });
    const target = defineSchema({ items: defineTable({ id: v.primaryKey(), value: v.array(v.string().min(1)) }) });
    expect(diffSnapshots(snapshotOf(withFrameworkTables(before)), snapshotOf(withFrameworkTables(target)))[0]).toMatchObject({
      op: "table-altered",
      columns: [{ op: "constraints-changed", column: "value", direction: "tighten" }],
    });

    const mixed = defineSchema({
      items: defineTable({ id: v.primaryKey(), value: v.array(v.int().min(1)) }),
    });
    expect(diffSnapshots(snapshotOf(withFrameworkTables(before)), snapshotOf(withFrameworkTables(mixed)))[0]).toMatchObject({
      op: "table-altered",
      columns: [{ op: "type-changed", column: "value" }],
    });
  });
});

describe("constraint reconciliation", () => {
  test("a loosen applies without a row probe and updates the stored contract", async () => {
    const before = defineSchema({ items: defineTable({ id: v.primaryKey(), value: v.string().min(3) }) });
    const target = defineSchema({ items: defineTable({ id: v.primaryKey(), value: v.string().min(1) }) });
    const path = freshPath();
    await seed(before, path, [{ value: "abc" }]);

    const engine = new Engine(target, path);
    expect(reconcile(engine).applied).toEqual(["loosened constraints items.value"]);
    expect(engine.loadSnapshot()).toEqual(snapshotOf(withFrameworkTables(target)));
    engine.close("clean");
  });

  test("one bounded table scan counts every tightened column exactly and skips valid nullable nulls", async () => {
    const before = defineSchema({
      items: defineTable({
        id: v.primaryKey(),
        profile: v.object({ handle: v.string() }),
        score: v.int(),
        nickname: v.string().nullable(),
      }),
    });
    const target = defineSchema({
      items: defineTable({
        id: v.primaryKey(),
        profile: v.object({ handle: v.string().min(2) }),
        score: v.int().min(0),
        nickname: v.string().min(2).nullable(),
      }),
    });
    const path = freshPath();
    await seed(before, path, [
      { profile: { handle: "" }, score: -1, nickname: null },
      { profile: { handle: "a" }, score: 1, nickname: null },
      { profile: { handle: "good" }, score: -2, nickname: "ok" },
    ]);

    const engine = new Engine(target, path);
    const current = engine.loadSnapshot()!;
    const optimistic = classifySchemaDiff(diffSnapshots(current, snapshotOf(withFrameworkTables(target)))).optimistic;
    let tableScans = 0;
    const countedWriter = new Proxy(engine.writer, {
      get(database, key) {
        if (key !== "query") return Reflect.get(database, key, database);
        return (sql: string) => {
          if (sql.includes('FROM "items"') && sql.includes("ORDER BY")) tableScans++;
          return database.query(sql);
        };
      },
    });
    const refusals = probeOptimisticChanges(
      countedWriter,
      current,
      optimistic.map((change) => ({ change, phys: { table: change.table, column: (column) => column } })),
      () => [],
    );
    expect(tableScans).toBe(1);
    expect(refusals).toEqual([
      {
        table: "items",
        column: "profile",
        reason: "constraint-violations",
        question: "constraints tightened; 2 existing row(s) violate the target validator",
        count: 2,
      },
      {
        table: "items",
        column: "score",
        reason: "constraint-violations",
        question: "constraints tightened; 2 existing row(s) violate the target validator",
        count: 2,
      },
    ]);

    expect(() => reconcile(engine)).toThrow(UnsafeSchemaChange);
    expect(engine.loadSnapshot()).toEqual(current);
    expect((engine.writer.query("SELECT COUNT(*) AS n FROM items").get() as { n: bigint }).n).toBe(3n);
    engine.close("clean");
  });

  test("a clean tighten applies while nullable null remains valid", async () => {
    const before = defineSchema({
      items: defineTable({ id: v.primaryKey(), value: v.string().nullable() }),
    });
    const target = defineSchema({
      items: defineTable({ id: v.primaryKey(), value: v.string().min(2).nullable() }),
    });
    const path = freshPath();
    await seed(before, path, [{ value: null }, { value: "ok" }]);
    const engine = new Engine(target, path);
    expect(reconcile(engine).applied).toEqual(["tightened constraints items.value"]);
    expect(engine.loadSnapshot()).toEqual(snapshotOf(withFrameworkTables(target)));
    engine.close("clean");
  });

  test("recorded validation runs before the nullable skip and reports corruption", async () => {
    const physical = defineSchema({
      items: defineTable({ id: v.primaryKey(), value: v.string().nullable() }),
    });
    const recorded = defineSchema({ items: defineTable({ id: v.primaryKey(), value: v.string() }) });
    const target = defineSchema({ items: defineTable({ id: v.primaryKey(), value: v.string().min(1) }) });
    const path = freshPath();
    await seed(physical, path, [{ value: null }]);
    const engine = new Engine(physical, path);
    const current = snapshotOf(withFrameworkTables(recorded));
    const optimistic = classifySchemaDiff(diffSnapshots(current, snapshotOf(withFrameworkTables(target)))).optimistic;
    expect(() => probeOptimisticChanges(
      engine.writer,
      current,
      optimistic.map((change) => ({ change, phys: { table: change.table, column: (column) => column } })),
      () => [],
    )).toThrow(CorruptDatabaseError);
    engine.close("clean");
  });

  test("the writer re-probes after BEGIN IMMEDIATE and refuses a stale clean plan before writes", async () => {
    const before = defineSchema({ items: defineTable({ id: v.primaryKey(), value: v.string() }) });
    const target = defineSchema({ items: defineTable({ id: v.primaryKey(), value: v.string().min(2) }) });
    const path = freshPath();
    await seed(before, path, [{ value: "ok" }]);
    const engine = new Engine(target, path);
    const current = engine.loadSnapshot()!;
    const targetSnapshot = snapshotOf(withFrameworkTables(target));
    const plan = planDiff(
      { engine, current, planOf: (table) => engine.plan(table) },
      diffSnapshots(current, targetSnapshot),
    );
    expect(plan.refusals).toEqual([]);

    engine.writer.query('INSERT INTO "items" ("value") VALUES (?)').run("x");
    expect(() => commitPlan(engine, targetSnapshot, plan)).toThrow("1 existing row(s)");
    expect(engine.loadSnapshot()).toEqual(current);
    expect((engine.writer.query("SELECT COUNT(*) AS n FROM items").get() as { n: bigint }).n).toBe(2n);
    engine.close("clean");
  });

  test("a materialized planner rejects all later mutation", () => {
    const schema = defineSchema({ items: defineTable({ id: v.primaryKey(), value: v.string() }) });
    const path = freshPath();
    const engine = new Engine(schema, path);
    reconcile(engine);
    const current = engine.loadSnapshot()!;
    const planner = new SchemaPlanner({ engine, current, planOf: (table) => engine.plan(table) });
    void planner.plan;
    expect(() => planner.safe({ op: "loosen-constraints", table: "items", column: "value" })).toThrow(
      "after reading the schema plan",
    );
    const optimistic: OptimisticChange = {
      op: "tighten-constraints",
      table: "items",
      column: "value",
      current: v.string().descriptor(),
      target: v.string().min(1).descriptor(),
    };
    expect(() => planner.optimistic(optimistic)).toThrow("after reading the schema plan");
    engine.close("clean");
  });
});
