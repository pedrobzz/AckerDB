import { v } from "@dbzz/server";
import { mcpTool } from "@demo/dbzz-codegen/server";
import { openOrderForTable } from "../../../lib/domain/orders.ts";
import { clampLimit, DEFAULT_LIMIT, MAX_LIMIT } from "../../../lib/limits.ts";

/**
 * `get_tables` — the first entity query tool. Returns the restaurant's tables
 * with their occupancy state derived from the open-order index, so an agent can
 * answer "which tables are free?" without composing a pipeline.
 */
export const getTables = mcpTool({
  title: "Get tables",
  description:
    "List the restaurant's tables and whether each is occupied by an open " +
    "order. Optionally restrict to active tables and cap the number returned.",
  access: { anyOf: ["read"] },
  annotations: { readOnlyHint: true },
  args: {
    activeOnly: v
      .boolean()
      .optional()
      .describe("When true, exclude retired (inactive) tables."),
    limit: v
      .int()
      .optional()
      .describe(`Maximum tables to return (1-${MAX_LIMIT}, default ${DEFAULT_LIMIT}).`),
  },
  output: v.object({
    tables: v.array(
      v.object({
        id: v.bigint(),
        number: v.int(),
        seats: v.int(),
        active: v.boolean(),
        occupied: v.boolean(),
        orderId: v.bigint().nullable(),
      }),
    ),
  }),
  handler: (ctx, args) =>
    ctx.tx(async (tx) => {
      const limit = clampLimit(args.limit);
      const activeOnly = args.activeOnly ?? false;
      const query = tx.db.restaurantTables.query();
      const selectedQuery = activeOnly
        ? query.where((table) => table.active.eq(true))
        : query;
      const selected = await selectedQuery
        .orderBy((table) => table.number.asc())
        .take(limit);
      const tables = await Promise.all(
        selected.map(async (table) => {
          const order = await openOrderForTable(tx.db, table.id);
          return {
            id: table.id,
            number: table.number,
            seats: table.seats,
            active: table.active,
            occupied: order !== null,
            orderId: order?.id ?? null,
          };
        }),
      );
      return { tables };
    }),
});
