import { DbzzClient, DbzzClientError, type DbzzLiveEvent } from "@dbzz/client";
import { api } from "@demo/dbzz-codegen/api";
import type { OrderEvent } from "@demo/dbzz-codegen/types";

const url = process.env.DBZZ_URL ?? "http://127.0.0.1:3212";
const staffToken = process.env.DBZZ_DEMO_STAFF_TOKEN ?? "savoria-demo-staff";

function client(token?: string): DbzzClient {
  return new DbzzClient({
    url,
    credential:
      token === undefined ? { kind: "anonymous" } : { kind: "bearer", token },
  });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function expectCode(work: Promise<unknown>, code: string): Promise<void> {
  try {
    await work;
  } catch (error) {
    if (error instanceof DbzzClientError && error.code === code) return;
    throw error;
  }
  throw new Error(`Expected ${code}`);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const anonymous = client();
const staff = client(staffToken);
let guest: DbzzClient | undefined;
let secondGuest: DbzzClient | undefined;
let unsubscribe: (() => void) | undefined;

try {
  await expectCode(
    anonymous.query(api.dashboard.overview, {}),
    "unauthenticated",
  );
  await staff.mutation(api.setup.initialize, {});

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const login = await anonymous.procedure(api.auth.login, {
    name: "Smoke Guest",
    email: `smoke-${suffix}@example.com`,
  });
  guest = client(login.token);
  await guest.mutation(api.users.ensureCurrent, {});
  await expectCode(guest.query(api.dashboard.overview, {}), "unauthorized");

  const profile = await guest.query(api.users.current, {});
  assert(profile !== null, "guest profile was not created");
  const authentication = guest.currentAuthentication;
  assert(
    authentication?.principal === "user",
    "guest Identity was not established",
  );

  const tables = await guest.query(api.tables.available, {});
  const table = tables.find((candidate) => candidate.available);
  assert(table !== undefined, "seed did not leave an available table");
  const orderId = await guest.mutation(api.orders.sit, { tableId: table.id });

  const catalog = await guest.query(api.menu.catalog, {});
  const menuItem = catalog.flatMap((category) => category.items)[0];
  assert(menuItem !== undefined, "menu seed is empty");
  const [orderItemId] = await guest.mutation(api.orders.addItems, {
    orderId,
    items: [{ menuItemId: menuItem.id, quantity: 1, note: "Smoke flow" }],
  });
  assert(orderItemId !== undefined, "order item was not created");

  const secondLogin = await anonymous.procedure(api.auth.login, {
    name: "Second Smoke Guest",
    email: `smoke-second-${suffix}@example.com`,
  });
  secondGuest = client(secondLogin.token);
  await secondGuest.mutation(api.users.ensureCurrent, {});
  await expectCode(
    secondGuest.mutation(api.orders.addItems, {
      orderId,
      items: [{ menuItemId: menuItem.id, quantity: 1, note: null }],
    }),
    "unauthorized",
  );

  const reset = deferred<void>();
  const statusEvent = deferred<OrderEvent>();
  unsubscribe = guest.subscribeEvent(
    api.events.orderEvents,
    { identity: authentication.identity },
    (event: DbzzLiveEvent<OrderEvent>) => {
      if (event.kind === "reset") reset.resolve();
      if (event.kind === "row" && event.row.orderItemId === orderItemId) {
        statusEvent.resolve(event.row);
      }
    },
    statusEvent.reject,
  );
  await reset.promise;

  const queue = await staff.query(api.kitchen.queue, {});
  assert(
    queue.some((item) => item.id === orderItemId),
    "kitchen did not receive the order item",
  );
  assert(
    (await staff.mutation(api.kitchen.advance, { orderItemId })) ===
      "PREPARING",
    "invalid first kitchen transition",
  );
  const event = await statusEvent.promise;
  assert(
    event.status === "PREPARING",
    "guest did not receive the realtime kitchen event",
  );
  assert(
    (await staff.mutation(api.kitchen.advance, { orderItemId })) === "PREPARED",
    "invalid second kitchen transition",
  );
  assert(
    (await staff.mutation(api.kitchen.advance, { orderItemId })) === "SERVED",
    "invalid final kitchen transition",
  );

  const ready = await guest.query(api.orders.current, {});
  assert(ready?.readyToPay === true, "served order did not become payable");
  const paid = await guest.mutation(api.orders.pay, { orderId });
  assert(
    paid.totalCents === menuItem.priceCents,
    "payment total did not use the price snapshot",
  );
  const history = await guest.query(api.orders.history, {});
  assert(
    history.closed.some(
      (order) => order.id === orderId && order.status === "PAID",
    ),
    "paid order was not persisted in history",
  );

  const secondTables = await secondGuest.query(api.tables.available, {});
  const released = secondTables.find((candidate) => candidate.id === table.id);
  assert(released?.available === true, "payment did not release the table");
  const cancelledOrderId = await secondGuest.mutation(api.orders.sit, {
    tableId: table.id,
  });
  const [cancelledItemId] = await secondGuest.mutation(api.orders.addItems, {
    orderId: cancelledOrderId,
    items: [{ menuItemId: menuItem.id, quantity: 1, note: null }],
  });
  assert(cancelledItemId !== undefined, "cancel flow item was not created");
  await secondGuest.mutation(api.orders.cancelItem, {
    orderId: cancelledOrderId,
    orderItemId: cancelledItemId,
  });
  await secondGuest.mutation(api.orders.closeCancelled, {
    orderId: cancelledOrderId,
  });
  const cancelledHistory = await secondGuest.query(api.orders.history, {});
  assert(
    cancelledHistory.closed.some(
      (order) => order.id === cancelledOrderId && order.status === "CANCELLED",
    ),
    "all-cancelled order did not close",
  );

  console.log(
    "dbzz restaurant auth, authorization, realtime, kitchen, payment, and cancellation smoke passed",
  );
} finally {
  unsubscribe?.();
  secondGuest?.close();
  guest?.close();
  staff.close();
  anonymous.close();
}
