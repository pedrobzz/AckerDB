import { dbz } from "@dbzz/server";
import { clampLimit, DEFAULT_LIMIT, MAX_LIMIT } from "../../../lib/limits.ts";
import { admin } from "../mcp.ts";

/**
 * `get_menu_items` — the dishes and drinks on the menu, with prices. Reach for
 * this to look up a dish (its price, description or menuItemId), to list one
 * category's offerings (pass a categoryId from `get_menu_categories`), or to
 * read the whole menu.
 */
export const getMenuItems = admin.tool({
  name: "get_menu_items",
  title: "Get menu items",
  description:
    "List menu items (dishes and drinks) with their price in cents, optionally " +
    "restricted to one category and/or active items only. Use it to look up a " +
    "dish's price or id, or to enumerate a category's offerings.",
  access: { anyOf: ["read"] },
  annotations: { readOnlyHint: true },
  args: {
    categoryId: dbz
      .nullable(dbz.bigint())
      .describe("Restrict to one menu category (its id from get_menu_categories)."),
    activeOnly: dbz
      .nullable(dbz.boolean())
      .describe("When true, exclude retired (inactive) items."),
    limit: dbz
      .nullable(dbz.number())
      .describe(`Maximum items to return (1-${MAX_LIMIT}, default ${DEFAULT_LIMIT}).`),
  },
  output: dbz.object({
    items: dbz.array(
      dbz.object({
        id: dbz.bigint(),
        categoryId: dbz.bigint(),
        name: dbz.string(),
        description: dbz.string(),
        priceCents: dbz.number(),
        sortOrder: dbz.number(),
        active: dbz.boolean(),
      }),
    ),
  }),
  handler: (ctx, args) =>
    ctx.tx(async (tx) => {
      const limit = clampLimit(args.limit);
      const activeOnly = args.activeOnly ?? false;
      const categoryId = args.categoryId;
      const rows =
        categoryId === null
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
