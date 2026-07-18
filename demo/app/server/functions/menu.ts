import { dbz } from "@dbzz/server";
import { mutation, query } from "@demo/dbzz-codegen/server";
import { isStaff } from "../lib/access.ts";
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
const staffAccess = (ctx: { auth: Parameters<typeof isStaff>[0] }) =>
  isStaff(ctx.auth);

export const catalog = query({
  access: authenticatedAccess,
  args: {},
  handler: async (ctx) => {
    const staff = isStaff(ctx.auth);
    const categories = await ctx.db.menuCategories
      .bySortOrder((q) => q)
      .order("asc")
      .collect();
    return Promise.all(
      categories
        .filter((category) => staff || category.active)
        .map(async (category) => ({
          ...category,
          items: (
            await ctx.db.menuItems
              .byCategory((q) => q.eq("categoryId", category.id))
              .order("asc")
              .collect()
          ).filter((item) => staff || item.active),
        })),
    );
  },
});

export const createCategory = mutation({
  access: staffAccess,
  args: { name: dbz.string(), sortOrder: dbz.number() },
  handler: async (ctx, args) => {
    const name = cleanName(args.name, "Category name");
    const sortOrder = nonNegativeInteger(args.sortOrder, "Sort order");
    if (
      (await ctx.db.menuCategories
        .byName((q) => q.eq("name", name))
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
    categoryId: dbz.bigint(),
    name: dbz.string(),
    description: dbz.string(),
    image: dbz.string(),
    priceCents: dbz.number(),
    sortOrder: dbz.number(),
  },
  handler: async (ctx, args) => {
    const category = await ctx.db.menuCategories.get(args.categoryId);
    if (category === null || !category.active) notFound("Category not found");
    const name = cleanName(args.name, "Item name");
    if (
      (await ctx.db.menuItems.byName((q) => q.eq("name", name)).unique()) !==
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
    id: dbz.bigint(),
    categoryId: dbz.bigint(),
    name: dbz.string(),
    description: dbz.string(),
    image: dbz.string(),
    priceCents: dbz.number(),
    sortOrder: dbz.number(),
    active: dbz.boolean(),
  },
  handler: async (ctx, args) => {
    const item =
      (await ctx.db.menuItems.get(args.id)) ?? notFound("Menu item not found");
    const category = await ctx.db.menuCategories.get(args.categoryId);
    if (category === null || !category.active) notFound("Category not found");
    const name = cleanName(args.name, "Item name");
    const duplicate = await ctx.db.menuItems
      .byName((q) => q.eq("name", name))
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
