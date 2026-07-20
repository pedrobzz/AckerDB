import { v } from "@dbzz/server";
import { mcpTool } from "@demo/dbzz-codegen/server";
import { clampLimit, DEFAULT_LIMIT, MAX_LIMIT } from "../../../lib/limits.ts";

/**
 * `get_menu_items` — the dishes and drinks on the menu, with prices. Reach for
 * this to look up a dish (its price, description or menuItemId), to list one
 * category's offerings (pass a categoryId from `get_menu_categories`), or to
 * read the whole menu.
 */
export const getMenuItems = mcpTool({
  title: "Get menu items",
  description:
    "List menu items (dishes and drinks) with their price in cents, optionally " +
    "restricted to one category and/or active items only. Use it to look up a " +
    "dish's price or id, or to enumerate a category's offerings.",
  access: { anyOf: ["read"] },
  annotations: { readOnlyHint: true },
  args: {
    categoryId: v
      .bigint()
      .optional()
      .describe("Restrict to one menu category (its id from get_menu_categories)."),
    activeOnly: v
      .boolean()
      .optional()
      .describe("When true, exclude retired (inactive) items."),
    limit: v
      .int()
      .optional()
      .describe(`Maximum items to return (1-${MAX_LIMIT}, default ${DEFAULT_LIMIT}).`),
  },
  output: v.object({
    items: v.array(
      v.object({
        id: v.bigint(),
        categoryId: v.bigint(),
        name: v.string(),
        description: v.string(),
        priceCents: v.int(),
        sortOrder: v.int(),
        active: v.boolean(),
      }),
    ),
  }),
  handler: (ctx, args) =>
    ctx.tx(async (tx) => {
      const limit = clampLimit(args.limit);
      const activeOnly = args.activeOnly ?? false;
      const categoryId = args.categoryId;
      const rows =
        categoryId === undefined
          ? (await tx.db.menuItems.scan().collect()).sort((a, b) =>
              a.categoryId === b.categoryId
                ? a.sortOrder - b.sortOrder
                : a.categoryId < b.categoryId
                  ? -1
                  : 1,
            )
          : await tx.db.menuItems
              .byCategory((q) => q.eq("categoryId", categoryId))
              .order("asc")
              .collect();
      const items = rows
        .filter((item) => (activeOnly ? item.active : true))
        .slice(0, limit)
        .map((item) => ({
          id: item.id,
          categoryId: item.categoryId,
          name: item.name,
          description: item.description,
          priceCents: item.priceCents,
          sortOrder: item.sortOrder,
          active: item.active,
        }));
      return { items };
    }),
});
