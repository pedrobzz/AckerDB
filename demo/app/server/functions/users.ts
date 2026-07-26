import { Err, Status } from "@ackerdb/core";
import { AckerDBError, v } from "@ackerdb/server";
import { mutation, query } from "@demo/ackerdb-codegen/server";
import { requireUser, staffAccess } from "../lib/access.ts";
import {
  openOrderForUser,
  orderView,
} from "../lib/domain/orders.ts";
import { userForIdentity } from "../lib/domain/guests.ts";
import { emailInput, guestNameInput } from "../lib/inputs.ts";

const guestAccess = (ctx: { auth: Parameters<typeof requireUser>[0] }) =>
  ctx.auth.kind === "user";

export const ensureCurrent = mutation({
  access: guestAccess,
  args: {},
  handler: async (ctx) => {
    const principal = requireUser(ctx.auth);
    const emailClaim = principal.claims.email;
    const nameClaim = principal.claims.name;
    if (typeof emailClaim !== "string" || typeof nameClaim !== "string") {
      throw new AckerDBError(
        "unauthenticated",
        "Guest credential is missing profile claims",
      );
    }
    const email = emailClaim.toLowerCase();
    const name = nameClaim;
    const now = Date.now();
    const byIdentity = await userForIdentity(ctx.db, principal.identity);
    if (byIdentity !== null) {
      if (byIdentity.email !== email) {
        return Err(
          "guest.identity-email-conflict",
          { email },
          Status.Conflict,
        );
      }
      if (byIdentity.name !== name)
        await ctx.db.users.patch(byIdentity.id, { name, updatedAt: now });
      return byIdentity.id;
    }
    const byEmail = await ctx.db.users
      .query()
      .where((user) => user.email.eq(email))
      .unique();
    if (byEmail !== null) {
      if (
        byEmail.identity !== null &&
        byEmail.identity !== principal.identity
      ) {
        return Err(
          "guest.email-taken",
          { email },
          Status.Conflict,
        );
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
    const users = await ctx.db.users.query().collect();
    return Promise.all(
      users.map(async (user) => {
        const [orders, activeOrder] = await Promise.all([
          ctx.db.orders
            .query()
            .where((order) => order.userId.eq(user.id))
            .orderBy((order) => order.openedAt.asc())
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
  args: { id: v.bigint() },
  errors: {
    "guest.not-found": {
      body: v.object({ id: v.bigint() }),
      status: Status.NotFound,
    },
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.users.get(args.id);
    if (user === null) {
      return Err("guest.not-found", { id: args.id }, Status.NotFound);
    }
    const orders = await ctx.db.orders
      .query()
      .where((order) => order.userId.eq(user.id))
      .orderBy((order) => order.openedAt.desc())
      .thenBy((order) => order.id.desc())
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
  args: { name: guestNameInput, email: emailInput },
  handler: async (ctx, args) => {
    const name = args.name;
    const email = args.email.toLowerCase();
    if (
      (await ctx.db.users.query().where((user) => user.email.eq(email)).unique()) !==
      null
    ) {
      return Err("guest.email-taken", { email }, Status.Conflict);
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
  args: { id: v.bigint(), name: guestNameInput, email: emailInput },
  handler: async (ctx, args) => {
    const user = await ctx.db.users.get(args.id);
    if (user === null) {
      return Err("guest.not-found", { id: args.id }, Status.NotFound);
    }
    const name = args.name;
    const email = args.email.toLowerCase();
    if (user.identity !== null && email !== user.email) {
      return Err(
        "guest.linked-email-immutable",
        { id: user.id },
        Status.Conflict,
      );
    }
    const owner = await ctx.db.users
      .query()
      .where((user) => user.email.eq(email))
      .unique();
    if (owner !== null && owner.id !== user.id) {
      return Err("guest.email-taken", { email }, Status.Conflict);
    }
    await ctx.db.users.patch(user.id, { name, email, updatedAt: Date.now() });
    return user.id;
  },
});
