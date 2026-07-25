import { Err, Status } from "@dbzz/core";
import { v } from "@dbzz/server";
import { mutation, query } from "@demo/dbzz-codegen/server";
import { requireUser, staffAccess } from "../lib/access.ts";
import { currentUser } from "../lib/domain/guests.ts";
import { openOrderForTable } from "../lib/domain/orders.ts";

const guestAccess = (ctx: { auth: Parameters<typeof requireUser>[0] }) =>
  ctx.auth.kind === "user";

export const available = query({
  access: guestAccess,
  args: {},
  handler: async (ctx) => {
    const principal = requireUser(ctx.auth);
    const user = await currentUser(ctx.db, principal.identity);
    if (!user.ok) return user;
    const tables = await ctx.db.restaurantTables
      .query()
      .orderBy((table) => table.number.asc())
      .collect();
    return Promise.all(
      tables
        .filter((table) => table.active)
        .map(async (table) => ({
          id: table.id,
          number: table.number,
          seats: table.seats,
          available: (await openOrderForTable(ctx.db, table.id)) === null,
        })),
    );
  },
});

export const list = query({
  access: staffAccess,
  args: {},
  handler: async (ctx) => {
    const tables = await ctx.db.restaurantTables
      .query()
      .orderBy((table) => table.number.asc())
      .collect();
    return Promise.all(
      tables
        .filter((table) => table.active)
        .map(async (table) => {
          const order = await openOrderForTable(ctx.db, table.id);
          const user =
            order === null ? null : await ctx.db.users.get(order.userId);
          return {
            ...table,
            orderId: order?.id ?? null,
            guestName: user?.name ?? null,
            totalCents: order?.totalCents ?? null,
          };
        }),
    );
  },
});

export const create = mutation({
  access: staffAccess,
  args: {
    number: v.int().min(1).max(999),
    seats: v.int().min(1).max(20),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.restaurantTables
      .query()
      .where((table) => table.number.eq(args.number))
      .unique();
    const now = Date.now();
    if (existing !== null) {
      if (existing.active) {
        return Err(
          "table.number-taken",
          { number: args.number },
          Status.Conflict,
        );
      }
      await ctx.db.restaurantTables.patch(existing.id, {
        seats: args.seats,
        active: true,
        updatedAt: now,
      });
      return existing.id;
    }
    return ctx.db.restaurantTables.insert({
      number: args.number,
      seats: args.seats,
      active: true,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const update = mutation({
  access: staffAccess,
  args: {
    id: v.bigint(),
    number: v.int().min(1).max(999),
    seats: v.int().min(1).max(20),
  },
  handler: async (ctx, args) => {
    const table = await ctx.db.restaurantTables.get(args.id);
    if (table === null) {
      return Err("table.not-found", { tableId: args.id }, Status.NotFound);
    }
    if ((await openOrderForTable(ctx.db, table.id)) !== null) {
      return Err("table.occupied", { tableId: table.id }, Status.Conflict);
    }
    const duplicate = await ctx.db.restaurantTables
      .query()
      .where((candidate) => candidate.number.eq(args.number))
      .unique();
    if (duplicate !== null && duplicate.id !== table.id) {
      return Err(
        "table.number-taken",
        { number: args.number },
        Status.Conflict,
      );
    }
    await ctx.db.restaurantTables.patch(table.id, {
      number: args.number,
      seats: args.seats,
      active: true,
      updatedAt: Date.now(),
    });
    return table.id;
  },
});

export const remove = mutation({
  access: staffAccess,
  args: { id: v.bigint() },
  handler: async (ctx, args) => {
    const table = await ctx.db.restaurantTables.get(args.id);
    if (table === null) {
      return Err("table.not-found", { tableId: args.id }, Status.NotFound);
    }
    if ((await openOrderForTable(ctx.db, table.id)) !== null) {
      return Err("table.occupied", { tableId: table.id }, Status.Conflict);
    }
    await ctx.db.restaurantTables.patch(table.id, {
      active: false,
      updatedAt: Date.now(),
    });
    return table.id;
  },
});
