import { describe, expect, test } from "bun:test";
import { defineSchema, defineTable, snapshotOf, v } from "@dbzz/server";

describe("schema snapshots", () => {
  test("persists and orders stable structural index identities", () => {
    const schema = defineSchema({
      entries: defineTable({
        id: v.primaryKey(),
        z: v.string(),
        aa: v.string(),
      })
        .index(["aa"])
        .index(["z"]),
    });

    expect(snapshotOf(schema).tables.entries!.indexes.map((index) => index.name)).toEqual([
      "s_n_b_1_z",
      "s_n_b_2_aa",
    ]);
  });
});
