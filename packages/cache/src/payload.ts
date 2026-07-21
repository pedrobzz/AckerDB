import { decode, encode } from "@dbzz/core";
import type { StandardValidator } from "@dbzz/server";

export function encodeCacheValue(value: unknown): string {
  if (value === undefined) {
    throw new TypeError("cache values cannot be top-level undefined");
  }
  return encode(value);
}

export function decodeCacheValue(
  payload: string,
  validator?: StandardValidator<unknown, string>,
): unknown {
  let value: unknown;
  try {
    value = decode(payload);
  } catch {
    return undefined;
  }
  if (validator === undefined) return value;
  try {
    return validator.check(value, "cached value");
  } catch {
    return undefined;
  }
}
