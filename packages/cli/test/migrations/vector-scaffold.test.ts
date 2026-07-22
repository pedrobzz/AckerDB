import { expect, test } from "bun:test";
import { defineSchema, defineTable, snapshotOf, v } from "@dbzz/server";
import { generateMigration } from "../../src/migrations/scaffold.ts";

test("generated migration types retain readonly vector dimensions structurally", () => {
  const before = defineSchema({
    documents: defineTable({ id: v.primaryKey(), embedding: v.vector(2) }),
  });
  const target = defineSchema({
    documents: defineTable({
      id: v.primaryKey(),
      embedding: v.vector(3),
      draftEmbedding: v.vector(3).nullable(),
    }),
  });

  const { typesTs, metaJson } = generateMigration({
    number: 1,
    name: "resize_embedding",
    pre: snapshotOf(before),
    schema: target,
  });

  expect(typesTs).toContain(
    "type DocumentsBefore = { id: bigint; embedding: readonly number[] };",
  );
  expect(typesTs).toContain(
    "export type DocumentsRow = { id: bigint; embedding: readonly number[]; draftEmbedding: readonly number[] | null };",
  );
  expect(JSON.parse(metaJson).target.tables.documents.columns.embedding)
    .toEqual({ k: "vector", dimensions: 3 });
});
