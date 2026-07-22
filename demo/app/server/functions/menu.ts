import { v } from "@dbzz/server";
import { mutation, query } from "@demo/dbzz-codegen/server";
import { isStaff, staffAccess } from "../lib/access.ts";
import {
  cleanName,
  cleanText,
  conflict,
  nonNegativeInteger,
  notFound,
  positiveInteger,
} from "../lib/domain.ts";

const authenticatedAccess = (ctx: { auth: { kind: string } }) =>
  ctx.auth.kind === "user";

export const catalog = query({
  access: authenticatedAccess,
  args: {},
  handler: async (ctx) => {
    const staff = isStaff(ctx.auth);
    const categories = await ctx.db.menuCategories
      .query()
      .orderBy((category) => category.sortOrder.asc())
      .collect();
    return Promise.all(
      categories
        .filter((category) => staff || category.active)
        .map(async (category) => ({
          ...category,
          items: (
            await ctx.db.menuItems
              .query()
              .where((item) => item.categoryId.eq(category.id))
              .orderBy((item) => item.sortOrder.asc())
              .collect()
          ).filter((item) => staff || item.active),
        })),
    );
  },
});

export const createCategory = mutation({
  access: staffAccess,
  args: { name: v.string(), sortOrder: v.int() },
  handler: async (ctx, args) => {
    const name = cleanName(args.name, "Category name");
    const sortOrder = nonNegativeInteger(args.sortOrder, "Sort order");
    if (
      (await ctx.db.menuCategories
        .query()
        .where((category) => category.name.eq(name))
        .unique()) !== null
    ) {
      conflict("This category already exists");
    }
    const now = Date.now();
    return ctx.db.menuCategories.insert({
      name,
      sortOrder,
      active: true,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const createItem = mutation({
  access: staffAccess,
  args: {
    categoryId: v.bigint(),
    name: v.string(),
    description: v.string(),
    image: v.string(),
    priceCents: v.int(),
    sortOrder: v.int(),
  },
  handler: async (ctx, args) => {
    const category = await ctx.db.menuCategories.get(args.categoryId);
    if (category === null || !category.active) notFound("Category not found");
    const name = cleanName(args.name, "Item name");
    if (
      (await ctx.db.menuItems.query().where((item) => item.name.eq(name)).unique()) !==
      null
    ) {
      conflict("This menu item already exists");
    }
    const now = Date.now();
    return ctx.db.menuItems.insert({
      categoryId: category.id,
      name,
      description: cleanText(args.description, "Description", 240),
      image: cleanText(args.image, "Image path", 500),
      priceCents: positiveInteger(args.priceCents, "Price", 1_000_000),
      sortOrder: nonNegativeInteger(args.sortOrder, "Sort order"),
      active: true,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const updateItem = mutation({
  access: staffAccess,
  args: {
    id: v.bigint(),
    categoryId: v.bigint(),
    name: v.string(),
    description: v.string(),
    image: v.string(),
    priceCents: v.int(),
    sortOrder: v.int(),
    active: v.boolean(),
  },
  handler: async (ctx, args) => {
    const item =
      (await ctx.db.menuItems.get(args.id)) ?? notFound("Menu item not found");
    const category = await ctx.db.menuCategories.get(args.categoryId);
    if (category === null || !category.active) notFound("Category not found");
    const name = cleanName(args.name, "Item name");
    const duplicate = await ctx.db.menuItems
      .query()
      .where((item) => item.name.eq(name))
      .unique();
    if (duplicate !== null && duplicate.id !== item.id)
      conflict("This menu item already exists");
    await ctx.db.menuItems.patch(item.id, {
      categoryId: category.id,
      name,
      description: cleanText(args.description, "Description", 240),
      image: cleanText(args.image, "Image path", 500),
      priceCents: positiveInteger(args.priceCents, "Price", 1_000_000),
      sortOrder: nonNegativeInteger(args.sortOrder, "Sort order"),
      active: args.active,
      updatedAt: Date.now(),
    });
    return item.id;
  },
});
