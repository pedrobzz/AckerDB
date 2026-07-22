import { DbzzError, type Identity } from "@dbzz/server";
import type { DatabaseReader, DatabaseWriter } from "@demo/dbzz-codegen/server";
import type {
  ItemStatus,
  MenuItem,
  Order,
  OrderItem,
  RestaurantTable,
  User,
} from "@demo/dbzz-codegen/types";

export const REMINDER_DELAY_MS = 2 * 60_000;

export function invalid(message: string): never {
  throw new DbzzError("validation", message);
}

export function conflict(message: string): never {
  throw new DbzzError("conflict", message);
}

export function notFound(message: string): never {
  throw new DbzzError("not_found", message);
}

export function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (
    email.length < 3 ||
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    invalid("Enter a valid email address");
  }
  return email;
}

export function cleanName(value: string, label = "Name"): string {
  const name = value.trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 80) {
    invalid(`${label} must contain 2 to 80 characters`);
  }
  return name;
}

export function cleanText(value: string, label: string, max: number): string {
  const text = value.trim();
  if (text.length === 0 || text.length > max) {
    invalid(`${label} must contain 1 to ${max} characters`);
  }
  return text;
}

export function optionalText(
  value: string | null,
  label: string,
  max: number,
): string | null {
  if (value === null) return null;
  const text = value.trim();
  if (text.length > max)
    invalid(`${label} must contain at most ${max} characters`);
  return text.length === 0 ? null : text;
}

export function positiveInteger(
  value: number,
  label: string,
  max: number,
): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    invalid(`${label} must be an integer from 1 through ${max}`);
  }
  return value;
}

export function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    invalid(`${label} must be a non-negative integer`);
  }
  return value;
}

export async function userForIdentity(
  db: DatabaseReader,
  identity: Identity,
): Promise<User | null> {
  return db.users.query().where((user) => user.identity.eq(identity)).unique();
}

export async function requireCurrentUser(
  db: DatabaseReader,
  identity: Identity,
): Promise<User> {
  return (
    (await userForIdentity(db, identity)) ??
    notFound("Complete your guest profile first")
  );
}

export async function requireOrder(
  db: DatabaseReader,
  orderId: bigint,
): Promise<Order> {
  return (await db.orders.get(orderId)) ?? notFound("Order not found");
}

export async function requireOpenOrder(
  db: DatabaseReader,
  orderId: bigint,
): Promise<Order> {
  const order = await requireOrder(db, orderId);
  if (order.status !== "OPEN") conflict("This order is already closed");
  return order;
}

export async function requireOwnedOpenOrder(
  db: DatabaseReader,
  identity: Identity,
  orderId: bigint,
): Promise<{ order: Order; user: User }> {
  const user = await requireCurrentUser(db, identity);
  const order = await requireOpenOrder(db, orderId);
  if (order.userId !== user.id)
    throw new DbzzError("unauthorized", "This order belongs to another guest");
  return { order, user };
}

export async function openOrderForUser(
  db: DatabaseReader,
  userId: bigint,
): Promise<Order | null> {
  return db.orders.query().where((order) => order.openUserId.eq(userId)).unique();
}

export async function openOrderForTable(
  db: DatabaseReader,
  tableId: bigint,
): Promise<Order | null> {
  return db.orders.query().where((order) => order.openTableId.eq(tableId)).unique();
}

export async function requireActiveTable(
  db: DatabaseReader,
  tableId: bigint,
): Promise<RestaurantTable> {
  const table = await db.restaurantTables.get(tableId);
  if (table === null || !table.active) notFound("Table not found");
  return table;
}

export async function requireActiveMenuItem(
  db: DatabaseReader,
  menuItemId: bigint,
): Promise<MenuItem> {
  const item = await db.menuItems.get(menuItemId);
  if (item === null || !item.active) notFound("Menu item not found");
  const category = await db.menuCategories.get(item.categoryId);
  if (category === null || !category.active) notFound("Menu item not found");
  return item;
}

export function payableCents(items: readonly OrderItem[]): number {
  return items.reduce(
    (sum, item) =>
      item.status === "CANCELLED"
        ? sum
        : sum + item.unitPriceCents * item.quantity,
    0,
  );
}

