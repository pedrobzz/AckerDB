import { createHash } from "node:crypto";
import { stableEncode } from "@ackerdb/core";

/** URL-safe SHA-256 of exactly the bytes given. */
export function sha256Base64Url(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("base64url");
}

/** The same digest in the lowercase hex every stored fingerprint and manifest uses. */
export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Identity of a value under the canonical encoding: same value, same digest. */
export function digestOfWire(value: unknown): string {
  return sha256Base64Url(stableEncode(value));
}
