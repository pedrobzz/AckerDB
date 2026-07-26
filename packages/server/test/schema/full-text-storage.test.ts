import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CorruptDatabaseError,
  Engine,
  defineSchema,
  defineTable,
  makeDbWriter,
  newWriteCollector,
  reconcile,
  v,
} from "@ackerdb/server";

const directories: string[] = [];

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "ackerdb-full-text-storage-"));
  directories.push(directory);
  return join(directory, "data.db");
}

function documents(fullText: boolean) {
  const table = defineTable({
    id: v.primaryKey(),
    tenantId: v.bigint(),
    body: v.string().nullable(),
    title: v.string(),
  });
  return defineSchema({
    documents: fullText ? table.fullText(["body"]) : table,
  });
}

describe("full-text physical storage", () => {
  test("plain schemas initialize neither tokenizer machinery nor a full-text accessor", async () => {
    const engine = new Engine(documents(false), databasePath());
    reconcile(engine);
    const db: any = makeDbWriter(engine, newWriteCollector(), () => 0n);

    expect(
      (engine as unknown as { fullTextTokenizer: unknown }).fullTextTokenizer,
    ).toBeNull();
    expect(
      engine.writer
        .query("SELECT name FROM temp.sqlite_temp_master WHERE name LIKE '__ackerdb_fts%'")
        .all(),
    ).toEqual([]);
    expect(db.documents.fullText).toBeUndefined();

    await db.documents.insert({
      tenantId: 1n,
      body: "ordinary row",
      title: "plain table",
    });
    expect(await db.documents.query().take(1))
      .toEqual([{
        id: 1n,
        tenantId: 1n,
        body: "ordinary row",
        title: "plain table",
      }]);
    engine.close("clean");
  });

  test("creates one external-content sidecar and synchronizes every write shape", async () => {
    const engine = new Engine(documents(true), databasePath());
    engine.createAll();
    const db: any = makeDbWriter(engine, newWriteCollector(), () => 0n);
    const target = engine.plan("documents").fullText[0]!;

    const tokenizer = (
      engine as unknown as {
        fullTextTokenizer: {
          query(sql: string): { get(): Record<string, unknown> };
        };
      }
    ).fullTextTokenizer;
    expect(tokenizer).not.toBeNull();
    expect(tokenizer.query("PRAGMA temp_store").get()).toEqual({
      temp_store: 2n,
    });
    const first = await db.documents.insert({
      tenantId: 1n,
      body: "alpha restaurant",
      title: "first",
    });
    await db.documents.insert({
      tenantId: 1n,
      body: null,
      title: "nullable",
    });
    expect(
      engine.writer
        .query(`SELECT rowid FROM "${target.indexTable}" WHERE "${target.indexTable}" MATCH ?`)
        .all("alpha"),
    ).toEqual([{ rowid: first }]);

    await db.documents.patch(first, { title: "metadata only" });
    await db.documents.patch(first, { body: "beta bistro" });
    expect(
      engine.writer
        .query(`SELECT rowid FROM "${target.indexTable}" WHERE "${target.indexTable}" MATCH ?`)
        .all("alpha"),
    ).toEqual([]);
    expect(
      engine.writer
        .query(`SELECT rowid FROM "${target.indexTable}" WHERE "${target.indexTable}" MATCH ?`)
        .all("beta"),
    ).toEqual([{ rowid: first }]);

    await db.documents.replace(first, {
      tenantId: 2n,
      body: "gamma cafe",
      title: "replaced",
    });
    expect(
      engine.writer
        .query(`SELECT rowid FROM "${target.indexTable}" WHERE "${target.indexTable}" MATCH ?`)
        .all("gamma"),
    ).toEqual([{ rowid: first }]);

    await db.documents.delete(first);
    expect(
      engine.writer
        .query(`SELECT rowid FROM "${target.indexTable}" WHERE "${target.indexTable}" MATCH ?`)
        .all("gamma"),
    ).toEqual([]);
    engine.close("clean");
  });

  test("adding a target backfills existing rows before reconciliation reports ready", async () => {
    const path = databasePath();
    const initial = new Engine(documents(false), path);
    reconcile(initial);
    const db: any = makeDbWriter(initial, newWriteCollector(), () => 0n);
    const id = await db.documents.insert({
      tenantId: 1n,
      body: "existing restaurant",
      title: "before FTS",
    });
    initial.close("clean");

    const indexed = new Engine(documents(true), path);
    expect(reconcile(indexed).applied).toEqual([
      "created full-text target documents.body",
    ]);
    const target = indexed.plan("documents").fullText[0]!;
    expect(
      indexed.writer
        .query(`SELECT rowid FROM "${target.indexTable}" WHERE "${target.indexTable}" MATCH ?`)
        .all("restaurant"),
    ).toEqual([{ rowid: id }]);
    indexed.close("clean");
  });

  test("a failed backfill rolls back every derived object and preserves the old schema and rows", async () => {
    const path = databasePath();
    const initial = new Engine(documents(false), path);
    reconcile(initial);
    const oldSnapshot = initial.loadSnapshot();
    const db: any = makeDbWriter(initial, newWriteCollector(), () => 0n);
    await db.documents.insert({
      tenantId: 1n,
      body: "canonical restaurant",
      title: "survives",
    });
    initial.close("clean");

    const attempted = new Engine(documents(true), path);
    const create = attempted.createFullTextTargetPhysical.bind(attempted);
    attempted.createFullTextTargetPhysical = ((plan, column) => {
      create(plan, column);
      throw new Error("injected failure after full-text backfill");
    }) as Engine["createFullTextTargetPhysical"];

    expect(() => reconcile(attempted))
      .toThrow("injected failure after full-text backfill");
    expect(attempted.loadSnapshot()).toEqual(oldSnapshot);
    expect(
      attempted.writer
        .query("SELECT name FROM sqlite_master WHERE name LIKE '_ackerdb_fts_%'")
        .all(),
    ).toEqual([]);
    expect(
      attempted.writer
        .query('SELECT id, body, title FROM "documents"')
        .all(),
    ).toEqual([{
      id: 1n,
      body: "canonical restaurant",
      title: "survives",
    }]);
    attempted.close("unclean");

    const reopened = new Engine(documents(false), path);
    const reopenedDb: any = makeDbWriter(reopened, newWriteCollector(), () => 0n);
    expect(await reopenedDb.documents.get(1n)).toMatchObject({
      body: "canonical restaurant",
      title: "survives",
    });
    reopened.close("clean");
  });

  test("dropping a target removes its private catalog objects without touching rows", async () => {
    const path = databasePath();
    const indexed = new Engine(documents(true), path);
    reconcile(indexed);
    const db: any = makeDbWriter(indexed, newWriteCollector(), () => 0n);
    await db.documents.insert({
      tenantId: 1n,
      body: "kept row",
      title: "still here",
    });
    const prefix = indexed.plan("documents").fullText[0]!.indexTable;
    indexed.close("clean");

    const plain = new Engine(documents(false), path);
    expect(reconcile(plain).applied).toEqual([
      "dropped full-text target documents.body",
    ]);
    const plainDb: any = makeDbWriter(plain, newWriteCollector(), () => 0n);
    expect(await plainDb.documents.get(1n))
      .toMatchObject({ body: "kept row" });
    expect(
      plain.writer
        .query("SELECT name FROM sqlite_master WHERE name = ? OR name LIKE ?")
        .all(prefix, `${prefix}_%`),
    ).toEqual([]);
    plain.close("clean");
  });

  test("a base-table rebuild drops the old bundle and recreates a complete target", async () => {
    const path = databasePath();
    const required = defineSchema({
      documents: defineTable({
        id: v.primaryKey(),
        body: v.string(),
      }).fullText(["body"]),
    });
    const nullable = defineSchema({
      documents: defineTable({
        id: v.primaryKey(),
        body: v.string().nullable(),
      }).fullText(["body"]),
    });
    const first = new Engine(required, path);
    reconcile(first);
    const firstDb: any = makeDbWriter(first, newWriteCollector(), () => 0n);
    await firstDb.documents.insert({ body: "rebuilt restaurant" });
    const oldIndex = first.plan("documents").fullText[0]!.indexTable;
    first.close("clean");

    const rebuilt = new Engine(nullable, path);
    expect(reconcile(rebuilt).applied).toEqual(["rebuilt table documents"]);
    const rebuiltDb: any = makeDbWriter(rebuilt, newWriteCollector(), () => 0n);
    expect(await rebuiltDb.documents.fullText("body", "restaurant").take(5))
      .toEqual([{ id: 1n, body: "rebuilt restaurant" }]);
    expect(
      rebuilt.writer
        .query("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = ?")
        .get(oldIndex),
    ).toEqual({ count: 1n });
    await rebuiltDb.documents.patch(1n, { body: null });
    expect(await rebuiltDb.documents.fullText("body", "restaurant").first()).toBeNull();
    rebuilt.close("clean");
  });

  test("strict startup validation rejects a missing synchronization trigger", () => {
    const path = databasePath();
    const first = new Engine(documents(true), path);
    reconcile(first);
    const trigger = first.plan("documents").fullText[0]!.insertTrigger;
    first.writer.exec(`DROP TRIGGER "${trigger}"`);
    first.close("unclean");

    expect(() => new Engine(documents(true), path)).toThrow(CorruptDatabaseError);
  });
});
