import { v } from "@ackerdb/server";
import { query } from "@demo/ackerdb-codegen/server";
import { adminToolAccess } from "../../../lib/access.ts";
import { orderStatus } from "../../../app.ts";
import { clampLimit, DEFAULT_LIMIT, MAX_LIMIT } from "../../../lib/limits.ts";

/**
 * `get_orders` — the restaurant's orders (open and closed), newest first. Reach
 * for this to find orders by status ("which are still open?"), by table or
 * guest, or within an opened-at time window; each row carries the ids and
 * timestamps needed to drill into `get_order_items`.
 */
export const getOrders = query({
  title: "Get orders",
  description:
    "List orders newest first, optionally filtered by status, table, guest, or " +
    "an opened-at time window (millisecond epochs). Use it to find open orders, " +
    "a table's or a guest's orders, or orders in a period; totals are in cents.",
  access: adminToolAccess,
  args: {
    status: orderStatus
      .optional()
      .describe("Restrict to one order status (OPEN, PAID or CANCELLED)."),
    tableId: v
      .bigint()
      .optional()
      .describe("Restrict to orders seated at this table id."),
    userId: v
      .bigint()
      .optional()
      .describe("Restrict to orders belonging to this guest id."),
    openedAfter: v
      .int()
      .optional()
      .describe("Only orders opened at or after this millisecond epoch."),
    openedBefore: v
      .int()
      .optional()
      .describe("Only orders opened at or before this millisecond epoch."),
    limit: v
      .int()
      .optional()
      .describe(`Maximum orders to return (1-${MAX_LIMIT}, default ${DEFAULT_LIMIT}).`),
  },
  returns: v.object({
    orders: v.array(
      v.object({
        id: v.bigint(),
        userId: v.bigint(),
        tableId: v.bigint(),
        status: orderStatus,
        totalCents: v.int(),
        openedAt: v.int(),
        closedAt: v.int().nullable(),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const limit = clampLimit(args.limit);
    let query = ctx.db.orders.query();
    if (args.status !== undefined) {
      const status = args.status;
      query = query.where((order) => order.status.eq(status));
    }
    if (args.tableId !== undefined) {
      const tableId = args.tableId;
      query = query.where((order) => order.tableId.eq(tableId));
    }
    if (args.userId !== undefined) {
      const userId = args.userId;
      query = query.where((order) => order.userId.eq(userId));
    }
    if (args.openedAfter !== undefined) {
      const openedAfter = args.openedAfter;
      query = query.where((order) => order.openedAt.gte(openedAfter));
    }
    if (args.openedBefore !== undefined) {
      const openedBefore = args.openedBefore;
      query = query.where((order) => order.openedAt.lte(openedBefore));
    }
    const rows = await query
      .orderBy((order) => order.openedAt.desc())
      .take(limit);
    const orders = rows
      .map((order) => ({
        id: order.id,
        userId: order.userId,
        tableId: order.tableId,
        status: order.status,
        totalCents: order.totalCents,
        openedAt: order.openedAt,
        closedAt: order.closedAt,
      }));
    return { orders };
  },
});
