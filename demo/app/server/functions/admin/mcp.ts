import { createMcp } from "@demo/dbzz-codegen/server";

/**
 * The demo backend's single MCP endpoint: staff-only, mounted at the default
 * `/mcp` path. It is the shared surface both the in-app Admin Chat and external
 * agent hosts (Codex, Claude Code) consume — what a caller may do is decided
 * solely by the scopes on its credential.
 *
 * This module only declares the endpoint. Every tool lives in its own module
 * under `admin/tools/` and registers itself against this declaration, so later
 * tickets add tools as new files without touching this one or each other.
 */
export const admin = createMcp({
  name: "admin",
  scopes: ["read", "operate"] as const,
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
