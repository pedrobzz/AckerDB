import { dbz, defineEventTable, defineSchema, defineTable } from "@dbzz/server";
import { isStaff, ownsIdentity } from "./lib/access.ts";

export const orderStatus = dbz.enum("OrderStatus", [
  "OPEN",
  "PAID",
  "CANCELLED",
]);
export const itemStatus = dbz.enum("ItemStatus", [
  "ORDERED",
  "PREPARING",
  "PREPARED",
  "SERVED",
  "CANCELLED",
]);
export const orderEventKind = dbz.enum("OrderEventKind", [
  "ITEM_STATUS",
  "ORDER_STATUS",
]);
export const staffEventKind = dbz.enum("StaffEventKind", ["KITCHEN_REMINDER"]);

export default defineSchema({
  users: defineTable({
    id: dbz.primaryKey(),
    identity: dbz.nullable(dbz.identity()),
    email: dbz.string(),
    name: dbz.string(),
    createdAt: dbz.number(),
    updatedAt: dbz.number(),
  })
    .index("by_identity", ["identity"], { unique: true })
    .index("by_email", ["email"], { unique: true })
    .index("by_name", ["name"]),

  restaurantTables: defineTable({
    id: dbz.primaryKey(),
    number: dbz.number(),
    seats: dbz.number(),
    active: dbz.boolean(),
    createdAt: dbz.number(),
    updatedAt: dbz.number(),
  }).index("by_number", ["number"], { unique: true }),

  menuCategories: defineTable({
    id: dbz.primaryKey(),
    name: dbz.string(),
    sortOrder: dbz.number(),
    active: dbz.boolean(),
    createdAt: dbz.number(),
    updatedAt: dbz.number(),
  })
    .index("by_name", ["name"], { unique: true })
    .index("by_sort_order", ["sortOrder"]),

  menuItems: defineTable({
    id: dbz.primaryKey(),
    categoryId: dbz.bigint(),
    name: dbz.string(),
    description: dbz.string(),
    image: dbz.string(),
    priceCents: dbz.number(),
    sortOrder: dbz.number(),
    active: dbz.boolean(),
    createdAt: dbz.number(),
    updatedAt: dbz.number(),
  })
    .index("by_category", ["categoryId", "sortOrder"])
    .index("by_name", ["name"], { unique: true }),

  orders: defineTable({
    id: dbz.primaryKey(),
    userId: dbz.bigint(),
    tableId: dbz.bigint(),
    openUserId: dbz.nullable(dbz.bigint()),
    openTableId: dbz.nullable(dbz.bigint()),
    status: orderStatus,
    totalCents: dbz.number(),
    openedAt: dbz.number(),
    closedAt: dbz.nullable(dbz.number()),
  })
    .index("by_user_opened_at", ["userId", "openedAt"])
    .index("by_status_opened_at", ["status", "openedAt"])
    .index("by_open_user", ["openUserId"], { unique: true })
    .index("by_open_table", ["openTableId"], { unique: true }),

  orderItems: defineTable({
    id: dbz.primaryKey(),
    orderId: dbz.bigint(),
    menuItemId: dbz.bigint(),
    name: dbz.string(),
    image: dbz.string(),
    unitPriceCents: dbz.number(),
    quantity: dbz.number(),
    note: dbz.nullable(dbz.string()),
    status: itemStatus,
    orderedAt: dbz.number(),
    statusChangedAt: dbz.number(),
  })
    .index("by_order", ["orderId", "orderedAt"])
    .index("by_order_status", ["orderId", "status"])
    .index("by_status_changed_at", ["status", "statusChangedAt"]),

  kitchenReminders: defineTable({
    id: dbz.primaryKey(),
    orderItemId: dbz.bigint(),
    expectedStatus: itemStatus,
    at: dbz.scheduleAt(),
  })
    .index("by_order_item", ["orderItemId"], { unique: true })
    .scheduled("reminders.fire"),

  setupState: defineTable({
    id: dbz.primaryKey(),
    key: dbz.string(),
    completedAt: dbz.number(),
  }).index("by_key", ["key"], { unique: true }),

  orderEvents: defineEventTable(
    {
      id: dbz.primaryKey(),
      ownerIdentity: dbz.identity(),
      orderId: dbz.bigint(),
      orderItemId: dbz.nullable(dbz.bigint()),
      kind: orderEventKind,
      status: dbz.string(),
      message: dbz.string(),
      occurredAt: dbz.number(),
    },
    {
      args: { identity: dbz.identity() },
      access: (ctx, args) => ownsIdentity(ctx.auth, args.identity),
      matches: (row, args) => row.ownerIdentity === args.identity,
    },
  ),

  staffEvents: defineEventTable(
    {
      id: dbz.primaryKey(),
      kind: staffEventKind,
      orderId: dbz.bigint(),
      orderItemId: dbz.bigint(),
      tableNumber: dbz.number(),
      itemName: dbz.string(),
      status: itemStatus,
      message: dbz.string(),
      occurredAt: dbz.number(),
    },
    {
      args: {},
      access: (ctx) => isStaff(ctx.auth),
      matches: () => true,
    },
  ),
});
