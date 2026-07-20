import { v } from "@dbzz/server";
import {
  advanceOrderItem,
  cancelOpenOrder,
  isFinal,
  notFound,
} from "../../../lib/domain.ts";
import { itemStatus } from "../../../schema.ts";
import { admin } from "../mcp.ts";

/**
 * The staff action tools, gated behind the `operate` scope. Each one reuses the
 * exact domain rule the corresponding staff mutation runs, inside `ctx.tx` so a
 * rejected transition (illegal advance, non-open order, unknown id) rolls back
 * with no partial write and surfaces as a safe `isError` tool result.
 */

/**
 * `advance_kitchen_item` — move one order item to its next kitchen status along
 * ORDERED → PREPARING → PREPARED → SERVED. An already-final item (SERVED or
 * CANCELLED) or an item on a closed order is rejected.
 */
export const advanceKitchenItem = admin.tool({
  name: "advance_kitchen_item",
  title: "Advance kitchen item",
  description:
    "Advance one order item to the next kitchen status along ORDERED → " +
    "PREPARING → PREPARED → SERVED. Fails if the item is already served or " +
    "cancelled, or if its order is no longer open.",
  access: { anyOf: ["operate"] },
  annotations: { destructiveHint: false, idempotentHint: false },
  args: {
    orderItemId: v
      .bigint()
      .describe("Identifier of the order item to advance."),
  },
  output: v.object({
    orderItemId: v.bigint(),
    orderId: v.bigint(),
    status: itemStatus,
  }),
  handler: (ctx, args) =>
    ctx.tx((tx) => advanceOrderItem(tx.db, args.orderItemId)),
});

/**
 * `cancel_order` — cancel an OPEN order, which clears the open-table index and
 * so frees its table. A PAID or already-CANCELLED order (or an unknown id) is
 * rejected. The summary splits items into those voided in flight and those left
 * as-is because they were already final.
 */
export const cancelOrder = admin.tool({
  name: "cancel_order",
  title: "Cancel order",
  description:
    "Cancel an open order and free its table. Fails if the order is not " +
    "open (already paid or cancelled) or does not exist. Returns the freed " +
    "table and how many items were voided versus already final.",
  access: { anyOf: ["operate"] },
  annotations: { destructiveHint: true, idempotentHint: false },
  args: {
    orderId: v.bigint().describe("Identifier of the open order to cancel."),
  },
  output: v.object({
    orderId: v.bigint(),
    tableId: v.bigint(),
    tableNumber: v.int(),
    itemsCancelled: v.int(),
    itemsPreserved: v.int(),
  }),
  handler: (ctx, args) =>
    ctx.tx(async (tx) => {
      const { order, items } = await cancelOpenOrder(tx.db, args.orderId);
      const table =
        (await tx.db.restaurantTables.get(order.tableId)) ??
        notFound("Table not found");
      let itemsCancelled = 0;
      let itemsPreserved = 0;
      for (const item of items) {
        if (isFinal(item.status)) itemsPreserved += 1;
        else itemsCancelled += 1;
      }
      return {
        orderId: order.id,
        tableId: table.id,
        tableNumber: table.number,
        itemsCancelled,
        itemsPreserved,
      };
    }),
});
