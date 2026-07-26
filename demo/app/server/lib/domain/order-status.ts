import type { ItemStatus, OrderItem } from "@demo/ackerdb-codegen/types";

export const REMINDER_DELAY_MS = 2 * 60_000;

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
