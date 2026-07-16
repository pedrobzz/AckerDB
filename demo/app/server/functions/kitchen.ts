import { dbz } from "@dbzz/server";
import { mutation, query } from "@demo/dbzz-codegen/server";
import { isStaff } from "../lib/access.ts";
import {
  clearReminder,
  conflict,
  emitOrderEvent,
  nextItemStatus,
  notFound,
  requireOpenOrder,
  scheduleReminder,
} from "../lib/domain.ts";

const staffAccess = (ctx: { auth: Parameters<typeof isStaff>[0] }) =>
  isStaff(ctx.auth);

export const queue = query({
  access: staffAccess,
  args: {},
  handler: async (ctx) => {
    const orders = await ctx.db.orders
      .byStatusOpenedAt((q) => q.eq("status", "OPEN"))
      .order("asc")
      .collect();
    const rows = [];
    for (const order of orders) {
      const [table, user, items] = await Promise.all([
        ctx.db.restaurantTables.get(order.tableId),
        ctx.db.users.get(order.userId),
        ctx.db.orderItems
          .byOrder((q) => q.eq("orderId", order.id))
          .order("asc")
          .collect(),
      ]);
      if (table === null || user === null) continue;
      for (const item of items) {
        rows.push({
          ...item,
          orderId: order.id,
          tableNumber: table.number,
          guestName: user.name,
        });
      }
    }
    return rows;
  },
});

export const advance = mutation({
  access: staffAccess,
  args: { orderItemId: dbz.bigint() },
  handler: async (ctx, args) => {
    const item =
      (await ctx.db.orderItems.get(args.orderItemId)) ??
      notFound("Order item not found");
    const order = await requireOpenOrder(ctx.db, item.orderId);
    const status = nextItemStatus(item.status);
    if (status === null) conflict("This item is already final");
    const now = Date.now();
    await ctx.db.orderItems.patch(item.id, { status, statusChangedAt: now });
    await scheduleReminder(ctx.db, item.id, status, now);
    const phrase =
      status === "PREPARING"
        ? "is now being prepared"
        : status === "PREPARED"
          ? "is ready"
          : "was served";
    await emitOrderEvent(ctx.db, order, {
      orderItemId: item.id,
      kind: "ITEM_STATUS",
      status,
      message: `${item.name} ${phrase}`,
      occurredAt: now,
    });
    return status;
  },
});

export const cancel = mutation({
  access: staffAccess,
  args: { orderItemId: dbz.bigint() },
  handler: async (ctx, args) => {
    const item =
      (await ctx.db.orderItems.get(args.orderItemId)) ??
      notFound("Order item not found");
    const order = await requireOpenOrder(ctx.db, item.orderId);
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
      message: `${item.name} was cancelled by the kitchen`,
      occurredAt: now,
    });
    return item.id;
  },
});
