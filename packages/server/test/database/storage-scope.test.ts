import { describe, expect, test } from "bun:test";
import {
  defineEventTable,
  defineSchema,
  defineTable,
  type DbStatementObservation,
  Engine,
  indexSqlName,
  makeDbReader,
  makeDbWriter,
  newWriteCollector,
  scanKey,
  snapshotOf,
  v,
} from "@ackerdb/server";
import { diffSnapshots } from "../../src/schema/diff.ts";
import { planDiff, verifyPlanProbes } from "../../src/schema/planner.ts";
import { withJobsTable } from "../../src/jobs/table.ts";

type StorageScope = ReturnType<Engine["createPluginScope"]>;

function createScopePhysical(engine: Engine, scope: StorageScope): void {
  engine.persistTags(scope);
  for (const plan of scope.plans.values()) engine.createTablePhysical(plan);
}

function privateSchema(statuses: [string, ...string[]]) {
  return defineSchema({
    entries: defineTable({
      id: v.primaryKey(),
      status: v.enum("Status", statuses),
      value: v.string(),
    }),
  });
}

describe("Plugin storage scopes", () => {
  test("isolates equal logical tables and named types inside one writer transaction", async () => {
    const engine = new Engine(defineSchema({}), ":memory:");
    engine.createAll();
    const alpha = engine.createPluginScope("alpha", privateSchema(["ready"]));
    const beta = engine.createPluginScope("beta", privateSchema(["blocked"]));
    const writes = newWriteCollector();
    const alphaDb: any = makeDbWriter(engine, writes, () => 0n, undefined, alpha);
    const betaDb: any = makeDbWriter(engine, writes, () => 0n, undefined, beta);

    engine.writer.exec("BEGIN IMMEDIATE");
    try {
      createScopePhysical(engine, alpha);
      createScopePhysical(engine, beta);
      expect(await alphaDb.entries.insert({ status: "ready", value: "left" })).toBe(1n);
      expect(await betaDb.entries.insert({ status: "blocked", value: "right" })).toBe(1n);
      expect(await alphaDb.entries.query().collect()).toEqual([
        { id: 1n, status: "ready", value: "left" },
      ]);
      expect(await betaDb.entries.query().collect()).toEqual([
        { id: 1n, status: "blocked", value: "right" },
      ]);
      engine.writer.exec("COMMIT");
    } catch (error) {
      if (engine.writer.inTransaction) engine.writer.exec("ROLLBACK");
      throw error;
    } finally {
      engine.close("clean");
    }
  });

  test("keeps logical db keys while SQL objects and reactive keys use physical names", async () => {
    const engine = new Engine(defineSchema({}), ":memory:");
    engine.createAll();
    const first = engine.createPluginScope("a", privateSchema(["ready"]));
    const second = engine.createPluginScope("a_b", privateSchema(["ready"]));
    const firstPlan = first.plan("entries");
    const secondPlan = second.plan("entries");
    const writes = newWriteCollector();
    const observations: DbStatementObservation[] = [];
    const firstDb: any = makeDbWriter(engine, writes, () => 0n, (observation) => {
      observations.push(observation);
    }, first);
    const secondDb: any = makeDbWriter(engine, writes, () => 0n, undefined, second);

    engine.writer.exec("BEGIN IMMEDIATE");
    try {
      createScopePhysical(engine, first);
      createScopePhysical(engine, second);
      await firstDb.entries.insert({ status: "ready", value: "one" });
      await secondDb.entries.insert({ status: "ready", value: "two" });
      engine.writer.exec("COMMIT");
    } catch (error) {
      if (engine.writer.inTransaction) engine.writer.exec("ROLLBACK");
      throw error;
    }

    expect(Object.keys(firstDb)).toEqual(["entries"]);
    expect(Object.keys(secondDb)).toEqual(["entries"]);
    const firstReader: any = makeDbReader(engine, engine.reader, null, undefined, first);
    expect(Object.keys(firstReader)).toEqual(["entries"]);
    expect(await firstReader.entries.query().collect()).toEqual([
      { id: 1n, status: "ready", value: "one" },
    ]);
    expect(firstPlan.logicalName).toBe("entries");
    expect(firstPlan.name).not.toBe("entries");
    expect(firstPlan.name).not.toBe(secondPlan.name);
    expect(firstPlan.displayName).toBe("a.entries");
    expect(secondPlan.displayName).toBe("a_b.entries");
    expect(
      engine.writer
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?) ORDER BY name")
        .all(firstPlan.name, secondPlan.name),
    ).toEqual([{ name: firstPlan.name }, { name: secondPlan.name }].sort((a, b) => a.name.localeCompare(b.name)));
    expect(writes.keys).toContain(scanKey(firstPlan.name));
    expect(writes.keys).toContain(scanKey(secondPlan.name));
    expect(writes.keys).not.toContain(scanKey("entries"));
    await expect(firstDb.entries.insert({ status: "missing", value: "bad" }))
      .rejects.toThrow("a.entries.insert.status");
    expect(observations).toContainEqual(expect.objectContaining({
      table: "a.entries",
      statement: "insert",
      outcome: "failed",
    }));
    expect(observations.some((observation) => observation.table === firstPlan.name)).toBe(false);
    engine.close("clean");
  });

  test("routes add, index, rebuild, and optimistic probe work to physical tables", () => {
    const engine = new Engine(defineSchema({}), ":memory:");
    engine.createAll();

    const additiveBefore = defineSchema({
      records: defineTable({ id: v.primaryKey(), value: v.string() }).index(["value"]),
    });
    const additiveAfter = defineSchema({
      records: defineTable({ id: v.primaryKey(), value: v.string(), note: v.string().nullable() })
        .index(["note"]),
    });
    const additiveCurrent = engine.createPluginScope("additive", additiveBefore);
    const additiveTarget = engine.createPluginScope("additive", additiveAfter);
    createScopePhysical(engine, additiveCurrent);
    const additivePlan = planDiff({
      engine,
      current: snapshotOf(withJobsTable(additiveBefore)),
      planOf: (table) => additiveTarget.plan(table),
    }, diffSnapshots(snapshotOf(withJobsTable(additiveBefore)), snapshotOf(withJobsTable(additiveAfter))));
    engine.writer.exec("BEGIN IMMEDIATE");
    try {
      for (const op of additivePlan.ops) op();
      engine.writer.exec("COMMIT");
    } catch (error) {
      if (engine.writer.inTransaction) engine.writer.exec("ROLLBACK");
      throw error;
    }
    const additivePhysical = additiveTarget.plan("records").name;
    const oldIndexName = indexSqlName(
      additivePhysical,
      additiveCurrent.plan("records").indexes[0]!.name,
    );
    const newIndexName = indexSqlName(
      additivePhysical,
      additiveTarget.plan("records").indexes[0]!.name,
    );
    expect(engine.writer.query(`PRAGMA table_info("${additivePhysical}")`).all())
      .toContainEqual(expect.objectContaining({ name: "note" }));
    expect(engine.writer.query(`PRAGMA index_list("${additivePhysical}")`).all())
      .toContainEqual(expect.objectContaining({ name: newIndexName }));
    expect(engine.writer.query(`PRAGMA index_list("${additivePhysical}")`).all())
      .not.toContainEqual(expect.objectContaining({ name: oldIndexName }));

    const rebuildBefore = defineSchema({
      records: defineTable({ id: v.primaryKey(), value: v.string() }),
    });
    const rebuildAfter = defineSchema({
      records: defineTable({ id: v.primaryKey(), value: v.string().nullable() }),
    });
    const rebuildCurrent = engine.createPluginScope("rebuilder", rebuildBefore);
    const rebuildTarget = engine.createPluginScope("rebuilder", rebuildAfter);
    createScopePhysical(engine, rebuildCurrent);
    const rebuildPhysical = rebuildTarget.plan("records").name;
    engine.writer.query(`INSERT INTO "${rebuildPhysical}" ("value") VALUES ('kept')`).run();
    const rebuildPlan = planDiff({
      engine,
      current: snapshotOf(withJobsTable(rebuildBefore)),
      planOf: (table) => rebuildTarget.plan(table),
    }, diffSnapshots(snapshotOf(withJobsTable(rebuildBefore)), snapshotOf(withJobsTable(rebuildAfter))));
    for (const op of rebuildPlan.ops) op();
    expect(engine.writer.query(`SELECT "value" FROM "${rebuildPhysical}"`).all()).toEqual([{ value: "kept" }]);

    const probeBefore = defineSchema({
      records: defineTable({ id: v.primaryKey(), value: v.string() }),
    });
    const probeAfter = defineSchema({
      records: defineTable({ id: v.primaryKey(), value: v.string() }).index(["value"], { unique: true }),
    });
    const probeCurrent = engine.createPluginScope("prober", probeBefore);
    const probeTarget = engine.createPluginScope("prober", probeAfter);
    createScopePhysical(engine, probeCurrent);
    const probePhysical = probeTarget.plan("records").name;
    engine.writer.exec(`INSERT INTO "${probePhysical}" ("value") VALUES ('same'), ('same')`);
    const probePlan = planDiff({
      engine,
      current: snapshotOf(withJobsTable(probeBefore)),
      planOf: (table) => probeTarget.plan(table),
    }, diffSnapshots(snapshotOf(withJobsTable(probeBefore)), snapshotOf(withJobsTable(probeAfter))));
    expect(() => verifyPlanProbes(probePlan)).toThrow("1 duplicate group(s)");
    engine.close("clean");
  });

  test("decodes scoped named tags during optimistic constraint probes", async () => {
    const engine = new Engine(defineSchema({}), ":memory:");
    engine.createAll();
    const before = defineSchema({
      records: defineTable({
        id: v.primaryKey(),
        payload: v.union("Payload", { text: v.string() }),
      }),
    });
    const target = defineSchema({
      records: defineTable({
        id: v.primaryKey(),
        payload: v.union("Payload", { text: v.string().min(2) }),
      }),
    });
    const currentScope = engine.createPluginScope("constraints", before);
    createScopePhysical(engine, currentScope);
    const db: any = makeDbWriter(engine, newWriteCollector(), () => 0n, undefined, currentScope);
    await db.records.insert({ payload: { tag: "text", value: "x" } });

    const targetScope = engine.createPluginScope("constraints", target);
    const plan = planDiff({
      engine,
      current: snapshotOf(withJobsTable(before)),
      planOf: (table) => targetScope.plan(table),
    }, diffSnapshots(snapshotOf(withJobsTable(before)), snapshotOf(withJobsTable(target))));
    expect(() => verifyPlanProbes(plan)).toThrow("1 existing row(s)");
    engine.close("clean");
  });

  test("rejects event and scheduled tables from Plugin storage", () => {
    const engine = new Engine(defineSchema({}), ":memory:");
    expect(() => engine.createPluginScope("bad-mount", privateSchema(["ready"])))
      .toThrow("Plugin storage mount must be an identifier");
    expect(() => engine.createPluginScope("events", defineSchema({
      messages: defineEventTable({ id: v.primaryKey(), body: v.string() }, {
        args: {},
        access: "public",
        matches: () => true,
      }),
    }))).toThrow("events.messages: Plugin private schemas cannot contain event tables");
    // v.scheduleAt() is framework-internal, so a scheduled table cannot even
    // be declared for a Plugin schema: defineSchema itself refuses it.
    expect(() => defineSchema({
      tasks: defineTable({ id: v.primaryKey(), at: v.scheduleAt() }),
    })).toThrow("framework-internal");
    engine.close("clean");
  });
});
