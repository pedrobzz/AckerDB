import { describe, expect, test } from "bun:test";
import { defineSchema, defineTable, snapshotOf, v } from "@dbzz/server";

describe("schema snapshots", () => {
  test("orders persisted indexes by UTF-16 code units", () => {
    const schema = defineSchema({
      entries: defineTable({
        id: v.primaryKey(),
        value: v.string(),
      })
        .index("i", ["value"])
        .index("IA", ["value"]),
    });

    expect(snapshotOf(schema).tables.entries!.indexes.map((index) => index.name)).toEqual([
      "IA",
      "i",
    ]);
  });
});
