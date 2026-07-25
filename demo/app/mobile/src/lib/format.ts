export function formatMoney(cents: number): string {
  const fractionDigits = cents % 100 === 0 ? 0 : 2;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(cents / 100);
}

export function formatOrder(id: bigint): string {
  return `#${id.toString().padStart(4, "0")}`;
}

export function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

export function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error !== "object" || error === null) {
    return "Something went wrong. Please try again.";
  }
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
  return typeof candidate.code === "string"
    ? candidate.code
    : "Something went wrong. Please try again.";
}
