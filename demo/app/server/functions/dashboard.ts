import { query } from "@demo/dbzz-codegen/server";
import { isStaff } from "../lib/access.ts";
import { isFinal, orderView, REMINDER_DELAY_MS } from "../lib/domain.ts";

const staffAccess = (ctx: { auth: Parameters<typeof isStaff>[0] }) =>
  isStaff(ctx.auth);

export const overview = query({
  access: staffAccess,
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    const [tables, users, orders] = await Promise.all([
      ctx.db.restaurantTables.scan().collect(),
      ctx.db.users.scan().collect(),
      ctx.db.orders.scan().collect(),
    ]);
    const activeTables = tables.filter((table) => table.active);
    const openOrders = orders.filter((order) => order.status === "OPEN");
    const paidToday = orders.filter(
      (order) =>
        order.status === "PAID" &&
        (order.closedAt ?? 0) >= startOfToday.getTime(),
    );
    const attention = [];
    for (const order of openOrders) {
      const [table, items] = await Promise.all([
        ctx.db.restaurantTables.get(order.tableId),
        ctx.db.orderItems.byOrder((q) => q.eq("orderId", order.id)).collect(),
      ]);
      if (table === null) continue;
      for (const item of items) {
        if (
          !isFinal(item.status) &&
          item.statusChangedAt <= now - REMINDER_DELAY_MS
        ) {
          attention.push({
            orderId: order.id,
            orderItemId: item.id,
            tableNumber: table.number,
            itemName: item.name,
            status: item.status,
            elapsedMs: now - item.statusChangedAt,
          });
        }
      }
    }
    const recent = [...orders]
      .sort((a, b) => b.openedAt - a.openedAt)
      .slice(0, 5);
    return {
      tableCount: activeTables.length,
      availableTableCount: activeTables.length - openOrders.length,
      occupiedTableCount: openOrders.length,
      openOrderCount: openOrders.length,
      guestCount: users.length,
      salesTodayCents: paidToday.reduce(
        (sum, order) => sum + order.totalCents,
        0,
      ),
      attention: attention.sort((a, b) => b.elapsedMs - a.elapsedMs),
      recentOrders: await Promise.all(
        recent.map((order) => orderView(ctx.db, order)),
      ),
    };
  },
});
