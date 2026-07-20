import { defineSchema, defineTable, v } from "@dbzz/server";

export default defineSchema({
  documents: defineTable({
    id: v.primaryKey(),
    partition: v.float(),
    rank: v.float(),
    score: v.float(),
    payload: v.string(),
  }).index("by_partition_rank", ["partition", "rank"]),

  accounts: defineTable({
    id: v.primaryKey(),
    account: v.float(),
    balance: v.float(),
    version: v.float(),
  }).index("by_account", ["account"], { unique: true }),

  channels: defineTable({
    id: v.primaryKey(),
    channel: v.float(),
    version: v.float(),
    checksum: v.float(),
    payload: v.string(),
  }).index("by_channel", ["channel"], { unique: true }),
});
