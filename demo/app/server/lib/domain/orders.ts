import { Err, Ok, Status } from "@dbzz/core";
import { DbzzError, type Identity } from "@dbzz/server";
import type { DatabaseReader } from "@demo/dbzz-codegen/server";
import type { Order } from "@demo/dbzz-codegen/types";
import { userForIdentity } from "./guests.ts";
import { isFinal } from "./order-status.ts";

export async function openOrder(
  db: DatabaseReader,
  orderId: bigint,
) {
  const order = await db.orders.get(orderId);
  if (order === null) {
    return Err("order.not-found", { orderId }, Status.NotFound);
  }
  if (order.status !== "OPEN") {
    return Err(
      "order.closed",
      { orderId, status: order.status },
      Status.Conflict,
    );
  }
  return Ok(order);
}

export async function ownedOpenOrder(
  db: DatabaseReader,
  identity: Identity,
  orderId: bigint,
) {
  const user = await userForIdentity(db, identity);
  if (user === null) {
    return Err("guest.profile-required", {}, Status.NotFound);
  }
  const order = await openOrder(db, orderId);
  if (!order.ok) return order;
  if (order.data.userId !== user.id) {
    return Err("order.not-owned", { orderId }, Status.Forbidden);
  }
  return Ok({ order: order.data, user });
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
  if (user === null || table === null) {
    throw new DbzzError("internal", "Order relation is missing");
  }
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
