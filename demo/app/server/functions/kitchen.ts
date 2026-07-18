import { dbz } from "@dbzz/server";
import { mutation, query } from "@demo/dbzz-codegen/server";
import { isStaff } from "../lib/access.ts";
import {
  advanceOrderItem,
  cancelOrderItem,
  notFound,
  requireOpenOrder,
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
  handler: async (ctx, args) =>
    (await advanceOrderItem(ctx.db, args.orderItemId)).status,
});

export const cancel = mutation({
  access: staffAccess,
  args: { orderItemId: dbz.bigint() },
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
