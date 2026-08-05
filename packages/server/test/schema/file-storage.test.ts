import { describe, expect, test } from "bun:test";
import {
  defineSchema,
  defineTable,
  Engine,
  makeDbWriter,
  newWriteCollector,
  v,
  type DbWriter,
  type FileId,
} from "@ackerdb/server";

describe("stored File references", () => {
  test("round-trips branded FileId values through INTEGER storage and equality predicates", async () => {
    const schema = defineSchema({
      documents: defineTable({
        id: v.primaryKey(),
        file: v.file(),
        preview: v.file().nullable(),
      }).index(["file"]),
    });
    const engine = new Engine(schema, ":memory:");
    engine.createAll();

    const fileId = 7n as FileId;
    engine.writer
      .query("INSERT INTO documents (file, preview) VALUES (?, ?)")
      .run(fileId, null);

    const db = makeDbWriter(
      engine,
      newWriteCollector(),
      () => 0n,
    ) as unknown as DbWriter<typeof schema>;
    const row = await db.documents
      .query()
      .where((document) => document.file.eq(fileId))
      .unique();

    expect(row).toEqual({ id: 1n, file: fileId, preview: null });
    expect(
      (engine.writer.query("PRAGMA table_info(documents)").all() as Array<{
        name: string;
        type: string;
      }>).find((column) => column.name === "file")?.type,
    ).toBe("INTEGER");

    engine.close("clean");
  });
});
