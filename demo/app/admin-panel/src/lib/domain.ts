import type { QueryRef } from "@dbzz/client-react";
import { api } from "@demo/dbzz-codegen/api";

type QueryResult<Ref> =
  Ref extends QueryRef<unknown, infer Data, unknown> ? Data : never;

export type DashboardOverview = QueryResult<typeof api.dashboard.overview>;
export type RestaurantTable = QueryResult<typeof api.tables.list>[number];
export type MenuCatalog = QueryResult<typeof api.menu.catalog>;
export type MenuCategory = MenuCatalog[number];
export type MenuItem = MenuCategory["items"][number];
export type OrderView = QueryResult<typeof api.orders.list>[number];
export type OrderItem = OrderView["items"][number];
export type KitchenItem = QueryResult<typeof api.kitchen.queue>[number];
export type Guest = QueryResult<typeof api.users.list>[number];
export type GuestDetail = QueryResult<typeof api.users.detail>;
export type OwnerToken = QueryResult<typeof api.admin.tokens.list>[number];

export type OrderStatus = OrderView["status"];
export type ItemStatus = OrderItem["status"];

export const FIELD_LIMITS = {
  name: 80,
  orderLines: 25,
  orderQuantity: 20,
  orderNote: 160,
} as const;

export const ITEM_STATUS_ORDER: readonly ItemStatus[] = [
  "ORDERED",
  "PREPARING",
  "PREPARED",
  "SERVED",
  "CANCELLED",
];

export function money(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

export function shortTime(timestamp: number): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp);
}

export function shortDateTime(timestamp: number): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp);
}

export function relativeMinutes(timestamp: number): string {
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return "now";
  return `${minutes}m`;
}

export function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

export function imageSource(image: string): string {
  if (/^(https?:|data:|\/)/.test(image)) return image;
  return `/${image}`;
}

export function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message;
  if (typeof error !== "object" || error === null) return fallback;
  const candidate = error as {
    readonly code?: unknown;
    readonly message?: unknown;
    readonly body?: unknown;
  };
  if (typeof candidate.message === "string") return candidate.message;
  if (
    typeof candidate.body === "object" &&
    candidate.body !== null &&
    typeof (candidate.body as { readonly message?: unknown }).message === "string"
  ) {
    return (candidate.body as { readonly message: string }).message;
  }
  return typeof candidate.code === "string" ? candidate.code : fallback;
}

export function statusLabel(status: string): string {
  return status
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/^./, (character) => character.toUpperCase());
}
