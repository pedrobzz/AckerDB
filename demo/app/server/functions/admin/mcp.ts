import { createMcp } from "@demo/ackerdb-codegen/server";
import { advanceKitchenItem, cancelOrder } from "./tools/actions.ts";
import { getGuests } from "./tools/guests.ts";
import { getMenuCategories } from "./tools/menuCategories.ts";
import { getMenuItems } from "./tools/menuItems.ts";
import { getOrderItems } from "./tools/orderItems.ts";
import { getOrders } from "./tools/orders.ts";
import { getTables } from "./tools/tables.ts";
import { bashWorkspace } from "./tools/workspace.ts";

/**
 * The demo backend's single MCP endpoint: staff-only, mounted at the default
 * `/mcp` path. It is the shared surface both the in-app Admin Chat and external
 * agent hosts (Codex, Claude Code) consume — what a caller may do is decided
 * solely by the scopes on its credential.
 *
 * Every tool module exports an inert blueprint. This endpoint is the sole place
 * that assigns wire names and assembles the complete Admin tool surface.
 */
export const admin = createMcp({
  name: "admin",
  scopes: ["read", "operate"] as const,
  tools: {
    advance_kitchen_item: advanceKitchenItem,
    bash: bashWorkspace,
    cancel_order: cancelOrder,
    get_guests: getGuests,
    get_menu_categories: getMenuCategories,
    get_menu_items: getMenuItems,
    get_order_items: getOrderItems,
    get_orders: getOrders,
    get_tables: getTables,
  },
  instructions:
    "Savoria restaurant Admin MCP — a staff-only view of the live restaurant. " +
    "The `read` scope grants read-only tools that answer questions about the " +
    "floor, kitchen, menu and guests; the `operate` scope additionally grants " +
    "the staff action tools. Tool wire names are lower_snake_case and numeric " +
    "identifiers are serialized losslessly as strings. Call tools/list to see " +
    "exactly the tools your credential is allowed to use.",
  metadata: {
    title: "Savoria Admin",
    description: "Staff-only MCP over the Savoria restaurant's live data.",
  },
});
