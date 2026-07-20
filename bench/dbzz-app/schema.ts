import { defineSchema, defineTable, v } from "@dbzz/server";

export default defineSchema({
  documents: defineTable({
    id: v.primaryKey(),
    partition: v.int(),
    rank: v.int(),
    score: v.int(),
    payload: v.string(),
  }).index("by_partition_rank", ["partition", "rank"]),

  accounts: defineTable({
    id: v.primaryKey(),
    account: v.int(),
    balance: v.int(),
    version: v.int(),
  }).index("by_account", ["account"], { unique: true }),

  channels: defineTable({
    id: v.primaryKey(),
    channel: v.int(),
    version: v.int(),
    checksum: v.int(),
    payload: v.string(),
  }).index("by_channel", ["channel"], { unique: true }),
});
