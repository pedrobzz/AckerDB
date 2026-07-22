import { v } from "@dbzz/server";
import { mutation, query } from "@demo/dbzz-codegen/server";
import { staffAccess } from "../lib/access.ts";
import {
  advanceOrderItem,
  cancelOrderItem,
  notFound,
  requireOpenOrder,
} from "../lib/domain.ts";


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
  handler: async (ctx, args) =>
    (await advanceOrderItem(ctx.db, args.orderItemId)).status,
});

export const cancel = mutation({
  access: staffAccess,
  args: { orderItemId: v.bigint() },
  handler: async (ctx, args) => {
    const item =
      (await ctx.db.orderItems.get(args.orderItemId)) ??
      notFound("Order item not found");
    const order = await requireOpenOrder(ctx.db, item.orderId);
    return cancelOrderItem(
      ctx.db,
      order,
      item,
      `${item.name} was cancelled by the kitchen`,
    );
  },
});
