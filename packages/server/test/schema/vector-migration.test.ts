import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFrameworkTables } from "../../src/database/framework-schema.ts";
import {
  classifySchemaDiff,
  defineMigration,
  defineSchema,
  defineTable,
  diffSnapshots,
  Engine,
  makeDbWriter,
  newWriteCollector,
  reconcile,
  snapshotOf,
  v,
  type MigrationStep,
} from "@ackerdb/server";

const directories: string[] = [];
afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "ackerdb-vector-migration-"));
  directories.push(directory);
  return join(directory, "data.db");
}

function writable(engine: Engine) {
  return makeDbWriter(engine, newWriteCollector(), () => 0n) as any;
}

describe("vector migrations", () => {
  test("adds a nullable vector through ordinary shape-safe reconciliation", async () => {
    const before = defineSchema({
      documents: defineTable({ id: v.primaryKey(), title: v.string() }),
    });
    const target = defineSchema({
      documents: defineTable({
        id: v.primaryKey(),
        title: v.string(),
        embedding: v.vector(2).nullable(),
      }),
    });
    const path = databasePath();
    const seeded = new Engine(before, path);
    reconcile(seeded);
    await writable(seeded).documents.insert({ title: "first" });
    seeded.close("clean");

    const reopened = new Engine(target, path);
    await reconcile(reopened);
    expect(await writable(reopened).documents.get(1n)).toEqual({
      id: 1n,
      title: "first",
      embedding: null,
    });
    reopened.close("clean");
  });

  test("requires a transform for dimension changes and re-encodes transformed rows", async () => {
    const before = defineSchema({
      documents: defineTable({ id: v.primaryKey(), embedding: v.vector(2) }),
    });
    const target = defineSchema({
      documents: defineTable({ id: v.primaryKey(), embedding: v.vector(3) }),
    });
    const classification = classifySchemaDiff(diffSnapshots(snapshotOf(withFrameworkTables(before)), snapshotOf(withFrameworkTables(target))));
    expect(classification.refusals).toMatchObject([
      { table: "documents", column: "embedding", reason: "column-type-changed" },
    ]);

    const path = databasePath();
    const seeded = new Engine(before, path);
    reconcile(seeded);
    await writable(seeded).documents.insert({ embedding: [1, 2] });
    seeded.close("clean");

    const migrated = new Engine(target, path);
    const pre = migrated.loadSnapshot()!;
    const step: MigrationStep = {
      number: 1,
      name: "resize_embedding",
      pre,
      target: snapshotOf(withFrameworkTables(target)),
      code: "",
      migration: defineMigration({
        tables: {
          documents: (row) => ({ ...row, embedding: [...row.embedding as number[], 3] }),
        },
      }),
    };
    await reconcile(migrated, [step]);

    expect((await writable(migrated).documents.get(1n)).embedding).toEqual([1, 2, 3]);
    const raw = migrated.writer.query("SELECT embedding FROM documents WHERE id = 1").get() as {
      embedding: Uint8Array;
    };
    expect(raw.embedding.byteLength).toBe(12);
    migrated.close("clean");

    const reopened = new Engine(target, path);
    await reconcile(reopened);
    expect((await writable(reopened).documents.get(1n)).embedding).toEqual([1, 2, 3]);
    reopened.close("clean");
  });

  test("classifies required additions and nullable-to-required changes as shape-unsafe", () => {
    const empty = defineSchema({
      documents: defineTable({ id: v.primaryKey() }),
    });
    const nullable = defineSchema({
      documents: defineTable({ id: v.primaryKey(), embedding: v.vector(2).nullable() }),
    });
    const required = defineSchema({
      documents: defineTable({ id: v.primaryKey(), embedding: v.vector(2) }),
    });

    expect(classifySchemaDiff(diffSnapshots(snapshotOf(withFrameworkTables(empty)), snapshotOf(withFrameworkTables(required)))).refusals)
      .toMatchObject([{ reason: "required-column-added", column: "embedding" }]);
    expect(classifySchemaDiff(diffSnapshots(snapshotOf(withFrameworkTables(nullable)), snapshotOf(withFrameworkTables(required)))).refusals)
      .toMatchObject([{ reason: "column-made-required", column: "embedding" }]);
  });
});
