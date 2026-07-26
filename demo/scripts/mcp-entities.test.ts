import { expect, test } from "bun:test";
import { api } from "@demo/ackerdb-codegen/api";
import {
  issueToken,
  listedToolNames,
  structuredOf,
  withBackend,
} from "./mcp-harness.ts";
import { expectOk } from "./result.ts";

// Each test boots the real backend once (withBackend) against the seeded world
// from functions/setup.ts: 4 menu categories, 6 menu items, 12 tables, 6 guests
// and 8 orders (6 OPEN, 1 PAID, 1 CANCELLED) totalling 18 order items. Discovery
// is asserted with containment only — parallel tickets register more read tools.

test("get_menu_categories lists the menu's sections in menu order", async () => {
  await withBackend(async (backend) => {
    const staff = await backend.staff();
    const read = await issueToken(staff, "Reader", ["read"]);

    expect(
      await listedToolNames(await backend.rpc("tools/list", {}, read.token)),
    ).toContain("get_menu_categories");

    interface CategoryRow {
      readonly id: string;
      readonly name: string;
      readonly sortOrder: number;
      readonly active: boolean;
    }
    const categoriesOf = (args: Record<string, unknown>) =>
      backend
        .call("get_menu_categories", args, read.token)
        .then((body) => structuredOf<{ categories: CategoryRow[] }>(body).categories);

    // Seeded categories arrive in menu (sortOrder) order, all active, ids as strings.
    const all = await categoriesOf({});
    expect(all.map((c) => c.name)).toEqual([
      "Small Plates",
      "From the Fire",
      "Desserts",
      "Drinks",
    ]);
    expect(all.every((c) => c.active)).toBe(true);
    expect(all.every((c) => typeof c.id === "string")).toBe(true);

    // The active-only filter keeps the (all-active) seeded categories.
    expect(await categoriesOf({ activeOnly: true })).toHaveLength(4);

    // limit caps the result to the first sections.
    expect((await categoriesOf({ limit: 2 })).map((c) => c.name)).toEqual([
      "Small Plates",
      "From the Fire",
    ]);

    // Malformed input is a safe MCP error, not a crash.
    const bad = await backend.call("get_menu_categories", { limit: "lots" }, read.token);
    expect(bad.result?.isError).toBe(true);
    expect(bad.result?.structuredContent).toBeUndefined();
  });
});

test("get_menu_items exposes prices and category / active filters", async () => {
  await withBackend(async (backend) => {
    const staff = await backend.staff();
    const read = await issueToken(staff, "Reader", ["read"]);

    expect(
      await listedToolNames(await backend.rpc("tools/list", {}, read.token)),
    ).toContain("get_menu_items");

    interface ItemRow {
      readonly id: string;
      readonly categoryId: string;
      readonly name: string;
      readonly priceCents: number;
      readonly active: boolean;
    }
    const itemsOf = (args: Record<string, unknown>) =>
      backend
        .call("get_menu_items", args, read.token)
        .then((body) => structuredOf<{ items: ItemRow[] }>(body).items);

    // The full menu is six seeded items, priced in cents, ids as strings.
    const all = await itemsOf({});
    expect(all).toHaveLength(6);
    expect(all.find((i) => i.name === "Grilled Sea Bass")?.priceCents).toBe(3400);
    expect(all.every((i) => typeof i.id === "string")).toBe(true);

    // Resolve a category via get_menu_categories, then filter items down to it.
    const categories = structuredOf<{ categories: Array<{ id: string; name: string }> }>(
      await backend.call("get_menu_categories", {}, read.token),
    ).categories;
    const smallPlates = categories.find((c) => c.name === "Small Plates")!;
    const inCategory = await itemsOf({ categoryId: smallPlates.id });
    expect(inCategory.map((i) => i.name)).toEqual([
      "Charred Tomatoes",
      "Rosemary Focaccia",
    ]);
    expect(inCategory.every((i) => i.categoryId === smallPlates.id)).toBe(true);

    // limit caps the result.
    expect(await itemsOf({ limit: 2 })).toHaveLength(2);

    // Retiring an item lets active-only exclude it, while the default keeps it.
    const catalog = expectOk(await staff.query(api.menu.catalog, {}));
    const focaccia = catalog
      .flatMap((c) => c.items)
      .find((i) => i.name === "Rosemary Focaccia")!;
    expectOk(
      await staff.mutation(api.menu.updateItem, {
        id: focaccia.id,
        categoryId: focaccia.categoryId,
        name: focaccia.name,
        description: focaccia.description,
        image: focaccia.image,
        priceCents: focaccia.priceCents,
        sortOrder: focaccia.sortOrder,
        active: false,
      }),
    );
    const activeItems = await itemsOf({ activeOnly: true });
    expect(activeItems.some((i) => i.name === "Rosemary Focaccia")).toBe(false);
    expect(activeItems).toHaveLength(5);
    expect((await itemsOf({})).find((i) => i.name === "Rosemary Focaccia")?.active).toBe(
      false,
    );

    const bad = await backend.call("get_menu_items", { limit: "lots" }, read.token);
    expect(bad.result?.isError).toBe(true);
  });
});

