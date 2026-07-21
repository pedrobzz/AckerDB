import { defineSchema, defineTable, v } from "@dbzz/server";

export const cacheSchema = defineSchema({
  entries: defineTable({
    id: v.primaryKey(),
    key: v.string(),
    payload: v.string(),
    bytes: v.int(),
    deadline: v.int().nullable(),
  })
    .index("by_key", ["key"], { unique: true })
    .index("by_deadline", ["deadline"]),
  state: defineTable({
    id: v.primaryKey(),
    totalBytes: v.int(),
    entryCount: v.int(),
  }),
});

export const externalCacheSchema = defineSchema({});
