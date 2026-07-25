import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DbzzClient, DbzzClientError, type DbzzLiveEvent } from "@dbzz/client";
import { loadConfig, startApp, type AppConfig, type RunningApp } from "@dbzz/cli";
import { api } from "@demo/dbzz-codegen/api";
import type {
  Identity,
  OrderEvent,
  StaffEvent,
} from "@demo/dbzz-codegen/types";
import { expectErrorCode, expectOk } from "./result.ts";

const SERVER_DIR = fileURLToPath(new URL("../app/server", import.meta.url));
const STAFF_TOKEN =
  process.env.DBZZ_DEMO_STAFF_TOKEN ?? "savoria-demo-staff";
const REMINDER_DELAY_MS = 2 * 60_000;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function within<T>(
  work: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

class BackendHarness {
  readonly directory = mkdtempSync(join(tmpdir(), "dbzz-demo-backend-"));
  readonly config: AppConfig;
  private app: RunningApp | undefined;
  private readonly clients = new Set<DbzzClient>();

  private constructor() {
    this.config = {
      ...loadConfig(SERVER_DIR, {
        ...process.env,
        DBZZ_DURABILITY: "balanced",
        DBZZ_TELEMETRY: "disabled",
      }),
      dbDir: join(this.directory, ".dbzz"),
      port: 0,
    };
  }

  static async start(): Promise<BackendHarness> {
    const harness = new BackendHarness();
    harness.app = await startApp(harness.config);
    return harness;
  }

  get url(): string {
    if (this.app === undefined) throw new Error("backend is not running");
    return `http://127.0.0.1:${this.app.server.port}`;
  }

  client(token?: string): DbzzClient {
    const client = new DbzzClient({
      url: this.url,
      credential:
        token === undefined
          ? { kind: "anonymous" }
          : { kind: "bearer", token },
    });
    this.clients.add(client);
    return client;
  }

  async initialize(): Promise<DbzzClient> {
    const staff = this.client(STAFF_TOKEN);
    expectOk(await staff.mutation(api.setup.initialize, {}));
    return staff;
  }

  async guest(
    email: string,
    name = "Backend Guest",
  ): Promise<{
    client: DbzzClient;
    identity: Identity;
    token: string;
    userId: bigint;
  }> {
    const anonymous = this.client();
    const login = expectOk(
      await anonymous.procedure(api.auth.login, { name, email }),
    );
    const client = this.client(login.token);
    const userId = expectOk(
      await client.mutation(api.users.ensureCurrent, {}),
    );
    expectOk(await client.query(api.users.current, {}));
    const authentication = client.currentAuthentication;
    if (authentication?.principal !== "user")
      throw new Error("guest did not establish a durable Identity");
    return {
      client,
      identity: authentication.identity,
      token: login.token,
      userId,
    };
  }

  async restart(): Promise<void> {
    this.closeClients();
    await this.app?.drain();
    this.app = await startApp(this.config);
  }

  runScheduled(now?: number): Promise<number> {
    if (this.app === undefined) throw new Error("backend is not running");
    return this.app.runtime.runScheduled(now);
  }

  async dispose(): Promise<void> {
    this.closeClients();
    try {
      await this.app?.drain();
    } finally {
      rmSync(this.directory, { recursive: true, force: true });
    }
  }

  private closeClients(): void {
    for (const client of this.clients) client.close();
    this.clients.clear();
  }
}

async function withBackend(
  work: (backend: BackendHarness) => Promise<void>,
): Promise<void> {
  const backend = await BackendHarness.start();
  try {
    await work(backend);
  } finally {
    await backend.dispose();
  }
}

async function tableFor(
  staff: DbzzClient,
  number: number,
): Promise<bigint> {
  return expectOk(
    await staff.mutation(api.tables.create, { number, seats: 4 }),
  );
}

async function firstMenuItem(client: DbzzClient) {
  const catalog = expectOk(await client.query(api.menu.catalog, {}));
  const item = catalog.flatMap((category) => category.items)[0];
  if (item === undefined) throw new Error("seed menu is empty");
  return item;
}

test("credentials map to one durable Identity and policies separate guests from staff", async () => {
  await withBackend(async (backend) => {
    const anonymous = backend.client();
    await expectErrorCode(
      anonymous.query(api.dashboard.overview, {}),
      "unauthenticated",
    );

    const staff = await backend.initialize();
    expect(
      expectOk(await staff.query(api.dashboard.overview, {})).tableCount,
    ).toBe(12);

    const guest = await backend.guest("Identity.Guest@Example.com", "Identity Guest");
    await expectErrorCode(
      guest.client.query(api.dashboard.overview, {}),
      "unauthorized",
    );
    const before = expectOk(
      await guest.client.query(api.users.current, {}),
    );
    expect(before?.id).toBe(guest.userId);
    const identity = guest.identity;

    await backend.restart();

    const afterRestart = backend.client(guest.token);
    const after = expectOk(
      await afterRestart.query(api.users.current, {}),
    );
    expect(after?.id).toBe(guest.userId);
    expect(afterRestart.currentAuthentication).toMatchObject({
      principal: "user",
      identity,
    });

    const relogin = await backend.guest(
      "identity.guest@example.com",
      "Identity Guest Updated",
    );
    expect(relogin.userId).toBe(guest.userId);
    expect(relogin.identity).toBe(identity);
    expect(
      expectOk(
        await relogin.client.query(api.users.current, {}),
      )?.name,
    ).toBe("Identity Guest Updated");
  });
});

test("concurrent seating admits exactly one guest and releases the table on close", async () => {
  await withBackend(async (backend) => {
    const staff = await backend.initialize();
    const tableId = await tableFor(staff, 901);
    const first = await backend.guest("seat-one@example.com", "Seat One");
    const second = await backend.guest("seat-two@example.com", "Seat Two");

    const attempts = await Promise.all([
      first.client.mutation(api.orders.sit, { tableId }),
      second.client.mutation(api.orders.sit, { tableId }),
    ]);
    const accepted = attempts.filter((attempt) => attempt.ok);
    const refused = attempts.filter((attempt) => !attempt.ok);
    expect(accepted).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.error).toMatchObject({
      kind: "application",
      code: "table.unavailable",
      status: 409,
      body: { tableId },
    });
    const orderId = accepted[0]!.data;

    const occupied = expectOk(
      await staff.query(api.tables.list, {}),
    ).find(
      (table) => table.id === tableId,
    );
    expect(occupied?.orderId).toBe(orderId);
    expectOk(await staff.mutation(api.orders.cancel, { orderId }));
    const released = expectOk(
      await staff.query(api.tables.list, {}),
    ).find(
      (table) => table.id === tableId,
    );
    expect(released?.orderId).toBeNull();
  });
});

