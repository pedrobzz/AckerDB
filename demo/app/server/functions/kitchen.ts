import { Err, Status } from "@dbzz/core";
import { v } from "@dbzz/server";
import { mutation, query } from "@demo/dbzz-codegen/server";
import { staffAccess } from "../lib/access.ts";
import {
  advanceOrderItem,
  cancelOrderItem,
} from "../lib/domain/order-workflow.ts";
import { openOrder } from "../lib/domain/orders.ts";

export const queue = query({
  access: staffAccess,
  args: {},
  handler: async (ctx) => {
    const orders = await ctx.db.orders
      .query()
      .where((order) => order.status.eq("OPEN"))
      .orderBy((order) => order.openedAt.asc())
      .collect();
    const rows = [];
    for (const order of orders) {
      const [table, user, items] = await Promise.all([
        ctx.db.restaurantTables.get(order.tableId),
        ctx.db.users.get(order.userId),
        ctx.db.orderItems
          .query()
          .where((item) => item.orderId.eq(order.id))
          .orderBy((item) => item.orderedAt.asc())
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
  args: { orderItemId: v.bigint() },
  handler: async (ctx, args) => {
    const result = await advanceOrderItem(ctx.db, args.orderItemId);
    return result.ok ? result.data.status : result;
  },
});

export const cancel = mutation({
  access: staffAccess,
  args: { orderItemId: v.bigint() },
  handler: async (ctx, args) => {
    const item = await ctx.db.orderItems.get(args.orderItemId);
    if (item === null) {
      return Err(
        "order-item.not-found",
        { orderItemId: args.orderItemId },
        Status.NotFound,
      );
    }
    const order = await openOrder(ctx.db, item.orderId);
    if (!order.ok) return order;
    return cancelOrderItem(
      ctx.db,
      order.data,
      item,
      `${item.name} was cancelled by the kitchen`,
    );
  },
});
