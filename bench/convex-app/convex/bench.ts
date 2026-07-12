import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const top = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("items")
      .withIndex("by_seq")
      .order("desc")
      .take(20);
    return rows;
  },
});

export const add = mutation({
  args: { seq: v.float64(), body: v.string() },
  handler: (ctx, args) => ctx.db.insert("items", args),
});
