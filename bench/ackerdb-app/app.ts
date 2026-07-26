import { defineApp, defineSchema, defineTable, v } from "@ackerdb/server";

const schema = defineSchema({
  documents: defineTable({
    id: v.primaryKey(),
    partition: v.float(),
    rank: v.float(),
    score: v.float(),
    payload: v.string(),
  }).index(["partition", "rank"]),

  accounts: defineTable({
    id: v.primaryKey(),
    account: v.float(),
    balance: v.float(),
    version: v.float(),
  }).index(["account"], { unique: true }),

  channels: defineTable({
    id: v.primaryKey(),
    channel: v.float(),
    version: v.float(),
    checksum: v.float(),
    payload: v.string(),
  }).index(["channel"], { unique: true }),
});

export default defineApp({ schema });
