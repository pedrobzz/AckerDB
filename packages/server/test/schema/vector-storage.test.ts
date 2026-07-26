import { describe, expect, test } from "bun:test";
import {
  CorruptDatabaseError,
  defineSchema,
  defineTable,
  Engine,
  makeDbWriter,
  newWriteCollector,
  v,
} from "@ackerdb/server";

function writable(engine: Engine) {
  // Generated contexts own the public table shape; this seam exercises that
  // runtime interface against a real SQLite database.
  return makeDbWriter(engine, newWriteCollector(), () => 0n) as any;
}

describe("stored vectors", () => {
  test("stores canonical little-endian Float32 bytes and reads fresh plain arrays", async () => {
    const schema = defineSchema({
      documents: defineTable({
        id: v.primaryKey(),
        embedding: v.vector(3),
      }),
    });
    const engine = new Engine(schema, ":memory:");
    engine.createAll();
    const db = writable(engine);

    const id = await db.documents.insert({ embedding: [1.1, -0, 16_777_217] });
    const stored = engine.writer
      .query("SELECT embedding FROM documents WHERE id = ?")
      .get(id) as { embedding: Uint8Array };
    expect([...stored.embedding]).toEqual([
      205, 204, 140, 63,
      0, 0, 0, 0,
      0, 0, 128, 75,
    ]);

    const first = await db.documents.get(id);
    const second = await db.documents.get(id);
    expect(first.embedding).toEqual([1.100000023841858, 0, 16_777_216]);
    expect(Array.isArray(first.embedding)).toBe(true);
    expect(first.embedding).not.toBe(second.embedding);
    engine.close("clean");
  });

  test("canonicalizes a stored negative zero without losing neighboring coordinates", async () => {
    const schema = defineSchema({
      documents: defineTable({ id: v.primaryKey(), embedding: v.vector(3) }),
    });
    const engine = new Engine(schema, ":memory:");
    engine.createAll();
    engine.writer.query("INSERT INTO documents (embedding) VALUES (?)").run(
      new Uint8Array([
        0, 0, 128, 63,
        0, 0, 0, 128,
        0, 0, 0, 64,
      ]),
    );

    expect((await writable(engine).documents.get(1n)).embedding).toEqual([1, 0, 2]);
    engine.close("clean");
  });

  test("reports wrong blob type, length, and non-finite coordinates as storage corruption", async () => {
    const schema = defineSchema({
      documents: defineTable({ id: v.primaryKey(), embedding: v.vector(1) }),
    });
    const engine = new Engine(schema, ":memory:");
    engine.createAll();
    const db = writable(engine);
    const id = await db.documents.insert({ embedding: [1] });

    engine.writer.query("UPDATE documents SET embedding = ? WHERE id = ?").run("not-a-blob", id);
    await expect(db.documents.get(id)).rejects.toBeInstanceOf(CorruptDatabaseError);

    engine.writer.query("UPDATE documents SET embedding = ? WHERE id = ?").run(
      new Uint8Array([0, 0, 0]),
      id,
    );
    await expect(db.documents.get(id)).rejects.toBeInstanceOf(CorruptDatabaseError);

    engine.writer.query("UPDATE documents SET embedding = ? WHERE id = ?").run(
      new Uint8Array([0, 0, 192, 127]),
      id,
    );
    await expect(db.documents.get(id)).rejects.toBeInstanceOf(CorruptDatabaseError);
    engine.close("clean");
  });

  test("uses ordinary nullable insert, patch, and replace operations", async () => {
    const schema = defineSchema({
      documents: defineTable({
        id: v.primaryKey(),
        embedding: v.vector(2).nullable(),
      }),
    });
    const engine = new Engine(schema, ":memory:");
    engine.createAll();
    const db = writable(engine);

    const id = await db.documents.insert({});
    expect((await db.documents.get(id)).embedding).toBeNull();

    await db.documents.patch(id, { embedding: [1.1, 2] });
    expect((await db.documents.get(id)).embedding).toEqual([1.100000023841858, 2]);

    await db.documents.replace(id, { embedding: [3, 4] });
    expect((await db.documents.get(id)).embedding).toEqual([3, 4]);
    engine.close("clean");
  });
});
