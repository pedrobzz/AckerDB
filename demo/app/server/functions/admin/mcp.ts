import { mcp, mcpAuth } from "@demo/ackerdb-codegen/server";
import { advanceKitchenItem, cancelOrder } from "./tools/actions.ts";
import { getGuests } from "./tools/guests.ts";
import { getMenuCategories } from "./tools/menuCategories.ts";
import { getMenuItems } from "./tools/menuItems.ts";
import { getOrderItems } from "./tools/orderItems.ts";
import { getOrders } from "./tools/orders.ts";
import { getTables } from "./tools/tables.ts";
import { bashWorkspace } from "./tools/workspace.ts";

/**
 * The scope vocabulary and the token vault behind the Admin surface. Tokens
 * belong to the provider rather than to the endpoint, so `admin/tokens.ts`
 * issues and revokes them here while the endpoint below only decides which
 * scope each published tool demands.
 */
export const adminAuth = mcpAuth({
  name: "admin",
  scopes: ["read", "operate"] as const,
});

/**
 * The demo backend's single MCP endpoint: staff-only, mounted at the default
 * `/mcp` path. It is the shared surface both the in-app Admin Chat and external
 * agent hosts (Codex, Claude Code) consume — what a caller may do is decided
 * solely by the scopes on its credential.
 *
 * Every tool module exports an ordinary registered function. This endpoint is
 * the sole place that assigns wire names, demands scopes, and assembles the
 * complete Admin tool surface.
 */
export const admin = mcp({
  name: "admin",
  auth: adminAuth,
  tools: {
    advance_kitchen_item: {
      fn: advanceKitchenItem,
      access: { anyOf: ["operate"] },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    bash: {
      fn: bashWorkspace,
      access: { anyOf: ["read"] },
      annotations: { readOnlyHint: true },
    },
    cancel_order: {
      fn: cancelOrder,
      access: { anyOf: ["operate"] },
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    get_guests: {
      fn: getGuests,
      access: { anyOf: ["read"] },
      annotations: { readOnlyHint: true },
    },
    get_menu_categories: {
      fn: getMenuCategories,
      access: { anyOf: ["read"] },
      annotations: { readOnlyHint: true },
    },
    get_menu_items: {
      fn: getMenuItems,
      access: { anyOf: ["read"] },
      annotations: { readOnlyHint: true },
    },
    get_order_items: {
      fn: getOrderItems,
      access: { anyOf: ["read"] },
      annotations: { readOnlyHint: true },
    },
    get_orders: {
      fn: getOrders,
      access: { anyOf: ["read"] },
      annotations: { readOnlyHint: true },
    },
    get_tables: {
      fn: getTables,
      access: { anyOf: ["read"] },
      annotations: { readOnlyHint: true },
    },
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