test("line snapshots survive menu edits and only legal kitchen transitions can be paid", async () => {
  await withBackend(async (backend) => {
    const staff = await backend.initialize();
    const guest = await backend.guest("snapshot@example.com", "Snapshot Guest");
    const tableId = await tableFor(staff, 902);
    const item = await firstMenuItem(guest.client);
    const orderId = expectOk(
      await guest.client.mutation(api.orders.sit, { tableId }),
    );
    const [orderItemId] = expectOk(
      await guest.client.mutation(api.orders.addItems, {
        orderId,
        items: [{ menuItemId: item.id, quantity: 2, note: "No garnish" }],
      }),
    );
    if (orderItemId === undefined) throw new Error("order item was not created");

    expectOk(
      await staff.mutation(api.menu.updateItem, {
        id: item.id,
        categoryId: item.categoryId,
        name: `${item.name} Revised`,
        description: item.description,
        image: item.image,
        priceCents: item.priceCents + 777,
        sortOrder: item.sortOrder,
        active: true,
      }),
    );
    const snapshot = expectOk(
      await guest.client.query(api.orders.current, {}),
    );
    expect(snapshot?.items[0]).toMatchObject({
      id: orderItemId,
      name: item.name,
      unitPriceCents: item.priceCents,
      quantity: 2,
      note: "No garnish",
    });
    expect(snapshot?.totalCents).toBe(item.priceCents * 2);
    await expectErrorCode(
      guest.client.mutation(api.orders.pay, { orderId }),
      "order.not-payable",
    );

    expect(
      expectOk(
        await staff.mutation(api.kitchen.advance, { orderItemId }),
      ),
    ).toBe("PREPARING");
    await expectErrorCode(
      guest.client.mutation(api.orders.cancelItem, { orderId, orderItemId }),
      "order-item.not-cancellable",
    );
    await expectErrorCode(
      staff.mutation(api.kitchen.cancel, { orderItemId }),
      "order-item.not-cancellable",
    );
    expect(
      expectOk(
        await staff.mutation(api.kitchen.advance, { orderItemId }),
      ),
    ).toBe("PREPARED");
    expect(
      expectOk(
        await staff.mutation(api.kitchen.advance, { orderItemId }),
      ),
    ).toBe("SERVED");
    await expectErrorCode(
      staff.mutation(api.kitchen.advance, { orderItemId }),
      "order-item.final",
    );

    expect(
      expectOk(
        await guest.client.mutation(api.orders.pay, { orderId }),
      ),
    ).toEqual({ orderId, totalCents: item.priceCents * 2 });
    expect(
      expectOk(
        await guest.client.query(api.orders.history, {}),
      ).closed[0],
    ).toMatchObject({
      id: orderId,
      status: "PAID",
      totalCents: item.priceCents * 2,
    });
    expect(
      expectOk(
        await staff.query(api.tables.list, {}),
      ).find(
        (table) => table.id === tableId,
      )?.orderId,
    ).toBeNull();
  });
});

