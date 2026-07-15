import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  documents: defineTable({
    partition: v.float64(),
    rank: v.float64(),
    score: v.float64(),
    payload: v.string(),
  }).index("by_partition_rank", ["partition", "rank"]),

  accounts: defineTable({
    account: v.float64(),
    balance: v.float64(),
    version: v.float64(),
  }).index("by_account", ["account"]),

  channels: defineTable({
    channel: v.float64(),
    version: v.float64(),
    checksum: v.float64(),
    payload: v.string(),
  }).index("by_channel", ["channel"]),
});
