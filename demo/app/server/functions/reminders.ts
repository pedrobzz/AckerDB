import { v } from "@dbzz/server";
import { mutation } from "@demo/dbzz-codegen/server";
import { itemStatus } from "../schema.ts";

export const fire = mutation({
  access: "system",
  args: {
    id: v.bigint(),
    orderItemId: v.bigint(),
    expectedStatus: itemStatus,
    at: v.int(),
  },
  handler: async (ctx, args) => {
    const item = await ctx.db.orderItems.get(args.orderItemId);
    if (item === null || item.status !== args.expectedStatus) return false;
    const order = await ctx.db.orders.get(item.orderId);
    if (order === null || order.status !== "OPEN") return false;
    const table = await ctx.db.restaurantTables.get(order.tableId);
    if (table === null) return false;
    await ctx.db.staffEvents.insert({
      kind: "KITCHEN_REMINDER",
      orderId: order.id,
      orderItemId: item.id,
      tableNumber: table.number,
      itemName: item.name,
      status: item.status,
      message: `${item.name} at table ${table.number} still needs attention`,
      occurredAt: Date.now(),
    });
    return true;
  },
});
