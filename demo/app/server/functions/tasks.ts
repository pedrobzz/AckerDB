import { dbz } from "@dbzz/server";
import { mutation, query } from "@demo/dbzz-codegen/server";

export const list = query({
  access: "public",
  args: {},
  handler: (ctx) => ctx.db.tasks.scan().collect(),
});

export const create = mutation({
  access: "public",
  args: { title: dbz.string() },
  handler: async (ctx, { title }) => {
    const normalizedTitle = title.trim();
    if (normalizedTitle.length === 0) throw new Error("title is required");
    return ctx.db.tasks.insert({ title: normalizedTitle, completed: false });
  },
});

export const update = mutation({
  access: "public",
  args: {
    id: dbz.bigint(),
    title: dbz.string(),
    completed: dbz.boolean(),
  },
  handler: async (ctx, { id, title, completed }) => {
    const normalizedTitle = title.trim();
    if (normalizedTitle.length === 0) throw new Error("title is required");
    await ctx.db.tasks.patch(id, { title: normalizedTitle, completed });
    return null;
  },
});

export const remove = mutation({
  access: "public",
  args: { id: dbz.bigint() },
  handler: async (ctx, { id }) => {
    await ctx.db.tasks.delete(id);
    return null;
  },
});
