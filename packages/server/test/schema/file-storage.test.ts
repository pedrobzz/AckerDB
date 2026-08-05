import { describe, expect, test } from "bun:test";
import {
  defineSchema,
  defineTable,
  Engine,
  makeDbWriter,
  newWriteCollector,
  v,
  type DbWriter,
  type FileGrantId,
  type FileId,
} from "@ackerdb/server";

describe("stored File references", () => {
  test("round-trips branded File and Grant identities through INTEGER storage", async () => {
    const schema = defineSchema({
      documents: defineTable({
        id: v.primaryKey(),
        file: v.file(),
        preview: v.file().nullable(),
        grant: v.fileGrant(),
      }).index(["file"]),
      urlRefs: defineTable({
        id: v.primaryKey(),
        grant: v.fileGrant(),
      }),
    });
    const engine = new Engine(schema, ":memory:");
    engine.createAll();

    const fileId = 7n as FileId;
    const grantId = 8n as FileGrantId;
    engine.writer
      .query("INSERT INTO documents (file, preview, grant) VALUES (?, ?, ?)")
      .run(fileId, null, grantId);

    const db = makeDbWriter(
      engine,
      newWriteCollector(),
      () => 0n,
    ) as unknown as DbWriter<typeof schema>;
    const row = await db.documents
      .query()
      .where((document) => document.file.eq(fileId).and(document.grant.eq(grantId)))
      .unique();
    const urlRefId = await db.urlRefs.insert({ grant: grantId });

    expect(row).toEqual({ id: 1n, file: fileId, preview: null, grant: grantId });
    expect(await db.urlRefs.get(urlRefId)).toEqual({ id: urlRefId, grant: grantId });
    expect(
      (engine.writer.query("PRAGMA table_info(documents)").all() as Array<{
        name: string;
        type: string;
      }>).find((column) => column.name === "file")?.type,
    ).toBe("INTEGER");

    engine.close("clean");
  });
});
