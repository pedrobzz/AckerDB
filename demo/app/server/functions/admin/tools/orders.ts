import { dbz } from "@dbzz/server";
import { orderStatus } from "../../../schema.ts";
import { admin } from "../mcp.ts";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function clampLimit(limit: number | null): number {
  if (limit === null) return DEFAULT_LIMIT;
  if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

/**
 * `get_orders` — the restaurant's orders (open and closed), newest first. Reach
 * for this to find orders by status ("which are still open?"), by table or
 * guest, or within an opened-at time window; each row carries the ids and
 * timestamps needed to drill into `get_order_items`.
 */
export const getOrders = admin.tool({
  name: "get_orders",
  title: "Get orders",
  description:
    "List orders newest first, optionally filtered by status, table, guest, or " +
    "an opened-at time window (millisecond epochs). Use it to find open orders, " +
    "a table's or a guest's orders, or orders in a period; totals are in cents.",
  access: { anyOf: ["read"] },
  annotations: { readOnlyHint: true },
  args: {
    status: dbz
      .nullable(orderStatus)
      .describe("Restrict to one order status (OPEN, PAID or CANCELLED)."),
    tableId: dbz
      .nullable(dbz.bigint())
      .describe("Restrict to orders seated at this table id."),
    userId: dbz
      .nullable(dbz.bigint())
      .describe("Restrict to orders belonging to this guest id."),
    openedAfter: dbz
      .nullable(dbz.number())
      .describe("Only orders opened at or after this millisecond epoch."),
    openedBefore: dbz
      .nullable(dbz.number())
      .describe("Only orders opened at or before this millisecond epoch."),
    limit: dbz
      .nullable(dbz.number())
      .describe(`Maximum orders to return (1-${MAX_LIMIT}, default ${DEFAULT_LIMIT}).`),
  },
  output: dbz.object({
    orders: dbz.array(
      dbz.object({
        id: dbz.bigint(),
        userId: dbz.bigint(),
        tableId: dbz.bigint(),
        status: orderStatus,
        totalCents: dbz.number(),
        openedAt: dbz.number(),
        closedAt: dbz.nullable(dbz.number()),
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
            (args.status === null || order.status === args.status) &&
            (args.tableId === null || order.tableId === args.tableId) &&
            (args.userId === null || order.userId === args.userId) &&
            (args.openedAfter === null || order.openedAt >= args.openedAfter) &&
            (args.openedBefore === null || order.openedAt <= args.openedBefore),
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
