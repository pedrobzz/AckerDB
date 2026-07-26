import { Err, Status } from "@ackerdb/core";
import { v } from "@ackerdb/server";
import { mutation, query } from "@demo/ackerdb-codegen/server";
import { requireUser, staffAccess } from "../lib/access.ts";
import {
  addOrderItems,
  cancelOpenOrder,
  cancelOrderItem,
  closeOrder,
} from "../lib/domain/order-workflow.ts";
import {
  openOrder,
  openOrderForTable,
  openOrderForUser,
  orderView,
  ownedOpenOrder,
} from "../lib/domain/orders.ts";
import { currentUser } from "../lib/domain/guests.ts";
import { isFinal, payableCents } from "../lib/domain/order-status.ts";
import { activeTable } from "../lib/domain/tables.ts";

const guestAccess = (ctx: { auth: Parameters<typeof requireUser>[0] }) =>
  ctx.auth.kind === "user";
const cartArgs = v
  .array(
    v.object({
      menuItemId: v.bigint(),
      quantity: v.int().min(1).max(20),
      note: v.string().max(160).nullable(),
    }),
  )
  .min(1)
  .max(25);

export const current = query({
  access: guestAccess,
  args: {},
  handler: async (ctx) => {
    const principal = requireUser(ctx.auth);
    const user = await currentUser(ctx.db, principal.identity);
    if (!user.ok) return user;
    const order = await openOrderForUser(ctx.db, user.data.id);
    return order === null ? null : orderView(ctx.db, order);
  },
});

export const history = query({
  access: guestAccess,
  args: {},
  handler: async (ctx) => {
    const principal = requireUser(ctx.auth);
    const user = await currentUser(ctx.db, principal.identity);
    if (!user.ok) return user;
    const orders = await ctx.db.orders
      .query()
      .where((order) => order.userId.eq(user.data.id))
      .orderBy((order) => order.openedAt.desc())
      .thenBy((order) => order.id.desc())
      .collect();
    const active = orders.find((order) => order.status === "OPEN") ?? null;
    const closed = orders.filter((order) => order.status !== "OPEN");
    return {
      active: active === null ? null : await orderView(ctx.db, active),
      closed: await Promise.all(
        closed.map((order) => orderView(ctx.db, order)),
      ),
    };
  },
});

export const sit = mutation({
  access: guestAccess,
  args: { tableId: v.bigint() },
  returns: v.bigint(),
  errors: {
    "order.already-open": {
      body: v.object({ orderId: v.bigint() }),
      status: Status.Conflict,
    },
    "table.not-found": {
      body: v.object({ tableId: v.bigint() }),
      status: Status.NotFound,
    },
    "table.unavailable": {
      body: v.object({ tableId: v.bigint() }),
      status: Status.Conflict,
    },
    "guest.profile-required": {
      body: v.object({}),
      status: Status.NotFound,
    },
  },
  handler: async (ctx, args) => {
    const principal = requireUser(ctx.auth);
    const user = await currentUser(ctx.db, principal.identity);
    if (!user.ok) return user;
    const openOrder = await openOrderForUser(ctx.db, user.data.id);
    if (openOrder !== null) {
      return Err(
        "order.already-open",
        { orderId: openOrder.id },
        Status.Conflict,
      );
    }
    const table = await ctx.db.restaurantTables.get(args.tableId);
    if (table === null || !table.active) {
      return Err("table.not-found", { tableId: args.tableId }, Status.NotFound);
    }
    if ((await openOrderForTable(ctx.db, table.id)) !== null) {
      return Err("table.unavailable", { tableId: table.id }, Status.Conflict);
    }
    const now = Date.now();
    return ctx.db.orders.insert({
      userId: user.data.id,
      tableId: table.id,
      openUserId: user.data.id,
      openTableId: table.id,
      status: "OPEN",
      totalCents: 0,
      openedAt: now,
      closedAt: null,
    });
  },
});

export const addItems = mutation({
  access: guestAccess,
  args: { orderId: v.bigint(), items: cartArgs },
  handler: async (ctx, args) => {
    const principal = requireUser(ctx.auth);
    const owned = await ownedOpenOrder(
      ctx.db,
      principal.identity,
      args.orderId,
    );
    if (!owned.ok) return owned;
    return addOrderItems(ctx.db, owned.data.order, args.items);
  },
});

