import { v } from "@dbzz/server";
import { mcpTool } from "@demo/dbzz-codegen/server";
import { orderStatus } from "../../../schema.ts";
import { clampLimit, DEFAULT_LIMIT, MAX_LIMIT } from "../../../lib/limits.ts";

/**
 * `get_orders` — the restaurant's orders (open and closed), newest first. Reach
 * for this to find orders by status ("which are still open?"), by table or
 * guest, or within an opened-at time window; each row carries the ids and
 * timestamps needed to drill into `get_order_items`.
 */
export const getOrders = mcpTool({
  title: "Get orders",
  description:
    "List orders newest first, optionally filtered by status, table, guest, or " +
    "an opened-at time window (millisecond epochs). Use it to find open orders, " +
    "a table's or a guest's orders, or orders in a period; totals are in cents.",
  access: { anyOf: ["read"] },
  annotations: { readOnlyHint: true },
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
  output: v.object({
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
  handler: (ctx, args) =>
    ctx.tx(async (tx) => {
      const limit = clampLimit(args.limit);
      const rows = await tx.db.orders.scan().collect();
      const orders = rows
        .filter(
          (order) =>
            (args.status === undefined || order.status === args.status) &&
            (args.tableId === undefined || order.tableId === args.tableId) &&
            (args.userId === undefined || order.userId === args.userId) &&
            (args.openedAfter === undefined || order.openedAt >= args.openedAfter) &&
            (args.openedBefore === undefined || order.openedAt <= args.openedBefore),
        )
        .sort((a, b) => b.openedAt - a.openedAt)
        .slice(0, limit)
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
    }),
});
