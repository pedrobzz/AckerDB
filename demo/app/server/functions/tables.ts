import { dbz } from "@dbzz/server";
import { mutation, query } from "@demo/dbzz-codegen/server";
import { isStaff, requireUser } from "../lib/access.ts";
import {
  conflict,
  notFound,
  openOrderForTable,
  positiveInteger,
  requireCurrentUser,
} from "../lib/domain.ts";

const guestAccess = (ctx: { auth: Parameters<typeof requireUser>[0] }) =>
  ctx.auth.kind === "user";
const staffAccess = (ctx: { auth: Parameters<typeof isStaff>[0] }) =>
  isStaff(ctx.auth);

export const available = query({
  access: guestAccess,
  args: {},
  handler: async (ctx) => {
    const principal = requireUser(ctx.auth);
    await requireCurrentUser(ctx.db, principal.identity);
    const tables = await ctx.db.restaurantTables
      .byNumber((q) => q)
      .order("asc")
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
      .byNumber((q) => q)
      .order("asc")
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
  args: { number: dbz.number(), seats: dbz.number() },
  handler: async (ctx, args) => {
    const number = positiveInteger(args.number, "Table number", 999);
    const seats = positiveInteger(args.seats, "Seat count", 20);
    const existing = await ctx.db.restaurantTables
      .byNumber((q) => q.eq("number", number))
      .unique();
    const now = Date.now();
    if (existing !== null) {
      if (existing.active) conflict("This table number already exists");
      await ctx.db.restaurantTables.patch(existing.id, {
        seats,
        active: true,
        updatedAt: now,
      });
      return existing.id;
    }
    return ctx.db.restaurantTables.insert({
      number,
      seats,
      active: true,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const update = mutation({
  access: staffAccess,
  args: { id: dbz.bigint(), number: dbz.number(), seats: dbz.number() },
  handler: async (ctx, args) => {
    const table =
      (await ctx.db.restaurantTables.get(args.id)) ??
      notFound("Table not found");
    if ((await openOrderForTable(ctx.db, table.id)) !== null)
      conflict("An occupied table is locked");
    const number = positiveInteger(args.number, "Table number", 999);
    const seats = positiveInteger(args.seats, "Seat count", 20);
    const duplicate = await ctx.db.restaurantTables
      .byNumber((q) => q.eq("number", number))
      .unique();
    if (duplicate !== null && duplicate.id !== table.id)
      conflict("This table number already exists");
    await ctx.db.restaurantTables.patch(table.id, {
      number,
      seats,
      active: true,
      updatedAt: Date.now(),
    });
    return table.id;
  },
});

export const remove = mutation({
  access: staffAccess,
  args: { id: dbz.bigint() },
  handler: async (ctx, args) => {
    const table =
      (await ctx.db.restaurantTables.get(args.id)) ??
      notFound("Table not found");
    if ((await openOrderForTable(ctx.db, table.id)) !== null)
      conflict("An occupied table cannot be removed");
    await ctx.db.restaurantTables.patch(table.id, {
      active: false,
      updatedAt: Date.now(),
    });
    return table.id;
  },
});