export function isFinal(status: ItemStatus): boolean {
  return status === "SERVED" || status === "CANCELLED";
}

export function nextItemStatus(status: ItemStatus): ItemStatus | null {
  switch (status) {
    case "ORDERED":
      return "PREPARING";
    case "PREPARING":
      return "PREPARED";
    case "PREPARED":
      return "SERVED";
    case "SERVED":
    case "CANCELLED":
      return null;
  }
}

export async function orderView(db: DatabaseReader, order: Order) {
  const [user, table, items] = await Promise.all([
    db.users.get(order.userId),
    db.restaurantTables.get(order.tableId),
    db.orderItems
      .query()
      .where((item) => item.orderId.eq(order.id))
      .orderBy((item) => item.orderedAt.asc())
      .collect(),
  ]);
  if (user === null || table === null)
    throw new DbzzError("internal", "Order relation is missing");
  return {
    ...order,
    user: { id: user.id, name: user.name, email: user.email },
    table: { id: table.id, number: table.number, seats: table.seats },
    items,
    readyToPay:
      items.length > 0 &&
      items.every((item) => isFinal(item.status)) &&
      items.some((item) => item.status === "SERVED"),
    allCancelled:
      items.length > 0 && items.every((item) => item.status === "CANCELLED"),
  };
}

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
): Promise<bigint> {
  if (item.status !== "ORDERED")
    conflict("Only a newly ordered item can be cancelled");
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
  return item.id;
}

/**
 * Advance one order item to the next kitchen status, scheduling the follow-up
 * reminder and announcing the change to the guest. The single source of truth
 * for the ORDERED → PREPARING → PREPARED → SERVED progression, shared by the
 * staff `kitchen.advance` mutation and the `advance_kitchen_item` MCP tool.
 */
export async function advanceOrderItem(
  db: DatabaseWriter,
  orderItemId: bigint,
): Promise<{ orderItemId: bigint; orderId: bigint; status: ItemStatus }> {
  const item =
    (await db.orderItems.get(orderItemId)) ?? notFound("Order item not found");
  const order = await requireOpenOrder(db, item.orderId);
  const status = nextItemStatus(item.status);
  if (status === null) conflict("This item is already final");
  const now = Date.now();
  await db.orderItems.patch(item.id, { status, statusChangedAt: now });
  await scheduleReminder(db, item.id, status, now);
  const phrase =
    status === "PREPARING"
      ? "is now being prepared"
      : status === "PREPARED"
        ? "is ready"
        : "was served";
  await emitOrderEvent(db, order, {
    orderItemId: item.id,
    kind: "ITEM_STATUS",
    status,
    message: `${item.name} ${phrase}`,
    occurredAt: now,
  });
  return { orderItemId: item.id, orderId: order.id, status };
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

/**
 * Cancel an OPEN order: drop its outstanding kitchen reminders and close it as
 * CANCELLED, which clears the open-user/open-table index and so frees the
 * table. Shared by the staff `orders.cancel` mutation and the `cancel_order`
 * MCP tool. Returns the order snapshot and its item rows so callers can report
 * what was cancelled.
 */
export async function cancelOpenOrder(
  db: DatabaseWriter,
  orderId: bigint,
): Promise<{ order: Order; items: OrderItem[] }> {
  const order = await requireOpenOrder(db, orderId);
  const items = await db.orderItems
    .query()
    .where((item) => item.orderId.eq(order.id))
    .orderBy((item) => item.orderedAt.asc())
    .collect();
  for (const item of items) await clearReminder(db, item.id);
  await closeOrder(
    db,
    order,
    "CANCELLED",
    0,
    "The restaurant cancelled this order",
  );
  return { order, items };
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
): Promise<bigint[]> {
  if (input.length === 0 || input.length > 25)
    invalid("Add between 1 and 25 cart lines");
  const prepared: Array<NewOrderItem & { menuItem: MenuItem }> = [];
  for (const line of input) {
    prepared.push({
      menuItemId: line.menuItemId,
      quantity: positiveInteger(line.quantity, "Quantity", 20),
      note: optionalText(line.note, "Note", 160),
      menuItem: await requireActiveMenuItem(db, line.menuItemId),
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
  return ids;
}
