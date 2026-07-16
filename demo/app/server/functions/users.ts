import { DbzzError, dbz } from "@dbzz/server";
import { mutation, query } from "@demo/dbzz-codegen/server";
import { isStaff, requireUser } from "../lib/access.ts";
import {
  cleanName,
  conflict,
  normalizeEmail,
  notFound,
  openOrderForUser,
  orderView,
  userForIdentity,
} from "../lib/domain.ts";

const guestAccess = (ctx: { auth: Parameters<typeof requireUser>[0] }) =>
  ctx.auth.kind === "user";
const staffAccess = (ctx: { auth: Parameters<typeof isStaff>[0] }) =>
  isStaff(ctx.auth);

export const ensureCurrent = mutation({
  access: guestAccess,
  args: {},
  handler: async (ctx) => {
    const principal = requireUser(ctx.auth);
    const emailClaim = principal.claims.email;
    const nameClaim = principal.claims.name;
    if (typeof emailClaim !== "string" || typeof nameClaim !== "string") {
      throw new DbzzError(
        "unauthenticated",
        "Guest credential is missing profile claims",
      );
    }
    const email = normalizeEmail(emailClaim);
    const name = cleanName(nameClaim);
    const now = Date.now();
    const byIdentity = await userForIdentity(ctx.db, principal.identity);
    if (byIdentity !== null) {
      if (byIdentity.email !== email)
        conflict("This identity is already linked to another email");
      if (byIdentity.name !== name)
        await ctx.db.users.patch(byIdentity.id, { name, updatedAt: now });
      return byIdentity.id;
    }
    const byEmail = await ctx.db.users
      .byEmail((q) => q.eq("email", email))
      .unique();
    if (byEmail !== null) {
      if (
        byEmail.identity !== null &&
        byEmail.identity !== principal.identity
      ) {
        conflict("This email already belongs to another guest");
      }
      await ctx.db.users.patch(byEmail.id, {
        identity: principal.identity,
        name,
        updatedAt: now,
      });
      return byEmail.id;
    }
    return ctx.db.users.insert({
      identity: principal.identity,
      email,
      name,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const current = query({
  access: guestAccess,
  args: {},
  handler: async (ctx) => {
    const principal = requireUser(ctx.auth);
    const user = await userForIdentity(ctx.db, principal.identity);
    if (user === null) return null;
    const openOrder = await openOrderForUser(ctx.db, user.id);
    return {
      ...user,
      activeOrder:
        openOrder === null ? null : await orderView(ctx.db, openOrder),
    };
  },
});

export const list = query({
  access: staffAccess,
  args: {},
  handler: async (ctx) => {
    const users = await ctx.db.users.scan().order("asc").collect();
    return Promise.all(
      users.map(async (user) => {
        const [orders, activeOrder] = await Promise.all([
          ctx.db.orders
            .byUserOpenedAt((q) => q.eq("userId", user.id))
            .collect(),
          openOrderForUser(ctx.db, user.id),
        ]);
        return {
          ...user,
          orderCount: orders.length,
          lifetimeCents: orders
            .filter((order) => order.status === "PAID")
            .reduce((sum, order) => sum + order.totalCents, 0),
          activeOrderId: activeOrder?.id ?? null,
        };
      }),
    );
  },
});

export const detail = query({
  access: staffAccess,
  args: { id: dbz.bigint() },
  handler: async (ctx, args) => {
    const user =
      (await ctx.db.users.get(args.id)) ?? notFound("Guest not found");
    const orders = await ctx.db.orders
      .byUserOpenedAt((q) => q.eq("userId", user.id))
      .order("desc")
      .collect();
    return {
      ...user,
      orders: await Promise.all(
        orders.map((order) => orderView(ctx.db, order)),
      ),
    };
  },
});

export const create = mutation({
  access: staffAccess,
  args: { name: dbz.string(), email: dbz.string() },
  handler: async (ctx, args) => {
    const name = cleanName(args.name);
    const email = normalizeEmail(args.email);
    if (
      (await ctx.db.users.byEmail((q) => q.eq("email", email)).unique()) !==
      null
    ) {
      conflict("A guest with this email already exists");
    }
    const now = Date.now();
    return ctx.db.users.insert({
      name,
      email,
      identity: null,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const update = mutation({
  access: staffAccess,
  args: { id: dbz.bigint(), name: dbz.string(), email: dbz.string() },
  handler: async (ctx, args) => {
    const user =
      (await ctx.db.users.get(args.id)) ?? notFound("Guest not found");
    const name = cleanName(args.name);
    const email = normalizeEmail(args.email);
    if (user.identity !== null && email !== user.email) {
      conflict("A linked guest's login email cannot be changed");
    }
    const owner = await ctx.db.users
      .byEmail((q) => q.eq("email", email))
      .unique();
    if (owner !== null && owner.id !== user.id)
      conflict("A guest with this email already exists");
    await ctx.db.users.patch(user.id, { name, email, updatedAt: Date.now() });
    return user.id;
  },
});