export const cancelItem = mutation({
  access: guestAccess,
  args: { orderId: v.bigint(), orderItemId: v.bigint() },
  handler: async (ctx, args) => {
    const principal = requireUser(ctx.auth);
    const owned = await ownedOpenOrder(
      ctx.db,
      principal.identity,
      args.orderId,
    );
    if (!owned.ok) return owned;
    const item = await ctx.db.orderItems.get(args.orderItemId);
    if (item === null || item.orderId !== owned.data.order.id) {
      return Err(
        "order-item.not-found",
        { orderItemId: args.orderItemId },
        Status.NotFound,
      );
    }
    return cancelOrderItem(
      ctx.db,
      owned.data.order,
      item,
      `${item.name} was cancelled`,
    );
  },
});

export const closeCancelled = mutation({
  access: guestAccess,
  args: { orderId: v.bigint() },
  handler: async (ctx, args) => {
    const principal = requireUser(ctx.auth);
    const owned = await ownedOpenOrder(
      ctx.db,
      principal.identity,
      args.orderId,
    );
    if (!owned.ok) return owned;
    const order = owned.data.order;
    const items = await ctx.db.orderItems
      .query()
      .where((item) => item.orderId.eq(order.id))
      .collect();
    if (!items.every((item) => item.status === "CANCELLED")) {
      return Err(
        "order.not-cancellable",
        { orderId: order.id },
        Status.Conflict,
      );
    }
    await closeOrder(ctx.db, order, "CANCELLED", 0, "Your order was closed");
    return order.id;
  },
});

export const pay = mutation({
  access: guestAccess,
  args: { orderId: v.bigint() },
  handler: async (ctx, args) => {
    const principal = requireUser(ctx.auth);
    const owned = await ownedOpenOrder(
      ctx.db,
      principal.identity,
      args.orderId,
    );
    if (!owned.ok) return owned;
    const order = owned.data.order;
    const items = await ctx.db.orderItems
      .query()
      .where((item) => item.orderId.eq(order.id))
      .collect();
    if (
      items.length === 0 ||
      !items.every((item) => isFinal(item.status)) ||
      !items.some((item) => item.status === "SERVED")
    ) {
      return Err("order.not-payable", { orderId: order.id }, Status.Conflict);
    }
    const totalCents = payableCents(items);
    await closeOrder(
      ctx.db,
      order,
      "PAID",
      totalCents,
      "Payment complete — thank you",
    );
    return { orderId: order.id, totalCents };
  },
});

export const list = query({
  access: staffAccess,
  args: {},
  handler: async (ctx) => {
    const orders = await ctx.db.orders
      .query()
      .orderBy((order) => order.id.desc())
      .collect();
    return Promise.all(orders.map((order) => orderView(ctx.db, order)));
  },
});

export const detail = query({
  access: staffAccess,
  args: { id: v.bigint() },
  handler: async (ctx, args) => {
    const order = await ctx.db.orders.get(args.id);
    return order === null
      ? Err("order.not-found", { orderId: args.id }, Status.NotFound)
      : orderView(ctx.db, order);
  },
});

export const create = mutation({
  access: staffAccess,
  args: { userId: v.bigint(), tableId: v.bigint() },
  handler: async (ctx, args) => {
    const user = await ctx.db.users.get(args.userId);
    if (user === null) {
      return Err("guest.not-found", { id: args.userId }, Status.NotFound);
    }
    if ((await openOrderForUser(ctx.db, user.id)) !== null) {
      return Err("order.already-open", { userId: user.id }, Status.Conflict);
    }
    const table = await activeTable(ctx.db, args.tableId);
    if (!table.ok) return table;
    if ((await openOrderForTable(ctx.db, table.data.id)) !== null) {
      return Err(
        "table.unavailable",
        { tableId: table.data.id },
        Status.Conflict,
      );
    }
    const now = Date.now();
    return ctx.db.orders.insert({
      userId: user.id,
      tableId: table.data.id,
      openUserId: user.id,
      openTableId: table.data.id,
      status: "OPEN",
      totalCents: 0,
      openedAt: now,
      closedAt: null,
    });
  },
});

export const addItemsAsStaff = mutation({
  access: staffAccess,
  args: { orderId: v.bigint(), items: cartArgs },
  handler: async (ctx, args) => {
    const order = await openOrder(ctx.db, args.orderId);
    return order.ok ? addOrderItems(ctx.db, order.data, args.items) : order;
  },
});

export const cancel = mutation({
  access: staffAccess,
  args: { orderId: v.bigint() },
  handler: async (ctx, args) => {
    const result = await cancelOpenOrder(ctx.db, args.orderId);
    return result.ok ? result.data.order.id : result;
  },
});
