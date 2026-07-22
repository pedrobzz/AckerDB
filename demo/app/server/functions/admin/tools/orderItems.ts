import { v } from "@dbzz/server";
import { mcpTool } from "@demo/dbzz-codegen/server";
import { itemStatus } from "../../../app.ts";
import { clampLimit, DEFAULT_LIMIT, MAX_LIMIT } from "../../../lib/limits.ts";

/**
 * `get_order_items` — the individual line items on orders, with their kitchen
 * status and timestamps. Reach for this to read one order's items (pass an
 * orderId) or to sweep items by kitchen status across the floor (e.g.
 * everything still PREPARING); orderedAt/statusChangedAt answer how long an
 * item has been waiting.
 */
export const getOrderItems = mcpTool({
  title: "Get order items",
  description:
    "List order line items with quantity, unit price (cents), kitchen status " +
    "and orderedAt/statusChangedAt timestamps. Filter by order and/or one or " +
    "more item statuses. Use it to read an order's items, or to find items in a " +
    "given kitchen state and how long they have waited.",
  access: { anyOf: ["read"] },
  annotations: { readOnlyHint: true },
  args: {
    orderId: v
      .bigint()
      .optional()
      .describe("Restrict to line items on this order id."),
    status: v
      .array(itemStatus)
      .optional()
      .describe(
        "Restrict to these kitchen statuses (any of ORDERED, PREPARING, " +
          "PREPARED, SERVED, CANCELLED). Omit for every status.",
      ),
    limit: v
      .int()
      .optional()
      .describe(`Maximum items to return (1-${MAX_LIMIT}, default ${DEFAULT_LIMIT}).`),
  },
  output: v.object({
    items: v.array(
      v.object({
        id: v.bigint(),
        orderId: v.bigint(),
        menuItemId: v.bigint(),
        name: v.string(),
        quantity: v.int(),
        unitPriceCents: v.int(),
        note: v.string().nullable(),
        status: itemStatus,
        orderedAt: v.int(),
        statusChangedAt: v.int(),
      }),
    ),
  }),
  handler: (ctx, args) =>
    ctx.tx(async (tx) => {
      const limit = clampLimit(args.limit);
      const orderId = args.orderId;
      const status = args.status;
      let query = tx.db.orderItems.query();
      if (orderId !== undefined) {
        query = query.where((item) => item.orderId.eq(orderId));
      }
      if (status !== undefined) {
        query = query.where((item) => item.status.in(status));
      }
      const rows = await query
        .orderBy((item) => item.orderedAt.desc())
        .take(limit);
      const items = rows
        .map((item) => ({
          id: item.id,
          orderId: item.orderId,
          menuItemId: item.menuItemId,
          name: item.name,
          quantity: item.quantity,
          unitPriceCents: item.unitPriceCents,
          note: item.note,
          status: item.status,
          orderedAt: item.orderedAt,
          statusChangedAt: item.statusChangedAt,
        }));
      return { items };
    }),
});
