import { describe, expect, test } from "bun:test";
import {
  applyRenames,
  classifySchemaDiff,
  defineSchema,
  defineTable,
  diffSnapshots,
  snapshotOf,
  v,
} from "@ackerdb/server";

function documents(fullText: readonly ("title" | "body")[] = []) {
  const table = defineTable({
    id: v.primaryKey(),
    title: v.string(),
    body: v.string().nullable(),
  });
  return defineSchema({
    documents: fullText.length === 0
      ? table
      : table.fullText(fullText),
  });
}

describe("full-text schema evolution", () => {
  test("adding and dropping targets are shape-safe derived-storage changes", () => {
    const plain = snapshotOf(documents());
    const searchable = snapshotOf(documents(["body"]));
    const added = diffSnapshots(plain, searchable);

    expect(added).toEqual([
      {
        op: "table-altered",
        table: "documents",
        columns: [],
        indexes: [],
        fullText: [{ op: "added", column: "body" }],
      },
    ]);
    expect(classifySchemaDiff(added)).toEqual({
      safe: [{ op: "create-full-text", table: "documents", column: "body" }],
      optimistic: [],
      refusals: [],
    });

    expect(classifySchemaDiff(diffSnapshots(searchable, plain))).toEqual({
      safe: [{ op: "drop-full-text", table: "documents", column: "body" }],
      optimistic: [],
      refusals: [],
    });
  });

  test("target order is structural noise", () => {
    expect(
      diffSnapshots(
        snapshotOf(documents(["title", "body"])),
        snapshotOf(documents(["body", "title"])),
      ),
    ).toEqual([]);
  });

  test("a table rebuild absorbs full-text target changes", () => {
    const current = snapshotOf(defineSchema({
      documents: defineTable({
        id: v.primaryKey(),
        title: v.string(),
        body: v.string(),
      }).fullText(["title"]),
    }));
    const target = snapshotOf(defineSchema({
      documents: defineTable({
        id: v.primaryKey(),
        title: v.string().nullable(),
        body: v.string(),
      }).fullText(["body"]),
    }));

    expect(classifySchemaDiff(diffSnapshots(current, target))).toEqual({
      safe: [{ op: "rebuild-table", table: "documents" }],
      optimistic: [],
      refusals: [],
    });
  });

  test("column renames carry full-text target identity", () => {
    const current = snapshotOf(documents(["body"]));
    const renamed = applyRenames(current, {
      tables: {},
      columns: { documents: { body: "content" } },
      variants: {},
    });

    expect(renamed.tables.documents!.fullText).toEqual(["content"]);
    expect(renamed.version).toBe(2);
  });
});