test("aggregate cancellation preserves line history while guest cancellation closes all-cancelled orders", async () => {
  await withBackend(async (backend) => {
    const staff = await backend.initialize();
    const item = await firstMenuItem(staff);

    const aggregateGuest = await backend.guest(
      "aggregate@example.com",
      "Aggregate Guest",
    );
    const aggregateTable = await tableFor(staff, 903);
    const aggregateOrder = expectOk(
      await aggregateGuest.client.mutation(api.orders.sit, {
        tableId: aggregateTable,
      }),
    );
    const aggregateItems = expectOk(
      await aggregateGuest.client.mutation(
        api.orders.addItems,
        {
          orderId: aggregateOrder,
          items: [
            { menuItemId: item.id, quantity: 1, note: null },
            { menuItemId: item.id, quantity: 2, note: "Second line" },
          ],
        },
      ),
    );
    expectOk(
      await staff.mutation(api.kitchen.advance, {
        orderItemId: aggregateItems[0]!,
      }),
    );
    expectOk(
      await staff.mutation(api.orders.cancel, {
        orderId: aggregateOrder,
      }),
    );

    const cancelled = expectOk(
      await staff.query(api.orders.detail, {
        id: aggregateOrder,
      }),
    );
    expect(cancelled).toMatchObject({
      status: "CANCELLED",
      totalCents: 0,
      openUserId: null,
      openTableId: null,
    });
    expect(cancelled.items.map((line) => line.status)).toEqual([
      "PREPARING",
      "ORDERED",
    ]);
    expect(
      expectOk(
        await staff.query(api.kitchen.queue, {}),
      ).some(
        (line) => line.orderId === aggregateOrder,
      ),
    ).toBe(false);
    await expectErrorCode(
      staff.mutation(api.kitchen.advance, {
        orderItemId: aggregateItems[1]!,
      }),
      "order.closed",
    );

    const selfGuest = await backend.guest(
      "self-cancel@example.com",
      "Self Cancel Guest",
    );
    const selfTable = await tableFor(staff, 904);
    const selfOrder = expectOk(
      await selfGuest.client.mutation(api.orders.sit, {
        tableId: selfTable,
      }),
    );
    const [selfItem] = expectOk(
      await selfGuest.client.mutation(api.orders.addItems, {
        orderId: selfOrder,
        items: [{ menuItemId: item.id, quantity: 1, note: null }],
      }),
    );
    expectOk(
      await selfGuest.client.mutation(api.orders.cancelItem, {
        orderId: selfOrder,
        orderItemId: selfItem!,
      }),
    );
    expectOk(
      await selfGuest.client.mutation(api.orders.closeCancelled, {
        orderId: selfOrder,
      }),
    );
    expect(
      expectOk(
        await selfGuest.client.query(api.orders.history, {}),
      ).closed[0],
    ).toMatchObject({
      id: selfOrder,
      status: "CANCELLED",
      totalCents: 0,
      allCancelled: true,
    });
  });
});

