import { SAFE_ID, SAFE_NAME } from "../state/constants.ts";

export function safeId(value: string | undefined): string | undefined {
  return typeof value === "string" && SAFE_ID.test(value) ? value : undefined;
}

export function safeName(value: string | undefined): string | undefined {
  return typeof value === "string" && SAFE_NAME.test(value) ? value : undefined;
}

export function safeCount(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function isMember<const T extends readonly string[]>(
  values: T,
  value: unknown,
): value is T[number] {
  return typeof value === "string" && values.includes(value);
}
