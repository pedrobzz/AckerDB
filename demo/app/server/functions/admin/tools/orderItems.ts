import { dbz } from "@dbzz/server";
import { itemStatus } from "../../../schema.ts";
import { clampLimit, DEFAULT_LIMIT, MAX_LIMIT } from "../../../lib/limits.ts";
import { admin } from "../mcp.ts";

/**
 * `get_order_items` — the individual line items on orders, with their kitchen
 * status and timestamps. Reach for this to read one order's items (pass an
 * orderId) or to sweep items by kitchen status across the floor (e.g.
 * everything still PREPARING); orderedAt/statusChangedAt answer how long an
 * item has been waiting.
 */
export const getOrderItems = admin.tool({
  name: "get_order_items",
  title: "Get order items",
  description:
    "List order line items with quantity, unit price (cents), kitchen status " +
    "and orderedAt/statusChangedAt timestamps. Filter by order and/or one or " +
    "more item statuses. Use it to read an order's items, or to find items in a " +
    "given kitchen state and how long they have waited.",
  access: { anyOf: ["read"] },
  annotations: { readOnlyHint: true },
  args: {
    orderId: dbz
      .nullable(dbz.bigint())
      .describe("Restrict to line items on this order id."),
    status: dbz
      .nullable(dbz.array(itemStatus))
      .describe(
        "Restrict to these kitchen statuses (any of ORDERED, PREPARING, " +
          "PREPARED, SERVED, CANCELLED). Omit for every status.",
      ),
    limit: dbz
      .nullable(dbz.number())
      .describe(`Maximum items to return (1-${MAX_LIMIT}, default ${DEFAULT_LIMIT}).`),
  },
  output: dbz.object({
    items: dbz.array(
      dbz.object({
        id: dbz.bigint(),
        orderId: dbz.bigint(),
        menuItemId: dbz.bigint(),
        name: dbz.string(),
        quantity: dbz.number(),
        unitPriceCents: dbz.number(),
        note: dbz.nullable(dbz.string()),
        status: itemStatus,
        orderedAt: dbz.number(),
        statusChangedAt: dbz.number(),
      }),
    ),
  }),
  handler: (ctx, args) =>
    ctx.tx(async (tx) => {
      const limit = clampLimit(args.limit);
      const statuses = args.status === null ? null : new Set(args.status);
      const orderId = args.orderId;
      const rows =
        orderId === null
          ? await tx.db.orderItems.scan().collect()
          : await tx.db.orderItems
              .byOrder((q) => q.eq("orderId", orderId))
              .order("asc")
              .collect();
      const items = rows
        .filter((item) => statuses === null || statuses.has(item.status))
        .sort((a, b) => b.orderedAt - a.orderedAt)
        .slice(0, limit)
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
