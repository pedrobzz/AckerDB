import { describe, expect, test } from "bun:test";
import {
  defineSchema,
  defineTable,
  diffSnapshots,
  snapshotOf,
  v,
} from "@ackerdb/server";

describe("File reference schema", () => {
  test("stores File references only as direct required or nullable columns", () => {
    const snapshot = snapshotOf(defineSchema({
      documents: defineTable({
        id: v.primaryKey(),
        file: v.file(),
        preview: v.file().nullable(),
      }),
    }));

    expect(snapshot.tables.documents!.columns).toMatchObject({
      file: { k: "file" },
      preview: { k: "nullable", inner: { k: "file" } },
    });

    for (const nested of [
      v.array(v.file()),
      v.object({ file: v.file() }),
      v.union("FilePayload", { file: v.file() }),
    ]) {
      expect(() => defineTable({ id: v.primaryKey(), nested })).toThrow(
        "v.file() may only be stored as a direct column",
      );
    }
  });

  test("allows ordinary indexes over direct File-reference columns", () => {
    const table = defineTable({
      id: v.primaryKey(),
      file: v.file(),
      preview: v.file().nullable(),
    })
      .index(["file"])
      .index(["preview"]);

    expect(table.indexes.map((index) => index.columns)).toEqual([
      ["file"],
      ["preview"],
    ]);
  });

  test("diffs File identity separately from bigint and through ordinary nullability", () => {
    const column = (validator: ReturnType<typeof v.bigint> | ReturnType<typeof v.file>) =>
      snapshotOf(defineSchema({
        documents: defineTable({ id: v.primaryKey(), file: validator }),
      }));
    const bigint = column(v.bigint());
    const file = column(v.file());
    const nullableFile = snapshotOf(defineSchema({
      documents: defineTable({ id: v.primaryKey(), file: v.file().nullable() }),
    }));

    expect(diffSnapshots(bigint, file)).toMatchObject([{
      op: "table-altered",
      table: "documents",
      columns: [{ op: "type-changed", column: "file" }],
    }]);
    expect(diffSnapshots(file, nullableFile)).toMatchObject([{
      op: "table-altered",
      table: "documents",
      columns: [{ op: "nullability-changed", column: "file", to: "nullable" }],
    }]);
  });
});