test("order events are owner-isolated and staff reminders reject guest subscribers", async () => {
  await withBackend(async (backend) => {
    const staff = await backend.initialize();
    const owner = await backend.guest("event-owner@example.com", "Event Owner");
    const stranger = await backend.guest(
      "event-stranger@example.com",
      "Event Stranger",
    );
    const tableId = await tableFor(staff, 905);
    const item = await firstMenuItem(owner.client);
    const orderId = expectOk(
      await owner.client.mutation(api.orders.sit, { tableId }),
    );
    const [orderItemId] = expectOk(
      await owner.client.mutation(api.orders.addItems, {
        orderId,
        items: [{ menuItemId: item.id, quantity: 1, note: null }],
      }),
    );

    const ownerReset = deferred<void>();
    const ownerEvent = deferred<OrderEvent>();
    const ownerUnsubscribe = owner.client.subscribeEvent(
      api.events.orderEvents,
      { identity: owner.identity },
      (event: DbzzLiveEvent<OrderEvent>) => {
        if (event.kind === "reset") ownerReset.resolve();
        if (
          event.kind === "row" &&
          event.row.orderItemId === orderItemId &&
          event.row.status === "PREPARING"
        ) {
          ownerEvent.resolve(event.row);
        }
      },
      ownerEvent.reject,
    );
    const strangerReset = deferred<void>();
    let strangerRows = 0;
    const strangerUnsubscribe = stranger.client.subscribeEvent(
      api.events.orderEvents,
      { identity: stranger.identity },
      (event: DbzzLiveEvent<OrderEvent>) => {
        if (event.kind === "reset") strangerReset.resolve();
        if (event.kind === "row") strangerRows++;
      },
      strangerReset.reject,
    );
    const forbidden = deferred<DbzzClientError>();
    const forbiddenUnsubscribe = stranger.client.subscribeEvent(
      api.events.orderEvents,
      { identity: owner.identity },
      () => forbidden.reject(new Error("forbidden subscription delivered data")),
      forbidden.resolve,
    );
    const staffForbidden = deferred<DbzzClientError>();
    const staffEventUnsubscribe = stranger.client.subscribeEvent(
      api.events.staffEvents,
      {},
      () => staffForbidden.reject(new Error("staff event delivered to guest")),
      staffForbidden.resolve,
    );

    try {
      await Promise.all([
        within(ownerReset.promise, 5_000, "owner event reset"),
        within(strangerReset.promise, 5_000, "stranger event reset"),
      ]);
      expect(
        (await within(forbidden.promise, 5_000, "foreign event rejection")).code,
      ).toBe("unauthorized");
      expect(
        (await within(staffForbidden.promise, 5_000, "staff event rejection")).code,
      ).toBe("unauthorized");

      expectOk(
        await staff.mutation(api.kitchen.advance, {
          orderItemId: orderItemId!,
        }),
      );
      expect(
        await within(ownerEvent.promise, 5_000, "owner kitchen event"),
      ).toMatchObject({
        ownerIdentity: owner.identity,
        orderId,
        orderItemId,
        status: "PREPARING",
      });
      await Bun.sleep(50);
      expect(strangerRows).toBe(0);
    } finally {
      staffEventUnsubscribe();
      forbiddenUnsubscribe();
      strangerUnsubscribe();
      ownerUnsubscribe();
    }
  });
});

test(
  "advancing an item replaces its reminder with a new two-minute deadline",
  async () => {
    const systemNow = Date.now;
    let now = systemNow();
    Date.now = () => now;
    try {
      await withBackend(async (backend) => {
        const staff = await backend.initialize();
        const guest = await backend.guest(
          "schedule@example.com",
          "Schedule Guest",
        );
        const tableId = await tableFor(staff, 906);
        const item = await firstMenuItem(guest.client);

        const reset = deferred<void>();
        const reminder = deferred<StaffEvent>();
        let targetReminders = 0;
        let orderItemId: bigint | undefined;
        const unsubscribe = staff.subscribeEvent(
          api.events.staffEvents,
          {},
          (event: DbzzLiveEvent<StaffEvent>) => {
            if (event.kind === "reset") reset.resolve();
            if (
              event.kind === "row" &&
              event.row.orderItemId === orderItemId
            ) {
              targetReminders++;
              reminder.resolve(event.row);
            }
          },
          reminder.reject,
        );

        try {
          await within(reset.promise, 5_000, "staff reminder reset");
          const orderId = expectOk(
            await guest.client.mutation(api.orders.sit, {
              tableId,
            }),
          );
          [orderItemId] = expectOk(
            await guest.client.mutation(api.orders.addItems, {
              orderId,
              items: [{ menuItemId: item.id, quantity: 1, note: null }],
            }),
          );
          const current = expectOk(
            await guest.client.query(api.orders.current, {}),
          );
          const orderedAt = current?.items.find(
            (line) => line.id === orderItemId,
          )?.statusChangedAt;
          if (orderItemId === undefined || orderedAt === undefined)
            throw new Error("scheduled item was not created");

          expect(
            await backend.runScheduled(now + REMINDER_DELAY_MS - 1),
          ).toBe(0);

          now += 30_000;
          expect(
            expectOk(
              await staff.mutation(api.kitchen.advance, { orderItemId }),
            ),
          ).toBe("PREPARING");
          const advancedAt = now;

          now = orderedAt + REMINDER_DELAY_MS;
          expect(await backend.runScheduled()).toBeGreaterThan(0);
          await Bun.sleep(25);
          expect(targetReminders).toBe(0);

          now = advancedAt + REMINDER_DELAY_MS;
          expect(await backend.runScheduled()).toBeGreaterThan(0);
          const event = await within(
            reminder.promise,
            5_000,
            "two-minute kitchen reminder",
          );
          expect(event).toMatchObject({
            kind: "KITCHEN_REMINDER",
            orderId,
            orderItemId,
            tableNumber: 906,
            itemName: item.name,
            status: "PREPARING",
          });
          expect(event.occurredAt).toBe(advancedAt + REMINDER_DELAY_MS);
        } finally {
          unsubscribe();
        }
      });
    } finally {
      Date.now = systemNow;
    }
  },
  20_000,
);
