import { v } from "@dbzz/server";
import { mutation, query } from "@demo/dbzz-codegen/server";
import { requireUser, staffAccess } from "../lib/access.ts";
import {
  addOrderItems,
  cancelOpenOrder,
  cancelOrderItem,
  closeOrder,
  conflict,
  isFinal,
  notFound,
  openOrderForTable,
  openOrderForUser,
  orderView,
  payableCents,
  requireActiveTable,
  requireCurrentUser,
  requireOpenOrder,
  requireOwnedOpenOrder,
} from "../lib/domain.ts";

const guestAccess = (ctx: { auth: Parameters<typeof requireUser>[0] }) =>
  ctx.auth.kind === "user";
const cartArgs = v.array(
  v.object({
    menuItemId: v.bigint(),
    quantity: v.int(),
    note: v.string().nullable(),
  }),
);

export const current = query({
  access: guestAccess,
  args: {},
  handler: async (ctx) => {
    const principal = requireUser(ctx.auth);
    const user = await requireCurrentUser(ctx.db, principal.identity);
    const order = await openOrderForUser(ctx.db, user.id);
    return order === null ? null : orderView(ctx.db, order);
  },
});

export const history = query({
  access: guestAccess,
  args: {},
  handler: async (ctx) => {
    const principal = requireUser(ctx.auth);
    const user = await requireCurrentUser(ctx.db, principal.identity);
    const orders = await ctx.db.orders
      .query()
      .where((order) => order.userId.eq(user.id))
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
  handler: async (ctx, args) => {
    const principal = requireUser(ctx.auth);
    const user = await requireCurrentUser(ctx.db, principal.identity);
    if ((await openOrderForUser(ctx.db, user.id)) !== null)
      conflict("You already have an open order");
    const table = await requireActiveTable(ctx.db, args.tableId);
    if ((await openOrderForTable(ctx.db, table.id)) !== null)
      conflict("This table was just taken");
    const now = Date.now();
    return ctx.db.orders.insert({
      userId: user.id,
      tableId: table.id,
      openUserId: user.id,
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
    const { order } = await requireOwnedOpenOrder(
      ctx.db,
      principal.identity,
      args.orderId,
    );
    return addOrderItems(ctx.db, order, args.items);
  },
});

export const cancelItem = mutation({
  access: guestAccess,
  args: { orderId: v.bigint(), orderItemId: v.bigint() },
  handler: async (ctx, args) => {
    const principal = requireUser(ctx.auth);
    const { order } = await requireOwnedOpenOrder(
      ctx.db,
      principal.identity,
      args.orderId,
    );
    const item =
      (await ctx.db.orderItems.get(args.orderItemId)) ??
      notFound("Order item not found");
    if (item.orderId !== order.id) notFound("Order item not found");
    return cancelOrderItem(ctx.db, order, item, `${item.name} was cancelled`);
  },
});

export const closeCancelled = mutation({
  access: guestAccess,
  args: { orderId: v.bigint() },
  handler: async (ctx, args) => {
    const principal = requireUser(ctx.auth);
    const { order } = await requireOwnedOpenOrder(
      ctx.db,
      principal.identity,
      args.orderId,
    );
    const items = await ctx.db.orderItems
      .query()
      .where((item) => item.orderId.eq(order.id))
      .collect();
    if (!items.every((item) => item.status === "CANCELLED")) {
      conflict(
        "Only an empty or all-cancelled order can be closed without payment",
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
    const { order } = await requireOwnedOpenOrder(
      ctx.db,
      principal.identity,
      args.orderId,
    );
    const items = await ctx.db.orderItems
      .query()
      .where((item) => item.orderId.eq(order.id))
      .collect();
    if (
      items.length === 0 ||
      !items.every((item) => isFinal(item.status)) ||
      !items.some((item) => item.status === "SERVED")
    ) {
      conflict("The bill is available after every item is served or cancelled");
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
  handler: async (ctx, args) =>
    orderView(
      ctx.db,
      (await ctx.db.orders.get(args.id)) ?? notFound("Order not found"),
    ),
});

export const create = mutation({
  access: staffAccess,
  args: { userId: v.bigint(), tableId: v.bigint() },
  handler: async (ctx, args) => {
    const user =
      (await ctx.db.users.get(args.userId)) ?? notFound("Guest not found");
    if ((await openOrderForUser(ctx.db, user.id)) !== null)
      conflict("This guest already has an open order");
    const table = await requireActiveTable(ctx.db, args.tableId);
    if ((await openOrderForTable(ctx.db, table.id)) !== null)
      conflict("This table is already occupied");
    const now = Date.now();
    return ctx.db.orders.insert({
      userId: user.id,
      tableId: table.id,
      openUserId: user.id,
      openTableId: table.id,
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
  handler: async (ctx, args) =>
    addOrderItems(
      ctx.db,
      await requireOpenOrder(ctx.db, args.orderId),
      args.items,
    ),
});

export const cancel = mutation({
  access: staffAccess,
  args: { orderId: v.bigint() },
  handler: async (ctx, args) =>
    (await cancelOpenOrder(ctx.db, args.orderId)).order.id,
});
