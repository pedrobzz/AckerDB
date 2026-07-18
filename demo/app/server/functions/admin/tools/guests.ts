import { dbz } from "@dbzz/server";
import { clampLimit, DEFAULT_LIMIT, MAX_LIMIT } from "../../../lib/limits.ts";
import { admin } from "../mcp.ts";

/**
 * `get_guests` — the restaurant's guests (diners) and their contact details.
 * Reach for this to find a guest by name or email, or to resolve a guest's id
 * before looking up their orders with `get_orders`.
 */
export const getGuests = admin.tool({
  name: "get_guests",
  title: "Get guests",
  description:
    "List guests (diners) with their name and email, optionally narrowed by a " +
    "case-insensitive substring of the email and/or name. Use it to find a " +
    "guest, or to resolve a guest's id before calling get_orders.",
  access: { anyOf: ["read"] },
  annotations: { readOnlyHint: true },
  args: {
    email: dbz
      .nullable(dbz.string())
      .describe("Case-insensitive substring to match against a guest's email."),
    name: dbz
      .nullable(dbz.string())
      .describe("Case-insensitive substring to match against a guest's name."),
    limit: dbz
      .nullable(dbz.number())
      .describe(`Maximum guests to return (1-${MAX_LIMIT}, default ${DEFAULT_LIMIT}).`),
  },
  output: dbz.object({
    guests: dbz.array(
      dbz.object({
        id: dbz.bigint(),
        name: dbz.string(),
        email: dbz.string(),
        createdAt: dbz.number(),
        updatedAt: dbz.number(),
      }),
    ),
  }),
  handler: (ctx, args) =>
    ctx.tx(async (tx) => {
      const limit = clampLimit(args.limit);
      const email = args.email === null ? null : args.email.trim().toLowerCase();
      const name = args.name === null ? null : args.name.trim().toLowerCase();
      const rows = await tx.db.users.scan().order("asc").collect();
      const guests = rows
        .filter(
          (user) =>
            (email === null || user.email.toLowerCase().includes(email)) &&
            (name === null || user.name.toLowerCase().includes(name)),
        )
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, limit)
        .map((user) => ({
          id: user.id,
          name: user.name,
          email: user.email,
          createdAt: user.createdAt,
          updatedAt: user.updatedAt,
        }));
      return { guests };
    }),
});
