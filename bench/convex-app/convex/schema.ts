import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  items: defineTable({
    seq: v.float64(),
    body: v.string(),
  }).index("by_seq", ["seq"]),
});
