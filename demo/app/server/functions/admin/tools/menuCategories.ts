import { v } from "@dbzz/server";
import { mcpTool } from "@demo/dbzz-codegen/server";
import { clampLimit, DEFAULT_LIMIT, MAX_LIMIT } from "../../../lib/limits.ts";

/**
 * `get_menu_categories` — the menu's sections in menu order. Reach for this to
 * enumerate what parts the menu has ("which sections are there?") or to resolve
 * a categoryId before drilling into `get_menu_items`.
 */
export const getMenuCategories = mcpTool({
  title: "Get menu categories",
  description:
    "List the menu's categories (sections) in menu order. Use it to enumerate " +
    "the menu's sections, or to resolve a category before calling " +
    "get_menu_items. Optionally restrict to active categories and cap the count.",
  access: { anyOf: ["read"] },
  annotations: { readOnlyHint: true },
  args: {
    activeOnly: v
      .boolean()
      .optional()
      .describe("When true, exclude retired (inactive) categories."),
    limit: v
      .int()
      .optional()
      .describe(`Maximum categories to return (1-${MAX_LIMIT}, default ${DEFAULT_LIMIT}).`),
  },
  output: v.object({
    categories: v.array(
      v.object({
        id: v.bigint(),
        name: v.string(),
        sortOrder: v.int(),
        active: v.boolean(),
      }),
    ),
  }),
  handler: (ctx, args) =>
    ctx.tx(async (tx) => {
      const limit = clampLimit(args.limit);
      const activeOnly = args.activeOnly ?? false;
      const query = tx.db.menuCategories.query();
      const selected = activeOnly
        ? query.where((category) => category.active.eq(true))
        : query;
      const rows = await selected
        .orderBy((category) => category.sortOrder.asc())
        .take(limit);
      const categories = rows
        .map((category) => ({
          id: category.id,
          name: category.name,
          sortOrder: category.sortOrder,
          active: category.active,
        }));
      return { categories };
    }),
});
