import { dbz } from "@dbzz/server";
import { mutation, query } from "@demo/dbzz-codegen/server";
import { isStaff, requireUser } from "../lib/access.ts";
import {
  addOrderItems,
  clearReminder,
  conflict,
  emitOrderEvent,
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
const staffAccess = (ctx: { auth: Parameters<typeof isStaff>[0] }) =>
  isStaff(ctx.auth);
const cartArgs = dbz.array(
  dbz.object({
    menuItemId: dbz.bigint(),
    quantity: dbz.number(),
    note: dbz.nullable(dbz.string()),
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
      .byUserOpenedAt((q) => q.eq("userId", user.id))
      .order("desc")
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
  args: { tableId: dbz.bigint() },
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
  args: { orderId: dbz.bigint(), items: cartArgs },
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
  args: { orderId: dbz.bigint(), orderItemId: dbz.bigint() },
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
    if (item.status !== "ORDERED")
      conflict("Only a newly ordered item can be cancelled");
    const now = Date.now();
    await ctx.db.orderItems.patch(item.id, {
      status: "CANCELLED",
      statusChangedAt: now,
    });
    await clearReminder(ctx.db, item.id);
    await ctx.db.orders.patch(order.id, {
      totalCents: Math.max(
        0,
        order.totalCents - item.unitPriceCents * item.quantity,
      ),
    });
    await emitOrderEvent(ctx.db, order, {
      orderItemId: item.id,
      kind: "ITEM_STATUS",
      status: "CANCELLED",
      message: `${item.name} was cancelled`,
      occurredAt: now,
    });
    return item.id;
  },
});

export const closeCancelled = mutation({
  access: guestAccess,
  args: { orderId: dbz.bigint() },
  handler: async (ctx, args) => {
    const principal = requireUser(ctx.auth);
    const { order } = await requireOwnedOpenOrder(
      ctx.db,
      principal.identity,
      args.orderId,
    );
    const items = await ctx.db.orderItems
      .byOrder((q) => q.eq("orderId", order.id))
      .collect();
    if (!items.every((item) => item.status === "CANCELLED")) {
      conflict(
        "Only an empty or all-cancelled order can be closed without payment",
      );
    }
    const now = Date.now();
    await ctx.db.orders.patch(order.id, {
      status: "CANCELLED",
      totalCents: 0,
      openUserId: null,
      openTableId: null,
      closedAt: now,
    });
    await emitOrderEvent(ctx.db, order, {
      kind: "ORDER_STATUS",
      status: "CANCELLED",
      message: "Your order was closed",
      occurredAt: now,
    });
    return order.id;
  },
});

export const pay = mutation({
  access: guestAccess,
  args: { orderId: dbz.bigint() },
  handler: async (ctx, args) => {
    const principal = requireUser(ctx.auth);
    const { order } = await requireOwnedOpenOrder(
      ctx.db,
      principal.identity,
      args.orderId,
    );
    const items = await ctx.db.orderItems
      .byOrder((q) => q.eq("orderId", order.id))
      .collect();
    if (
      items.length === 0 ||
      !items.every((item) => isFinal(item.status)) ||
      !items.some((item) => item.status === "SERVED")
    ) {
      conflict("The bill is available after every item is served or cancelled");
    }
    const now = Date.now();
    const totalCents = payableCents(items);
    await ctx.db.orders.patch(order.id, {
      status: "PAID",
      totalCents,
      openUserId: null,
      openTableId: null,
      closedAt: now,
    });
    await emitOrderEvent(ctx.db, order, {
      kind: "ORDER_STATUS",
      status: "PAID",
      message: "Payment complete — thank you",
      occurredAt: now,
    });
    return { orderId: order.id, totalCents };
  },
});

export const list = query({
  access: staffAccess,
  args: {},
  handler: async (ctx) => {
    const orders = await ctx.db.orders.scan().order("desc").collect();
    return Promise.all(orders.map((order) => orderView(ctx.db, order)));
  },
});

export const detail = query({
  access: staffAccess,
  args: { id: dbz.bigint() },
  handler: async (ctx, args) =>
    orderView(
      ctx.db,
      (await ctx.db.orders.get(args.id)) ?? notFound("Order not found"),
    ),
});

export const create = mutation({
  access: staffAccess,
  args: { userId: dbz.bigint(), tableId: dbz.bigint() },
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
  args: { orderId: dbz.bigint(), items: cartArgs },
  handler: async (ctx, args) =>
    addOrderItems(
      ctx.db,
      await requireOpenOrder(ctx.db, args.orderId),
      args.items,
    ),
});

export const cancel = mutation({
  access: staffAccess,
  args: { orderId: dbz.bigint() },
  handler: async (ctx, args) => {
    const order = await requireOpenOrder(ctx.db, args.orderId);
    const items = await ctx.db.orderItems
      .byOrder((q) => q.eq("orderId", order.id))
      .collect();
    for (const item of items) await clearReminder(ctx.db, item.id);
    const now = Date.now();
    await ctx.db.orders.patch(order.id, {
      status: "CANCELLED",
      totalCents: 0,
      openUserId: null,
      openTableId: null,
      closedAt: now,
    });
    await emitOrderEvent(ctx.db, order, {
      kind: "ORDER_STATUS",
      status: "CANCELLED",
      message: "The restaurant cancelled this order",
      occurredAt: now,
    });
    return order.id;
  },
});
