import { defineSchema, defineTable, dbz } from "@dbzz/server";

export default defineSchema({
  documents: defineTable({
    id: dbz.primaryKey(),
    partition: dbz.number(),
    rank: dbz.number(),
    score: dbz.number(),
    payload: dbz.string(),
  }).index("by_partition_rank", ["partition", "rank"]),

  accounts: defineTable({
    id: dbz.primaryKey(),
    account: dbz.number(),
    balance: dbz.number(),
    version: dbz.number(),
  }).index("by_account", ["account"], { unique: true }),

  channels: defineTable({
    id: dbz.primaryKey(),
    channel: dbz.number(),
    version: dbz.number(),
    checksum: dbz.number(),
    payload: dbz.string(),
  }).index("by_channel", ["channel"], { unique: true }),
});
