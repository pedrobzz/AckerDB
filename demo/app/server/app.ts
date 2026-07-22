import { cachePlugin } from "@dbzz/cache";
import {
  v,
  defineApp,
  defineEventTable,
  defineSchema,
  defineTable,
} from "@dbzz/server";
import { isStaff, ownsIdentity } from "./lib/access.ts";

export const orderStatus = v.enum("OrderStatus", [
  "OPEN",
  "PAID",
  "CANCELLED",
]);
export const itemStatus = v.enum("ItemStatus", [
  "ORDERED",
  "PREPARING",
  "PREPARED",
  "SERVED",
  "CANCELLED",
]);
export const orderEventKind = v.enum("OrderEventKind", [
  "ITEM_STATUS",
  "ORDER_STATUS",
]);
export const staffEventKind = v.enum("StaffEventKind", ["KITCHEN_REMINDER"]);

const schema = defineSchema({
  users: defineTable({
    id: v.primaryKey(),
    identity: v.identity().nullable(),
    email: v.string(),
    name: v.string(),
    createdAt: v.int(),
    updatedAt: v.int(),
  })
    .index(["identity"], { unique: true })
    .index(["email"], { unique: true })
    .index(["name"]),

  restaurantTables: defineTable({
    id: v.primaryKey(),
    number: v.int(),
    seats: v.int(),
    active: v.boolean(),
    createdAt: v.int(),
    updatedAt: v.int(),
  }).index(["number"], { unique: true }),

  menuCategories: defineTable({
    id: v.primaryKey(),
    name: v.string(),
    sortOrder: v.int(),
    active: v.boolean(),
    createdAt: v.int(),
    updatedAt: v.int(),
  })
    .index(["name"], { unique: true })
    .index(["sortOrder"]),

  menuItems: defineTable({
    id: v.primaryKey(),
    categoryId: v.bigint(),
    name: v.string(),
    description: v.string(),
    image: v.string(),
    priceCents: v.int(),
    sortOrder: v.int(),
    active: v.boolean(),
    createdAt: v.int(),
    updatedAt: v.int(),
  })
    .index(["categoryId", "sortOrder"])
    .index(["name"], { unique: true }),

  orders: defineTable({
    id: v.primaryKey(),
    userId: v.bigint(),
    tableId: v.bigint(),
    openUserId: v.bigint().nullable(),
    openTableId: v.bigint().nullable(),
    status: orderStatus,
    totalCents: v.int(),
    openedAt: v.int(),
    closedAt: v.int().nullable(),
  })
    .index(["userId", "openedAt"])
    .index(["status", "openedAt"])
    .index(["openUserId"], { unique: true })
    .index(["openTableId"], { unique: true }),

  orderItems: defineTable({
    id: v.primaryKey(),
    orderId: v.bigint(),
    menuItemId: v.bigint(),
    name: v.string(),
    image: v.string(),
    unitPriceCents: v.int(),
    quantity: v.int(),
    note: v.string().nullable(),
    status: itemStatus,
    orderedAt: v.int(),
    statusChangedAt: v.int(),
  })
    .index(["orderId", "orderedAt"])
    .index(["orderId", "status"])
    .index(["status", "statusChangedAt"]),

  kitchenReminders: defineTable({
    id: v.primaryKey(),
    orderItemId: v.bigint(),
    expectedStatus: itemStatus,
    at: v.scheduleAt(),
  })
    .index(["orderItemId"], { unique: true })
    .scheduled("reminders.fire"),

  setupState: defineTable({
    id: v.primaryKey(),
    key: v.string(),
    completedAt: v.int(),
  }).index(["key"], { unique: true }),

  orderEvents: defineEventTable(
    {
      id: v.primaryKey(),
      ownerIdentity: v.identity(),
      orderId: v.bigint(),
      orderItemId: v.bigint().nullable(),
      kind: orderEventKind,
      status: v.string(),
      message: v.string(),
      occurredAt: v.int(),
    },
    {
      args: { identity: v.identity() },
      access: (ctx, args) => ownsIdentity(ctx.auth, args.identity),
      matches: (row, args) => row.ownerIdentity === args.identity,
    },
  ),

  staffEvents: defineEventTable(
    {
      id: v.primaryKey(),
      kind: staffEventKind,
      orderId: v.bigint(),
      orderItemId: v.bigint(),
      tableNumber: v.int(),
      itemName: v.string(),
      status: itemStatus,
      message: v.string(),
      occurredAt: v.int(),
    },
    {
      args: {},
      access: (ctx) => isStaff(ctx.auth),
      matches: () => true,
    },
  ),
});

const cache = cachePlugin({
  namespaces: {
    setupState: v.object({ completedAt: v.int() }),
  },
});

export default defineApp({ schema, plugins: { cache } });
