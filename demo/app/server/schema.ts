import { v, defineEventTable, defineSchema, defineTable } from "@dbzz/server";
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

export default defineSchema({
  users: defineTable({
    id: v.primaryKey(),
    identity: v.identity().nullable(),
    email: v.string(),
    name: v.string(),
    createdAt: v.int(),
    updatedAt: v.int(),
  })
    .index("by_identity", ["identity"], { unique: true })
    .index("by_email", ["email"], { unique: true })
    .index("by_name", ["name"]),

  restaurantTables: defineTable({
    id: v.primaryKey(),
    number: v.int(),
    seats: v.int(),
    active: v.boolean(),
    createdAt: v.int(),
    updatedAt: v.int(),
  }).index("by_number", ["number"], { unique: true }),

  menuCategories: defineTable({
    id: v.primaryKey(),
    name: v.string(),
    sortOrder: v.int(),
    active: v.boolean(),
    createdAt: v.int(),
    updatedAt: v.int(),
  })
    .index("by_name", ["name"], { unique: true })
    .index("by_sort_order", ["sortOrder"]),

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
    .index("by_category", ["categoryId", "sortOrder"])
    .index("by_name", ["name"], { unique: true }),

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
    .index("by_user_opened_at", ["userId", "openedAt"])
    .index("by_status_opened_at", ["status", "openedAt"])
    .index("by_open_user", ["openUserId"], { unique: true })
    .index("by_open_table", ["openTableId"], { unique: true }),

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
    .index("by_order", ["orderId", "orderedAt"])
    .index("by_order_status", ["orderId", "status"])
    .index("by_status_changed_at", ["status", "statusChangedAt"]),

  kitchenReminders: defineTable({
    id: v.primaryKey(),
    orderItemId: v.bigint(),
    expectedStatus: itemStatus,
    at: v.scheduleAt(),
  })
    .index("by_order_item", ["orderItemId"], { unique: true })
    .scheduled("reminders.fire"),

  setupState: defineTable({
    id: v.primaryKey(),
    key: v.string(),
    completedAt: v.int(),
  }).index("by_key", ["key"], { unique: true }),

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
