import { defineSchema, defineTable, dbz } from "@dbzz/server";

export default defineSchema({
  items: defineTable({
    id: dbz.primaryKey(),
    seq: dbz.number(),
    body: dbz.string(),
  }).index("by_seq", ["seq"]),
});