test("get_orders filters by status, table, guest and time window, newest first", async () => {
  await withBackend(async (backend) => {
    const staff = await backend.staff();
    const read = await issueToken(staff, "Reader", ["read"]);

    expect(
      await listedToolNames(await backend.rpc("tools/list", {}, read.token)),
    ).toContain("get_orders");

    interface OrderRow {
      readonly id: string;
      readonly userId: string;
      readonly tableId: string;
      readonly status: string;
      readonly totalCents: number;
      readonly openedAt: number;
      readonly closedAt: number | null;
    }
    const ordersOf = (args: Record<string, unknown>) =>
      backend
        .call("get_orders", args, read.token)
        .then((body) => structuredOf<{ orders: OrderRow[] }>(body).orders);

    // All eight seeded orders, newest first (non-increasing openedAt), ids as strings.
    const all = await ordersOf({});
    expect(all).toHaveLength(8);
    expect(all.every((o) => typeof o.id === "string")).toBe(true);
    for (let i = 1; i < all.length; i++) {
      expect(all[i - 1].openedAt >= all[i].openedAt).toBe(true);
    }

    // Status filter: six open, one paid (total in cents, closed), one cancelled.
    expect(await ordersOf({ status: "OPEN" })).toHaveLength(6);
    const paid = await ordersOf({ status: "PAID" });
    expect(paid).toHaveLength(1);
    expect(paid[0].totalCents).toBe(8600);
    expect(paid[0].closedAt).not.toBeNull();
    expect(await ordersOf({ status: "CANCELLED" })).toHaveLength(1);

    // Table filter: the newest order's table holds exactly that one order.
    const newestTable = all[0].tableId;
    const byTable = await ordersOf({ tableId: newestTable });
    expect(byTable).toHaveLength(1);
    expect(byTable.every((o) => o.tableId === newestTable)).toBe(true);

    // Guest filter: Clara has two orders (one open, one paid).
    const guests = structuredOf<{ guests: Array<{ id: string; name: string }> }>(
      await backend.call("get_guests", { name: "Clara" }, read.token),
    ).guests;
    const clara = guests.find((g) => g.name.includes("Clara"))!;
    expect(await ordersOf({ userId: clara.id })).toHaveLength(2);

    // Time window: only the two orders opened more than 80 minutes ago (the closed ones).
    const older = await ordersOf({ openedBefore: Date.now() - 80 * 60_000 });
    expect(older).toHaveLength(2);
    expect(older.every((o) => o.status !== "OPEN")).toBe(true);

    // limit caps the result to the two newest.
    expect(await ordersOf({ limit: 2 })).toHaveLength(2);

    const bad = await backend.call("get_orders", { limit: "lots" }, read.token);
    expect(bad.result?.isError).toBe(true);
  });
});

test("get_order_items reads one order and sweeps by kitchen status", async () => {
  await withBackend(async (backend) => {
    const staff = await backend.staff();
    const read = await issueToken(staff, "Reader", ["read"]);

    expect(
      await listedToolNames(await backend.rpc("tools/list", {}, read.token)),
    ).toContain("get_order_items");

    interface ItemRow {
      readonly id: string;
      readonly orderId: string;
      readonly status: string;
      readonly orderedAt: number;
      readonly statusChangedAt: number;
    }
    const itemsOf = (args: Record<string, unknown>) =>
      backend
        .call("get_order_items", args, read.token)
        .then((body) => structuredOf<{ items: ItemRow[] }>(body).items);

    // Status sweeps across the whole floor match the seeded distribution.
    expect(await itemsOf({ status: ["ORDERED"] })).toHaveLength(4);
    expect(await itemsOf({ status: ["PREPARING"] })).toHaveLength(5);
    expect(await itemsOf({ status: ["ORDERED", "PREPARING"] })).toHaveLength(9);

    // One order's items: the paid order has three served lines carrying timestamps.
    const paidOrder = structuredOf<{ orders: Array<{ id: string }> }>(
      await backend.call("get_orders", { status: "PAID" }, read.token),
    ).orders[0];
    const lines = await itemsOf({ orderId: paidOrder.id });
    expect(lines).toHaveLength(3);
    expect(lines.every((l) => l.orderId === paidOrder.id)).toBe(true);
    expect(lines.every((l) => l.status === "SERVED")).toBe(true);
    expect(
      lines.every(
        (l) => typeof l.orderedAt === "number" && typeof l.statusChangedAt === "number",
      ),
    ).toBe(true);
    expect(lines.every((l) => typeof l.id === "string")).toBe(true);

    // limit caps the sweep.
    expect(await itemsOf({ limit: 5 })).toHaveLength(5);

    const bad = await backend.call("get_order_items", { limit: "lots" }, read.token);
    expect(bad.result?.isError).toBe(true);
  });
});

test("get_guests finds diners by name or email substring", async () => {
  await withBackend(async (backend) => {
    const staff = await backend.staff();
    const read = await issueToken(staff, "Reader", ["read"]);

    expect(
      await listedToolNames(await backend.rpc("tools/list", {}, read.token)),
    ).toContain("get_guests");

    interface GuestRow {
      readonly id: string;
      readonly name: string;
      readonly email: string;
      readonly createdAt: number;
      readonly updatedAt: number;
    }
    const guestsOf = (args: Record<string, unknown>) =>
      backend
        .call("get_guests", args, read.token)
        .then((body) => structuredOf<{ guests: GuestRow[] }>(body).guests);

    // All six seeded guests, ids as strings, no internal identity field leaked.
    const all = await guestsOf({});
    expect(all).toHaveLength(6);
    expect(all.every((g) => typeof g.id === "string")).toBe(true);
    expect(all.every((g) => "email" in g && !("identity" in g))).toBe(true);

    // Case-insensitive name substring.
    expect((await guestsOf({ name: "maya" })).map((g) => g.name)).toEqual(["Maya Chen"]);

    // Case-insensitive email substring.
    expect((await guestsOf({ email: "CLARA@EXAMPLE.COM" })).map((g) => g.email)).toEqual([
      "clara@example.com",
    ]);

    // limit caps the result.
    expect(await guestsOf({ limit: 2 })).toHaveLength(2);

    const bad = await backend.call("get_guests", { limit: "lots" }, read.token);
    expect(bad.result?.isError).toBe(true);
  });
});
