import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const top = query({
  args: {},
  handler: (ctx) => ctx.db.query("items").withIndex("by_seq").order("desc").take(20),
});

export const add = mutation({
  args: { seq: v.float64(), body: v.string() },
  handler: (ctx, args) => ctx.db.insert("items", args),
});
