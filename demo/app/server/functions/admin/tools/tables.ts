import { dbz } from "@dbzz/server";
import { openOrderForTable } from "../../../lib/domain.ts";
import { clampLimit, DEFAULT_LIMIT, MAX_LIMIT } from "../../../lib/limits.ts";
import { admin } from "../mcp.ts";

/**
 * `get_tables` — the first entity query tool. Returns the restaurant's tables
 * with their occupancy state derived from the open-order index, so an agent can
 * answer "which tables are free?" without composing a pipeline.
 */
export const getTables = admin.tool({
  name: "get_tables",
  title: "Get tables",
  description:
    "List the restaurant's tables and whether each is occupied by an open " +
    "order. Optionally restrict to active tables and cap the number returned.",
  access: { anyOf: ["read"] },
  annotations: { readOnlyHint: true },
  args: {
    activeOnly: dbz
      .nullable(dbz.boolean())
      .describe("When true, exclude retired (inactive) tables."),
    limit: dbz
      .nullable(dbz.number())
      .describe(`Maximum tables to return (1-${MAX_LIMIT}, default ${DEFAULT_LIMIT}).`),
  },
  output: dbz.object({
    tables: dbz.array(
      dbz.object({
        id: dbz.bigint(),
        number: dbz.number(),
        seats: dbz.number(),
        active: dbz.boolean(),
        occupied: dbz.boolean(),
        orderId: dbz.nullable(dbz.bigint()),
      }),
    ),
  }),
  handler: (ctx, args) =>
    ctx.tx(async (tx) => {
      const limit = clampLimit(args.limit);
      const activeOnly = args.activeOnly ?? false;
      const rows = await tx.db.restaurantTables
        .byNumber((q) => q)
        .order("asc")
        .collect();
      const selected = rows
        .filter((table) => (activeOnly ? table.active : true))
        .slice(0, limit);
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
