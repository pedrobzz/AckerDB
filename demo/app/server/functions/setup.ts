import { mutation } from "@demo/dbzz-codegen/server";
import { staffAccess } from "../lib/access.ts";
import { scheduleReminder } from "../lib/domain/order-workflow.ts";
import type { ItemStatus } from "@demo/dbzz-codegen/types";

const SEED_KEY = "restaurant-v1";

export const initialize = mutation({
  access: staffAccess,
  args: {},
  handler: async (ctx) => {
    const cached = await ctx.cache.setupState.get(SEED_KEY);
    if (cached !== undefined)
      return { created: false, completedAt: cached.completedAt };

    const existing = await ctx.db.setupState
      .query()
      .where((state) => state.key.eq(SEED_KEY))
      .unique();
    if (existing !== null) {
      await ctx.cache.setupState.set(SEED_KEY, {
        completedAt: existing.completedAt,
      });
      return { created: false, completedAt: existing.completedAt };
    }

    const now = Date.now();
    const categoryIds = new Map<string, bigint>();
    for (const [sortOrder, name] of [
      "Small Plates",
      "From the Fire",
      "Desserts",
      "Drinks",
    ].entries()) {
      categoryIds.set(
        name,
        await ctx.db.menuCategories.insert({
          name,
          sortOrder,
          active: true,
          createdAt: now,
          updatedAt: now,
        }),
      );
    }

    const menu = [
      [
        "tomatoes",
        "Small Plates",
        "Charred Tomatoes",
        "Whipped feta, basil oil, sourdough crunch",
        "menu/charred-tomatoes.png",
        1600,
      ],
      [
        "focaccia",
        "Small Plates",
        "Rosemary Focaccia",
        "Sea salt, cultured butter, smoked honey",
        "menu/rosemary-focaccia.png",
        1100,
      ],
      [
        "seabass",
        "From the Fire",
        "Grilled Sea Bass",
        "Spring peas, asparagus, lemon beurre blanc",
        "menu/grilled-sea-bass.png",
        3400,
      ],
      [
        "rigatoni",
        "From the Fire",
        "Truffle Rigatoni",
        "Wild mushrooms, pecorino, black truffle",
        "menu/truffle-rigatoni.png",
        2800,
      ],
      [
        "citrus",
        "Desserts",
        "Pistachio Citrus",
        "Olive oil cake, orange curd, pistachio cream",
        "menu/pistachio-citrus.png",
        1300,
      ],
      [
        "spritz",
        "Drinks",
        "Blood Orange Spritz",
        "Blood orange, rosemary, sparkling water",
        "menu/blood-orange-spritz.png",
        1200,
      ],
    ] as const;
    const menuIds = new Map<string, bigint>();
    const menuRows = new Map<
      string,
      { id: bigint; name: string; image: string; priceCents: number }
    >();
    for (const [
      sortOrder,
      [key, category, name, description, image, priceCents],
    ] of menu.entries()) {
      const id = await ctx.db.menuItems.insert({
        categoryId: categoryIds.get(category)!,
        name,
        description,
        image,
        priceCents,
        sortOrder,
        active: true,
        createdAt: now,
        updatedAt: now,
      });
      menuIds.set(key, id);
      menuRows.set(key, { id, name, image, priceCents });
    }

    const tableIds = new Map<number, bigint>();
    const seats = [2, 4, 4, 6, 2, 4, 4, 8, 2, 4, 6, 4];
    for (const [index, seatCount] of seats.entries()) {
      const number = index + 1;
      tableIds.set(
        number,
        await ctx.db.restaurantTables.insert({
          number,
          seats: seatCount!,
          active: true,
          createdAt: now,
          updatedAt: now,
        }),
      );
    }

    const userIds = new Map<string, bigint>();
    for (const [name, email] of [
      ["Clara Mendes", "clara@example.com"],
      ["Noah Williams", "noah@example.com"],
      ["Maya Chen", "maya@example.com"],
      ["Luca Romano", "luca@example.com"],
      ["Sofia Alvarez", "sofia@example.com"],
      ["Ethan Brooks", "ethan@example.com"],
    ]) {
      userIds.set(
        email!,
        await ctx.db.users.insert({
          identity: null,
          name: name!,
          email: email!,
          createdAt: now,
          updatedAt: now,
        }),
      );
    }

    interface SeedLine {
      key: string;
      quantity: number;
      status: ItemStatus;
      note?: string;
    }
    const insertOrder = async (input: {
      email: string;
      table: number;
      status: "OPEN" | "PAID" | "CANCELLED";
      openedAt: number;
      lines: SeedLine[];
    }) => {
      const totalCents = input.lines.reduce((sum, line) => {
        const item = menuRows.get(line.key)!;
        return line.status === "CANCELLED"
          ? sum
          : sum + item.priceCents * line.quantity;
      }, 0);
      const open = input.status === "OPEN";
      const userId = userIds.get(input.email)!;
      const tableId = tableIds.get(input.table)!;
      const orderId = await ctx.db.orders.insert({
        userId,
        tableId,
        openUserId: open ? userId : null,
        openTableId: open ? tableId : null,
        status: input.status,
        totalCents: input.status === "CANCELLED" ? 0 : totalCents,
        openedAt: input.openedAt,
        closedAt: open ? null : input.openedAt + 48 * 60_000,
      });
      for (const [index, line] of input.lines.entries()) {
        const item = menuRows.get(line.key)!;
        const statusChangedAt = input.openedAt + index * 60_000;
        const itemId = await ctx.db.orderItems.insert({
          orderId,
          menuItemId: menuIds.get(line.key)!,
          name: item.name,
          image: item.image,
          unitPriceCents: item.priceCents,
          quantity: line.quantity,
          note: line.note ?? null,
          status: line.status,
          orderedAt: input.openedAt,
          statusChangedAt,
        });
        if (open) await scheduleReminder(ctx.db, itemId, line.status, now);
      }
      return orderId;
    };

    await insertOrder({
      email: "clara@example.com",
      table: 7,
      status: "OPEN",
      openedAt: now - 18 * 60_000,
      lines: [
        { key: "tomatoes", quantity: 1, status: "SERVED" },
        { key: "seabass", quantity: 1, status: "PREPARING" },
        { key: "spritz", quantity: 2, status: "PREPARED", note: "Less ice" },
      ],
    });
    await insertOrder({
      email: "maya@example.com",
      table: 4,
      status: "OPEN",
      openedAt: now - 24 * 60_000,
      lines: [
        { key: "rigatoni", quantity: 3, status: "ORDERED" },
        { key: "seabass", quantity: 1, status: "PREPARED" },
      ],
    });
    await insertOrder({
      email: "noah@example.com",
      table: 2,
      status: "OPEN",
      openedAt: now - 32 * 60_000,
      lines: [
        { key: "spritz", quantity: 3, status: "SERVED" },
        { key: "tomatoes", quantity: 1, status: "PREPARING" },
      ],
    });
    await insertOrder({
      email: "luca@example.com",
      table: 6,
      status: "OPEN",
      openedAt: now - 46 * 60_000,
      lines: [
        { key: "tomatoes", quantity: 4, status: "ORDERED" },
        { key: "spritz", quantity: 1, status: "PREPARING" },
      ],
    });
    await insertOrder({
      email: "sofia@example.com",
      table: 8,
      status: "OPEN",
      openedAt: now - 54 * 60_000,
      lines: [
        { key: "seabass", quantity: 4, status: "PREPARING" },
        { key: "rigatoni", quantity: 1, status: "ORDERED" },
      ],
    });
    await insertOrder({
      email: "ethan@example.com",
      table: 11,
      status: "OPEN",
      openedAt: now - 61 * 60_000,
      lines: [
        { key: "seabass", quantity: 1, status: "PREPARED" },
        { key: "rigatoni", quantity: 1, status: "PREPARING" },
        { key: "citrus", quantity: 1, status: "ORDERED" },
      ],
    });
    await insertOrder({
      email: "clara@example.com",
      table: 3,
      status: "PAID",
      openedAt: now - 90 * 60_000,
      lines: [
        { key: "seabass", quantity: 1, status: "SERVED" },
        { key: "rigatoni", quantity: 1, status: "SERVED" },
        { key: "spritz", quantity: 2, status: "SERVED" },
      ],
    });
    await insertOrder({
      email: "maya@example.com",
      table: 9,
      status: "CANCELLED",
      openedAt: now - 112 * 60_000,
      lines: [{ key: "citrus", quantity: 1, status: "CANCELLED" }],
    });

    await ctx.db.setupState.insert({ key: SEED_KEY, completedAt: now });
    await ctx.cache.setupState.set(SEED_KEY, { completedAt: now });
    return { created: true, completedAt: now };
  },
});
