import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import {
  CorruptDatabaseError,
  defineApp,
  definePlugin,
  defineSchema,
  defineTable,
  Engine,
  makeDbWriter,
  newWriteCollector,
  reconcile,
  restoreVerifiedDatabase,
  snapshotOf,
  v,
} from "@dbzz/server";
import {
  desiredStorageFingerprint,
  dropPluginStorage,
  PluginStorageRequirementsError,
  reconcilePluginStorage,
  resetPluginStorage,
  type DesiredPluginMounts,
  type PluginStorageDropRequirement,
  type PluginStorageResetRequirement,
} from "../../src/plugins/storage.ts";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function freshPath(): string {
  const root = mkdtempSync(join(tmpdir(), "dbzz-plugin-storage-test-"));
  roots.push(root);
  return join(root, "data.dbzz");
}

const rootSchema = defineSchema({
  roots: defineTable({ id: v.primaryKey(), value: v.string() }),
});

const entriesV1 = defineSchema({
  entries: defineTable({ id: v.primaryKey(), value: v.string() }),
});

const entriesAdditive = defineSchema({
  entries: defineTable({
    id: v.primaryKey(),
    value: v.string(),
    note: v.string().nullable(),
  }).index("by_note", ["note"]),
});

const entriesUnsafe = defineSchema({
  entries: defineTable({ id: v.primaryKey(), value: v.int() }),
});

function desired(
  mounts: Record<string, { definitionId: string; schema: typeof entriesV1 }>,
): DesiredPluginMounts {
  return mounts;
}

function open(path: string): Engine {
  const engine = new Engine(rootSchema, path);
  reconcile(engine);
  return engine;
}

function dbFor(engine: Engine, scope: ReturnType<Engine["createPluginScope"]>): any {
  return makeDbWriter(engine, newWriteCollector(), () => 0n, undefined, scope) as any;
}

function requirementsOf(work: () => unknown): PluginStorageRequirementsError {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(PluginStorageRequirementsError);
    return error as PluginStorageRequirementsError;
  }
  throw new Error("expected Plugin storage requirements");
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [
      key,
      canonicalJson((value as Record<string, unknown>)[key]),
    ]),
  );
}

function expectTransactionAndRollbackFailure(
  engine: Engine,
  work: () => unknown,
  failsPrimary: (sql: string) => boolean,
  message: string,
): void {
  const primary = new Error(`injected primary failure: ${message}`);
  const rollback = new Error(`injected rollback failure: ${message}`);
  const originalExec = engine.writer.exec;
  engine.writer.exec = ((sql: string) => {
    if (sql === "ROLLBACK") throw rollback;
    if (failsPrimary(sql)) throw primary;
    return originalExec.call(engine.writer, sql);
  }) as typeof engine.writer.exec;

  let failure: unknown;
  try {
    work();
  } catch (error) {
    failure = error;
  } finally {
    engine.writer.exec = originalExec;
    if (engine.writer.inTransaction) engine.writer.exec("ROLLBACK");
  }

  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).message).toBe(message);
  expect((failure as AggregateError).errors).toEqual([primary, rollback]);
}

