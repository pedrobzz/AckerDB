import { Buffer } from "node:buffer";

export type CacheKey = string | number | bigint;

export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function frame(value: string): string {
  return `${utf8Bytes(value)}:${value}`;
}

function keyParts(key: CacheKey): readonly [type: string, text: string] {
  switch (typeof key) {
    case "string":
      return ["string", key];
    case "number":
      if (!Number.isFinite(key)) {
        throw new TypeError("cache key numbers must be finite");
      }
      return ["number", String(Object.is(key, -0) ? 0 : key)];
    case "bigint":
      return ["bigint", key.toString()];
  }
}

export function encodeCacheKey(
  keyPrefix: string,
  mount: string,
  namespace: string,
  key: CacheKey,
): string {
  const [type, text] = keyParts(key);
  const suffix = `ackerdb-cache:v1|${frame(mount)}|${frame(namespace)}|${type}|${frame(text)}`;
  return keyPrefix === "" ? suffix : `${keyPrefix}|${suffix}`;
}

export function assertCacheKey(value: unknown): CacheKey {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
    throw new TypeError("cache key must be a string, finite number, or bigint");
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("cache key numbers must be finite");
  }
  return value;
}
