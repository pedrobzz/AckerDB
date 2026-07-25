import { Err, Ok, Status } from "@dbzz/core";
import type { DatabaseWriter } from "@demo/dbzz-codegen/server";
import type {
  ItemStatus,
  MenuItem,
  Order,
  OrderItem,
} from "@demo/dbzz-codegen/types";
import { activeMenuItem } from "./catalog.ts";
import {
  isFinal,
  nextItemStatus,
  REMINDER_DELAY_MS,
} from "./order-status.ts";
import { openOrder } from "./orders.ts";

export async function emitOrderEvent(
  db: DatabaseWriter,
  order: Order,
  input: {
    orderItemId?: bigint | null;
    kind: "ITEM_STATUS" | "ORDER_STATUS";
    status: string;
    message: string;
    occurredAt: number;
  },
): Promise<void> {
  const user = await db.users.get(order.userId);
  if (user?.identity === null || user?.identity === undefined) return;
  await db.orderEvents.insert({
    ownerIdentity: user.identity,
    orderId: order.id,
    orderItemId: input.orderItemId ?? null,
    kind: input.kind,
    status: input.status,
    message: input.message,
    occurredAt: input.occurredAt,
  });
}

export async function cancelOrderItem(
  db: DatabaseWriter,
  order: Order,
  item: OrderItem,
  message: string,
) {
  if (item.status !== "ORDERED") {
    return Err(
      "order-item.not-cancellable",
      { orderItemId: item.id, status: item.status },
      Status.Conflict,
    );
  }
  const now = Date.now();
  await db.orderItems.patch(item.id, {
    status: "CANCELLED",
    statusChangedAt: now,
  });
  await clearReminder(db, item.id);
  await db.orders.patch(order.id, {
    totalCents: Math.max(
      0,
      order.totalCents - item.unitPriceCents * item.quantity,
    ),
  });
  await emitOrderEvent(db, order, {
    orderItemId: item.id,
    kind: "ITEM_STATUS",
    status: "CANCELLED",
    message,
    occurredAt: now,
  });
  return Ok(item.id);
}

export async function advanceOrderItem(
  db: DatabaseWriter,
  orderItemId: bigint,
) {
  const item = await db.orderItems.get(orderItemId);
  if (item === null) {
    return Err("order-item.not-found", { orderItemId }, Status.NotFound);
  }
  const order = await openOrder(db, item.orderId);
  if (!order.ok) return order;
  const status = nextItemStatus(item.status);
  if (status === null) {
    return Err(
      "order-item.final",
      { orderItemId, status: item.status },
      Status.Conflict,
    );
  }
  const now = Date.now();
  await db.orderItems.patch(item.id, { status, statusChangedAt: now });
  await scheduleReminder(db, item.id, status, now);
  const phrase =
    status === "PREPARING"
      ? "is now being prepared"
      : status === "PREPARED"
        ? "is ready"
        : "was served";
  await emitOrderEvent(db, order.data, {
    orderItemId: item.id,
    kind: "ITEM_STATUS",
    status,
    message: `${item.name} ${phrase}`,
    occurredAt: now,
  });
  return Ok({ orderItemId: item.id, orderId: order.data.id, status });
}

export async function closeOrder(
  db: DatabaseWriter,
  order: Order,
  status: "PAID" | "CANCELLED",
  totalCents: number,
  message: string,
): Promise<void> {
  const now = Date.now();
  await db.orders.patch(order.id, {
    status,
    totalCents,
    openUserId: null,
    openTableId: null,
    closedAt: now,
  });
  await emitOrderEvent(db, order, {
    kind: "ORDER_STATUS",
    status,
    message,
    occurredAt: now,
  });
}

export async function cancelOpenOrder(
  db: DatabaseWriter,
  orderId: bigint,
) {
  const order = await openOrder(db, orderId);
  if (!order.ok) return order;
  const items = await db.orderItems
    .query()
    .where((item) => item.orderId.eq(order.data.id))
    .orderBy((item) => item.orderedAt.asc())
    .collect();
  for (const item of items) await clearReminder(db, item.id);
  await closeOrder(
    db,
    order.data,
    "CANCELLED",
    0,
    "The restaurant cancelled this order",
  );
  return Ok({ order: order.data, items });
}

export async function clearReminder(
  db: DatabaseWriter,
  orderItemId: bigint,
): Promise<void> {
  const reminder = await db.kitchenReminders
    .query()
    .where((reminder) => reminder.orderItemId.eq(orderItemId))
    .unique();
  if (reminder !== null) await db.kitchenReminders.delete(reminder.id);
}

export async function scheduleReminder(
  db: DatabaseWriter,
  orderItemId: bigint,
  expectedStatus: ItemStatus,
  now: number,
): Promise<void> {
  await clearReminder(db, orderItemId);
  if (isFinal(expectedStatus)) return;
  await db.kitchenReminders.insert({
    orderItemId,
    expectedStatus,
    at: now + REMINDER_DELAY_MS,
  });
}

export interface NewOrderItem {
  readonly menuItemId: bigint;
  readonly quantity: number;
  readonly note: string | null;
}

export async function addOrderItems(
  db: DatabaseWriter,
  order: Order,
  input: readonly NewOrderItem[],
  now = Date.now(),
) {
  const prepared: Array<NewOrderItem & { menuItem: MenuItem }> = [];
  for (const line of input) {
    const menuItem = await activeMenuItem(db, line.menuItemId);
    if (!menuItem.ok) return menuItem;
    const note = line.note?.trim() ?? null;
    prepared.push({
      menuItemId: line.menuItemId,
      quantity: line.quantity,
      note: note === "" ? null : note,
      menuItem: menuItem.data,
    });
  }

  const ids: bigint[] = [];
  let addedCents = 0;
  for (const line of prepared) {
    const id = await db.orderItems.insert({
      orderId: order.id,
      menuItemId: line.menuItem.id,
      name: line.menuItem.name,
      image: line.menuItem.image,
      unitPriceCents: line.menuItem.priceCents,
      quantity: line.quantity,
      note: line.note,
      status: "ORDERED",
      orderedAt: now,
      statusChangedAt: now,
    });
    ids.push(id);
    addedCents += line.menuItem.priceCents * line.quantity;
    await scheduleReminder(db, id, "ORDERED", now);
  }
  await db.orders.patch(order.id, {
    totalCents: order.totalCents + addedCents,
  });
  return Ok(ids);
}
