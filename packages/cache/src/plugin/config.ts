import { pluginValidator, type StandardValidator } from "@ackerdb/server";
import { InvalidCacheExpirationError } from "../storage/errors.ts";
import {
  isCacheStoreDefinition,
  type CacheStoreDefinition,
} from "../storage/store.ts";

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_ENTRY_BYTES = 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 10_000;
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;

export interface CacheSetOptions {
  readonly expiresInMs?: number;
  readonly if?: "missing" | "present";
}

export type CacheNamespaces = Readonly<
  Record<string, StandardValidator<unknown, string, unknown>>
>;

interface BuiltInLimits {
  readonly maxBytes?: number;
  readonly maxEntryBytes?: number;
  readonly maxEntries?: number;
}

export interface BuiltInUncheckedCacheOptions extends BuiltInLimits {
  readonly store?: never;
  readonly namespaces?: never;
}

export type BuiltInNamespacedCacheOptions<N extends CacheNamespaces> = BuiltInLimits & {
  readonly store?: never;
  readonly namespaces: N;
};

export interface ExternalUncheckedCacheOptions {
  readonly store: CacheStoreDefinition;
  readonly namespaces?: never;
  readonly maxBytes?: never;
  readonly maxEntryBytes?: never;
  readonly maxEntries?: never;
}

export type ExternalNamespacedCacheOptions<N extends CacheNamespaces> = {
  readonly store: CacheStoreDefinition;
  readonly namespaces: N;
  readonly maxBytes?: never;
  readonly maxEntryBytes?: never;
  readonly maxEntries?: never;
};

export interface NormalizedBuiltInConfig {
  readonly namespaces?: CacheNamespaces;
  readonly maxBytes: number;
  readonly maxEntryBytes: number;
  readonly maxEntries: number;
}

export interface NormalizedExternalConfig {
  readonly namespaces?: CacheNamespaces;
  readonly store: CacheStoreDefinition;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function positiveSafeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value as number;
}

function normalizeNamespaces(value: unknown): CacheNamespaces | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value) || Object.keys(value).length === 0) {
    throw new TypeError("cache namespaces must be a non-empty plain object");
  }
  const result: Record<string, StandardValidator<unknown, string, unknown>> = {};
  for (const [name, candidate] of Object.entries(value)) {
    if (!IDENTIFIER.test(name)) {
      throw new TypeError(`cache namespace "${name}" must be an identifier`);
    }
    if (!pluginValidator.is(candidate)) {
      throw new TypeError(`cache namespace "${name}" must be a StandardValidator`);
    }
    let admitsUndefined = true;
    try {
      candidate.check(undefined, `cache namespace ${name}`);
    } catch {
      admitsUndefined = false;
    }
    if (admitsUndefined) {
      throw new TypeError(`cache namespace "${name}" validator must reject top-level undefined`);
    }
    result[name] = candidate;
  }
  return Object.freeze(result);
}

export function normalizeConfig(
  value: unknown,
): NormalizedBuiltInConfig | NormalizedExternalConfig {
  const source = value === undefined ? {} : value;
  if (!isPlainObject(source)) {
    throw new TypeError("cache plugin options must be a plain object");
  }
  for (const key of Object.keys(source)) {
    if (
      key !== "store" &&
      key !== "namespaces" &&
      key !== "maxBytes" &&
      key !== "maxEntryBytes" &&
      key !== "maxEntries"
    ) {
      throw new TypeError(`unknown cache plugin option "${key}"`);
    }
  }
  const namespaces = normalizeNamespaces(source["namespaces"]);
  if (source["store"] !== undefined) {
    if (!isCacheStoreDefinition(source["store"])) {
      throw new TypeError("cache store must be created with defineCacheStore(...)");
    }
    if (
      Object.hasOwn(source, "maxBytes") ||
      Object.hasOwn(source, "maxEntryBytes") ||
      Object.hasOwn(source, "maxEntries")
    ) {
      throw new TypeError("external cache store configuration forbids built-in capacity options");
    }
    return Object.freeze({
      store: source["store"],
      ...(namespaces === undefined ? {} : { namespaces }),
    });
  }

  const maxBytes = positiveSafeInteger(source["maxBytes"] ?? DEFAULT_MAX_BYTES, "maxBytes");
  const maxEntryBytes = positiveSafeInteger(
    source["maxEntryBytes"] ?? DEFAULT_MAX_ENTRY_BYTES,
    "maxEntryBytes",
  );
  const maxEntries = positiveSafeInteger(
    source["maxEntries"] ?? DEFAULT_MAX_ENTRIES,
    "maxEntries",
  );
  if (maxEntryBytes > maxBytes) {
    throw new RangeError("maxEntryBytes must be less than or equal to maxBytes");
  }
  return Object.freeze({
    maxBytes,
    maxEntryBytes,
    maxEntries,
    ...(namespaces === undefined ? {} : { namespaces }),
  });
}

export function normalizeSetOptions(value: unknown): CacheSetOptions {
  if (value === undefined) return {};
  if (!isPlainObject(value)) {
    throw new TypeError("cache set options must be a plain object");
  }
  for (const key of Object.keys(value)) {
    if (key !== "expiresInMs" && key !== "if") {
      throw new TypeError(`unknown cache set option "${key}"`);
    }
  }
  const expiresInMs = value["expiresInMs"] === undefined
    ? undefined
    : positiveExpiration(value["expiresInMs"]);
  const condition = value["if"];
  if (condition !== undefined && condition !== "missing" && condition !== "present") {
    throw new TypeError('cache set option "if" must be "missing" or "present"');
  }
  return {
    ...(expiresInMs === undefined ? {} : { expiresInMs }),
    ...(condition === undefined ? {} : { if: condition }),
  };
}

function positiveExpiration(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new InvalidCacheExpirationError();
  }
  return value as number;
}

export function expirationDeadline(
  timestamp: number,
  expiresInMs: number | undefined,
): number | null {
  if (expiresInMs === undefined) return null;
  const value = timestamp + expiresInMs;
  if (!Number.isSafeInteger(value)) {
    throw new InvalidCacheExpirationError(
      "cache expiration deadline exceeds the safe integer range",
    );
  }
  return value;
}

export function isLive(deadline: number | null, timestamp: number): boolean {
  return deadline === null || deadline > timestamp;
}