describe("Plugin storage inventory", () => {
  test("persists isolated mounted instances over reopen", async () => {
    const path = freshPath();
    let engine = open(path);
    const mounts = desired({
      alpha: { definitionId: "cache", schema: entriesV1 },
      beta: { definitionId: "cache", schema: entriesV1 },
    });
    let result = reconcilePluginStorage(engine, mounts);
    await dbFor(engine, result.scopes.get("alpha")!).entries.insert({ value: "left" });
    await dbFor(engine, result.scopes.get("beta")!).entries.insert({ value: "right" });
    engine.close("clean");

    engine = open(path);
    result = reconcilePluginStorage(engine, mounts);
    expect(await dbFor(engine, result.scopes.get("alpha")!).entries.scan().collect())
      .toEqual([{ id: 1n, value: "left" }]);
    expect(await dbFor(engine, result.scopes.get("beta")!).entries.scan().collect())
      .toEqual([{ id: 1n, value: "right" }]);
    engine.close("clean");
  });

  test("normalizes prototype-shaped nested descriptors without losing fields", () => {
    const path = freshPath();
    const prototypeSchema = defineSchema({
      entries: defineTable({
        id: v.primaryKey(),
        payload: v.object({ ["__proto__"]: v.string() }),
      }),
    });
    const mounts = {
      cache: { definitionId: "cache", schema: prototypeSchema },
    } satisfies DesiredPluginMounts;
    let engine = open(path);
    reconcilePluginStorage(engine, mounts);
    const inventory = engine.writer
      .query("SELECT schema FROM _dbzz_plugins WHERE mount = 'cache'")
      .get() as { schema: string };
    const stored = JSON.parse(inventory.schema) as any;
    expect(Object.hasOwn(stored.tables.entries.columns.payload.shape, "__proto__")).toBe(true);
    engine.close("clean");

    engine = open(path);
    expect(() => reconcilePluginStorage(engine, mounts)).not.toThrow();
    engine.close("clean");
  });

  test("reconcile preserves its primary failure when rollback also fails", () => {
    const engine = open(freshPath());
    const mounts = desired({ alpha: { definitionId: "cache", schema: entriesV1 } });
    expectTransactionAndRollbackFailure(
      engine,
      () => reconcilePluginStorage(engine, mounts),
      (sql) => sql.startsWith("CREATE TABLE"),
      "Plugin storage reconciliation and rollback both failed",
    );
    engine.close("clean");
  });

  test("safe additive reconciliation retains rows and updates only the mounted layout", async () => {
    const engine = open(freshPath());
    const initial = desired({ alpha: { definitionId: "cache", schema: entriesV1 } });
    let result = reconcilePluginStorage(engine, initial);
    await dbFor(engine, result.scopes.get("alpha")!).entries.insert({ value: "kept" });

    const target = desired({ alpha: { definitionId: "cache", schema: entriesAdditive } });
    result = reconcilePluginStorage(engine, target);
    expect(result.applied).toEqual([
      "alpha: added nullable column entries.note",
      "alpha: created index entries.by_note",
    ]);
    expect(await dbFor(engine, result.scopes.get("alpha")!).entries.scan().collect())
      .toEqual([{ id: 1n, value: "kept", note: null }]);
    engine.close("clean");
  });

  test("a data refusal rolls every mount back before safe work starts", async () => {
    const duplicateSchema = defineSchema({
      entries: defineTable({ id: v.primaryKey(), value: v.string() }),
    });
    const uniqueSchema = defineSchema({
      entries: defineTable({ id: v.primaryKey(), value: v.string() })
        .index("by_value", ["value"], { unique: true }),
    });
    const engine = open(freshPath());
    const initial = {
      alpha: { definitionId: "alpha", schema: entriesV1 },
      beta: { definitionId: "beta", schema: duplicateSchema },
    } satisfies DesiredPluginMounts;
    const installed = reconcilePluginStorage(engine, initial);
    await dbFor(engine, installed.scopes.get("beta")!).entries.insert({ value: "same" });
    await dbFor(engine, installed.scopes.get("beta")!).entries.insert({ value: "same" });

    const target = {
      alpha: { definitionId: "alpha", schema: entriesAdditive },
      beta: { definitionId: "beta", schema: uniqueSchema },
    } satisfies DesiredPluginMounts;
    const error = requirementsOf(() => reconcilePluginStorage(engine, target));
    expect(error.requirements).toHaveLength(1);
    expect(error.requirements[0]).toMatchObject({
      kind: "reset",
      mount: "beta",
      reason: "data-refusal",
      plan: { refusals: [{ reason: "unique-index-duplicates", count: 1 }] },
    });
    const alphaPhysical = installed.scopes.get("alpha")!.plan("entries").name;
    expect(engine.writer.query(`PRAGMA table_info("${alphaPhysical}")`).all())
      .not.toContainEqual(expect.objectContaining({ name: "note" }));
    engine.close("clean");
  });

  test("unsafe schema and definition changes require an exact targeted reset", async () => {
    const engine = open(freshPath());
    await engine.writer.query("INSERT INTO roots (value) VALUES ('root')").run();
    const initial = {
      alpha: { definitionId: "cache", schema: entriesV1 },
      sibling: { definitionId: "cache", schema: entriesV1 },
    } satisfies DesiredPluginMounts;
    const installed = reconcilePluginStorage(engine, initial);
    await dbFor(engine, installed.scopes.get("alpha")!).entries.insert({ value: "discard" });
    await dbFor(engine, installed.scopes.get("sibling")!).entries.insert({ value: "keep" });

    const unsafe = {
      ...initial,
      alpha: { definitionId: "cache", schema: entriesUnsafe },
    } satisfies DesiredPluginMounts;
    const unsafeError = requirementsOf(() => reconcilePluginStorage(engine, unsafe));
    const reset = unsafeError.requirements[0] as PluginStorageResetRequirement;
    expect(reset).toMatchObject({ kind: "reset", mount: "alpha", reason: "unsafe-schema" });
    expect(reset.currentFingerprint).not.toBe(reset.targetFingerprint);
    const resetScope = resetPluginStorage(engine, unsafe, reset);
    expect(await dbFor(engine, resetScope).entries.scan().collect()).toEqual([]);
    expect(engine.writer.query("SELECT value FROM roots").all()).toEqual([{ value: "root" }]);
    expect(await dbFor(engine, installed.scopes.get("sibling")!).entries.scan().collect())
      .toEqual([{ id: 1n, value: "keep" }]);

    const changedDefinition = {
      ...unsafe,
      alpha: { definitionId: "cache-next", schema: entriesUnsafe },
    } satisfies DesiredPluginMounts;
    const identityError = requirementsOf(() => reconcilePluginStorage(engine, changedDefinition));
    expect(identityError.requirements[0]).toMatchObject({
      kind: "reset",
      mount: "alpha",
      reason: "definition-mismatch",
      currentDefinitionId: "cache",
      targetDefinitionId: "cache-next",
    });
    engine.close("clean");
  });

  test("reset preserves its primary failure when rollback also fails", () => {
    const engine = open(freshPath());
    const initial = desired({ alpha: { definitionId: "cache", schema: entriesV1 } });
    reconcilePluginStorage(engine, initial);
    const unsafe = { alpha: { definitionId: "cache", schema: entriesUnsafe } } satisfies DesiredPluginMounts;
    const requirement = requirementsOf(() => reconcilePluginStorage(engine, unsafe))
      .requirements[0] as PluginStorageResetRequirement;

    expectTransactionAndRollbackFailure(
      engine,
      () => resetPluginStorage(engine, unsafe, requirement),
      (sql) => sql.startsWith("DROP TABLE"),
      "Plugin storage reset and rollback both failed: alpha",
    );
    engine.close("clean");
  });

  test("stale consent performs no writes", () => {
    const engine = open(freshPath());
    const initial = desired({ alpha: { definitionId: "cache", schema: entriesV1 } });
    const installed = reconcilePluginStorage(engine, initial);
    const unsafe = { alpha: { definitionId: "cache", schema: entriesUnsafe } } satisfies DesiredPluginMounts;
    const oldRequirement = requirementsOf(() => reconcilePluginStorage(engine, unsafe))
      .requirements[0] as PluginStorageResetRequirement;

    const additive = { alpha: { definitionId: "cache", schema: entriesAdditive } } satisfies DesiredPluginMounts;
    reconcilePluginStorage(engine, additive);
    expect(() => resetPluginStorage(engine, unsafe, oldRequirement)).toThrow("stale Plugin storage consent");
    const physical = installed.scopes.get("alpha")!.plan("entries").name;
    expect(engine.writer.query(`PRAGMA table_info("${physical}")`).all())
      .toContainEqual(expect.objectContaining({ name: "note" }));
    engine.close("clean");
  });

  test("a stale mount requires exact drop and preserves root plus siblings", async () => {
    const engine = open(freshPath());
    engine.writer.query("INSERT INTO roots (value) VALUES ('root')").run();
    const initial = {
      oldCache: { definitionId: "cache", schema: entriesV1 },
      sibling: { definitionId: "cache", schema: entriesV1 },
    } satisfies DesiredPluginMounts;
    const installed = reconcilePluginStorage(engine, initial);
    await dbFor(engine, installed.scopes.get("oldCache")!).entries.insert({ value: "old" });
    await dbFor(engine, installed.scopes.get("sibling")!).entries.insert({ value: "sibling" });

    const target = {
      newCache: { definitionId: "cache", schema: entriesV1 },
      sibling: initial.sibling,
    } satisfies DesiredPluginMounts;
    const error = requirementsOf(() => reconcilePluginStorage(engine, target));
    const drop = error.requirements.find((item) => item.kind === "drop") as PluginStorageDropRequirement;
    expect(drop).toMatchObject({ kind: "drop", mount: "oldCache", reason: "stale-mount" });
    expect(error.requirements).toHaveLength(1);
    dropPluginStorage(engine, target, drop);
    const reconciled = reconcilePluginStorage(engine, target);
    expect(await dbFor(engine, reconciled.scopes.get("newCache")!).entries.scan().collect()).toEqual([]);
    expect(await dbFor(engine, reconciled.scopes.get("sibling")!).entries.scan().collect())
      .toEqual([{ id: 1n, value: "sibling" }]);
    expect(engine.writer.query("SELECT value FROM roots").all()).toEqual([{ value: "root" }]);
    engine.close("clean");
  });

  test("drop preserves its primary failure when rollback also fails", () => {
    const engine = open(freshPath());
    const initial = desired({ alpha: { definitionId: "cache", schema: entriesV1 } });
    reconcilePluginStorage(engine, initial);
    const absent = {} satisfies DesiredPluginMounts;
    const requirement = requirementsOf(() => reconcilePluginStorage(engine, absent))
      .requirements[0] as PluginStorageDropRequirement;

    expectTransactionAndRollbackFailure(
      engine,
      () => dropPluginStorage(engine, absent, requirement),
      (sql) => sql.startsWith("DROP TABLE"),
      "Plugin storage drop and rollback both failed: alpha",
    );
    engine.close("clean");
  });

  test("drop consent becomes stale when the app re-adds the mount", () => {
    const engine = open(freshPath());
    const initial = desired({ alpha: { definitionId: "cache", schema: entriesV1 } });
    const installed = reconcilePluginStorage(engine, initial);
    const absent = {} satisfies DesiredPluginMounts;
    const drop = requirementsOf(() => reconcilePluginStorage(engine, absent))
      .requirements[0] as PluginStorageDropRequirement;

    const readded = {
      alpha: { definitionId: "cache-next", schema: entriesV1 },
    } satisfies DesiredPluginMounts;
    expect(() => dropPluginStorage(engine, readded, drop)).toThrow("stale Plugin storage consent");
    const physical = installed.scopes.get("alpha")!.plan("entries").name;
    expect(engine.writer.query("SELECT name FROM sqlite_master WHERE name = ?").get(physical))
      .toEqual({ name: physical });
    engine.close("clean");
  });

  test("orders required Plugin storage actions by UTF-16 mount code units", () => {
    const engine = open(freshPath());
    reconcilePluginStorage(engine, {
      i: { definitionId: "cache", schema: entriesV1 },
      IA: { definitionId: "cache", schema: entriesV1 },
    });

    const error = requirementsOf(() => reconcilePluginStorage(engine, {}));
    expect(error.requirements.map((requirement) => requirement.mount)).toEqual(["IA", "i"]);
    expect(error.requirements.every((requirement) => requirement.kind === "drop")).toBe(true);
    engine.close("clean");
  });

  test("the layout fingerprint binds root and sorted Plugin inventory", async () => {
    const path = freshPath();
    let engine = open(path);
    const rootOnly = engine.schemaFingerprint();
    const mounts = {
      beta: { definitionId: "cache", schema: entriesV1 },
      alpha: { definitionId: "cache", schema: entriesV1 },
    } satisfies DesiredPluginMounts;
    reconcilePluginStorage(engine, mounts);
    const withPlugins = engine.schemaFingerprint();
    expect(withPlugins).not.toBe(rootOnly);
    expect(desiredStorageFingerprint(rootSchema, mounts)).toBe(withPlugins);
    expect(desiredStorageFingerprint(rootSchema, {
      ...mounts,
      gamma: mounts.alpha,
    })).not.toBe(withPlugins);
    expect(desiredStorageFingerprint(rootSchema, {
      ...mounts,
      alpha: { ...mounts.alpha, definitionId: "cache-next" },
    })).not.toBe(withPlugins);
    expect(desiredStorageFingerprint(rootSchema, {
      ...mounts,
      alpha: { ...mounts.alpha, schema: entriesAdditive },
    })).not.toBe(withPlugins);
    const artifact = join(roots.at(-1)!, "backup.dbzz");
    const manifest = engine.backup(artifact);
    expect(manifest.schemaFingerprint).toBe(withPlugins);
    engine.close("clean");

    engine = open(path);
    expect(engine.schemaFingerprint()).toBe(withPlugins);
    engine.close("clean");

    const restoredPath = freshPath();
    const cachePlugin = definePlugin({
      id: "cache",
      schema: entriesV1,
      create: () => ({ exports: {} }),
    });
    const restoredApp = defineApp({
      schema: rootSchema,
      plugins: { alpha: cachePlugin(), beta: cachePlugin() },
    });
    await restoreVerifiedDatabase(artifact, restoredPath, manifest, () => restoredApp);
    engine = open(restoredPath);
    expect(engine.schemaFingerprint()).toBe(withPlugins);
    expect(() => reconcilePluginStorage(engine, mounts)).not.toThrow();
    engine.close("clean");
  });

  test("the layout fingerprint orders Plugin mounts by UTF-16 code units", () => {
    const mounts = {
      i: { definitionId: "second", schema: entriesV1 },
      IA: { definitionId: "first", schema: entriesV1 },
    } satisfies DesiredPluginMounts;
    const schema = snapshotOf(entriesV1);
    const expected = createHash("sha256")
      .update(JSON.stringify(canonicalJson({
        root: snapshotOf(rootSchema),
        plugins: [
          { mount: "IA", definitionId: "first", schema },
          { mount: "i", definitionId: "second", schema },
        ],
      })))
      .digest("hex");

    expect(desiredStorageFingerprint(rootSchema, mounts)).toBe(expected);
  });

  test("public restore rejects every kind of target App layout drift before staging", async () => {
    const source = freshPath();
    const engine = open(source);
    reconcilePluginStorage(engine, {
      alpha: { definitionId: "cache", schema: entriesV1 },
    });
    const artifact = join(roots.at(-1)!, "layout-backup.dbzz");
    const manifest = engine.backup(artifact);
    engine.close("clean");

    const plugin = (id: string, schema: typeof entriesV1 | typeof entriesAdditive) => definePlugin({
      id,
      schema,
      create: () => ({ exports: {} }),
    })();
    const wrongRoot = defineApp({
      schema: defineSchema({ other: defineTable({ id: v.primaryKey() }) }),
      plugins: { alpha: plugin("cache", entriesV1) },
    });
    const missingMount = defineApp({ schema: rootSchema });
    const renamedMount = defineApp({
      schema: rootSchema,
      plugins: { beta: plugin("cache", entriesV1) },
    });
    const wrongDefinition = defineApp({
      schema: rootSchema,
      plugins: { alpha: plugin("cache-next", entriesV1) },
    });
    const wrongPrivateSchema = defineApp({
      schema: rootSchema,
      plugins: { alpha: plugin("cache", entriesAdditive) },
    });

    for (const candidate of [wrongRoot, missingMount, renamedMount, wrongDefinition, wrongPrivateSchema]) {
      const target = freshPath();
      await expect(
        restoreVerifiedDatabase(artifact, target, manifest, () => candidate),
      ).rejects.toThrow("target App storage layout");
      expect(existsSync(target)).toBe(false);
    }
  });

  test("malformed inventory, physical objects, and scoped tags fail reopen", () => {
    const corrupt = (
      mutate: (db: Database, physical: string, tagIdentity: string) => void,
    ): void => {
      const path = freshPath();
      const engine = open(path);
      const tagged = defineSchema({
        entries: defineTable({ id: v.primaryKey(), status: v.enum("Status", ["ready"]) })
          .index("by_status", ["status"]),
      });
      const installed = reconcilePluginStorage(engine, {
        cache: { definitionId: "cache", schema: tagged },
      });
      const scope = installed.scopes.get("cache")!;
      const physical = scope.plan("entries").name;
      const tagIdentity = scope.tagIdentity("Status");
      engine.close("clean");

      const raw = new Database(path, { safeIntegers: true });
      mutate(raw, physical, tagIdentity);
      raw.close(false);
      expect(() => new Engine(rootSchema, path)).toThrow(CorruptDatabaseError);
    };

    corrupt((db) => {
      db.query("UPDATE _dbzz_plugins SET schema = '{bad json'").run();
    });
    corrupt((db, physical) => {
      db.exec(`DROP TABLE "${physical}"`);
    });
    corrupt((db, physical) => {
      db.exec(`DROP INDEX "ix_${physical}_by_status"`);
    });
    corrupt((db, _physical, tagIdentity) => {
      db.query("DELETE FROM _dbzz_tags WHERE type = ?").run(tagIdentity);
    });
    corrupt((db) => {
      db.exec('CREATE TABLE "_dbzz_plugin_5:ghostentries" ("id" INTEGER PRIMARY KEY AUTOINCREMENT)');
    });
    corrupt((db) => {
      db.query("INSERT INTO _dbzz_tags (type, variant, tag) VALUES ('5:ghostStatus', 'ready', 0)").run();
    });
  });
});
