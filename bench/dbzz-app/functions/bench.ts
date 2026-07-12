import { dbz } from "@dbzz/server";
import { mutation, query } from "../_generated/server.ts";

export const top = query({
  args: {},
  handler: (ctx) => ctx.db.items.bySeq((q) => q).order("desc").take(20),
});

export const add = mutation({
  args: { seq: dbz.number(), body: dbz.string() },
  handler: (ctx, args) => ctx.db.items.insert(args),
});
