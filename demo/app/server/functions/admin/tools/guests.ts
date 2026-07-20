import { v } from "@dbzz/server";
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
    email: v
      .string()
      .optional()
      .describe("Case-insensitive substring to match against a guest's email."),
    name: v
      .string()
      .optional()
      .describe("Case-insensitive substring to match against a guest's name."),
    limit: v
      .int()
      .optional()
      .describe(`Maximum guests to return (1-${MAX_LIMIT}, default ${DEFAULT_LIMIT}).`),
  },
  output: v.object({
    guests: v.array(
      v.object({
        id: v.bigint(),
        name: v.string(),
        email: v.string(),
        createdAt: v.int(),
        updatedAt: v.int(),
      }),
    ),
  }),
  handler: (ctx, args) =>
    ctx.tx(async (tx) => {
      const limit = clampLimit(args.limit);
      const email = args.email?.trim().toLowerCase() ?? null;
      const name = args.name?.trim().toLowerCase() ?? null;
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
