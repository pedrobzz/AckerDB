import { describe, expect, test } from "bun:test";
import { defineSchema, defineTable, snapshotOf, v } from "@ackerdb/server";
import { withFrameworkTables } from "../../src/database/framework-schema.ts";

describe("schema snapshots", () => {
  test("records version 2 and sorted full-text targets on every table", () => {
    const snapshot = snapshotOf(withFrameworkTables(
      defineSchema({
        documents: defineTable({
          id: v.primaryKey(),
          z: v.string(),
          aa: v.string(),
        }).fullText(["z", "aa"]),
        settings: defineTable({
          id: v.primaryKey(),
          value: v.string(),
        }),
      }),
    ));

    expect(snapshot.version).toBe(2);
    expect(snapshot.tables.documents!.fullText).toEqual(["aa", "z"]);
    expect(snapshot.tables.settings!.fullText).toEqual([]);
  });

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

    expect(snapshotOf(withFrameworkTables(schema)).tables.entries!.indexes.map((index) => index.name)).toEqual([
      "s_n_b_1_z",
      "s_n_b_2_aa",
    ]);
  });
});
