import { describe, expect, test } from "bun:test";
import { defineSchema, defineTable, snapshotOf, v } from "@ackerdb/server";
import { withFrameworkTables } from "../../src/database/framework-schema.ts";

describe("vector schema placement", () => {
  test("retains dimensions on direct required and nullable columns", () => {
    const snapshot = snapshotOf(withFrameworkTables(defineSchema({
      documents: defineTable({
        id: v.primaryKey(),
        embedding: v.vector(1536),
        pendingEmbedding: v.vector(768).nullable(),
      }),
    })));

    expect(snapshot.tables.documents!.columns).toMatchObject({
      embedding: { k: "vector", dimensions: 1536 },
      pendingEmbedding: {
        k: "nullable",
        inner: { k: "vector", dimensions: 768 },
      },
    });

    expect(() =>
      defineTable({ id: v.primaryKey(), embedding: v.vector(3) }).index(["embedding"]),
    ).toThrow("not indexable");
  });

  test("rejects vectors nested in persisted structured values", () => {
    for (const nested of [
      v.array(v.vector(2)),
      v.object({ embedding: v.vector(2) }),
      v.union("Payload", { embedding: v.vector(2) }),
    ]) {
      expect(() => defineSchema({
        documents: defineTable({ id: v.primaryKey(), nested }),
      })).toThrow("direct column");
    }
  });
});
