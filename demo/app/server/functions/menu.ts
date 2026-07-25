import { Err, Status } from "@dbzz/core";
import { v } from "@dbzz/server";
import { mutation, query } from "@demo/dbzz-codegen/server";
import { isStaff, staffAccess } from "../lib/access.ts";
import {
  categoryNameInput,
  descriptionInput,
  imagePathInput,
  itemNameInput,
} from "../lib/inputs.ts";

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
  args: {
    name: categoryNameInput,
    sortOrder: v.int().min(0),
  },
  handler: async (ctx, args) => {
    if (
      (await ctx.db.menuCategories
        .query()
        .where((category) => category.name.eq(args.name))
        .unique()) !== null
    ) {
      return Err(
        "menu-category.name-taken",
        { name: args.name },
        Status.Conflict,
      );
    }
    const now = Date.now();
    return ctx.db.menuCategories.insert({
      name: args.name,
      sortOrder: args.sortOrder,
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
    name: itemNameInput,
    description: descriptionInput,
    image: imagePathInput,
    priceCents: v.int().min(1).max(1_000_000),
    sortOrder: v.int().min(0),
  },
  handler: async (ctx, args) => {
    const category = await ctx.db.menuCategories.get(args.categoryId);
    if (category === null || !category.active) {
      return Err(
        "menu-category.not-found",
        { categoryId: args.categoryId },
        Status.NotFound,
      );
    }
    if (
      (await ctx.db.menuItems
        .query()
        .where((item) => item.name.eq(args.name))
        .unique()) !== null
    ) {
      return Err("menu-item.name-taken", { name: args.name }, Status.Conflict);
    }
    const now = Date.now();
    return ctx.db.menuItems.insert({
      categoryId: category.id,
      name: args.name,
      description: args.description,
      image: args.image,
      priceCents: args.priceCents,
      sortOrder: args.sortOrder,
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
    name: itemNameInput,
    description: descriptionInput,
    image: imagePathInput,
    priceCents: v.int().min(1).max(1_000_000),
    sortOrder: v.int().min(0),
    active: v.boolean(),
  },
  handler: async (ctx, args) => {
    const item = await ctx.db.menuItems.get(args.id);
    if (item === null) {
      return Err("menu-item.not-found", { itemId: args.id }, Status.NotFound);
    }
    const category = await ctx.db.menuCategories.get(args.categoryId);
    if (category === null || !category.active) {
      return Err(
        "menu-category.not-found",
        { categoryId: args.categoryId },
        Status.NotFound,
      );
    }
    const duplicate = await ctx.db.menuItems
      .query()
      .where((candidate) => candidate.name.eq(args.name))
      .unique();
    if (duplicate !== null && duplicate.id !== item.id) {
      return Err("menu-item.name-taken", { name: args.name }, Status.Conflict);
    }
    await ctx.db.menuItems.patch(item.id, {
      categoryId: category.id,
      name: args.name,
      description: args.description,
      image: args.image,
      priceCents: args.priceCents,
      sortOrder: args.sortOrder,
      active: args.active,
      updatedAt: Date.now(),
    });
    return item.id;
  },
});
