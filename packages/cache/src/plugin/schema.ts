import { defineSchema, defineTable, v } from "@ackerdb/server";

export const cacheSchema = defineSchema({
  entries: defineTable({
    id: v.primaryKey(),
    key: v.string(),
    payload: v.string(),
    bytes: v.int(),
    deadline: v.int().nullable(),
  })
    .index(["key"], { unique: true })
    .index(["deadline"]),
  state: defineTable({
    id: v.primaryKey(),
    totalBytes: v.int(),
    entryCount: v.int(),
  }),
});

export const externalCacheSchema = defineSchema({});
