import { CacheStoreError } from "./errors.ts";

const CACHE_STORE_IDENTITY = Symbol.for("@dbzz/cache/CacheStoreDefinition/v1");

export interface CacheStoreRequest {
  readonly abortSignal: AbortSignal;
}

export interface CacheStoreSetRequest extends CacheStoreRequest {
  readonly expiresInMs?: number;
  readonly if?: "missing" | "present";
}

export interface CacheStoreHandle {
  get(key: string, request: CacheStoreRequest): string | undefined | Promise<string | undefined>;
  set(
    key: string,
    payload: string,
    request: CacheStoreSetRequest,
  ): boolean | Promise<boolean>;
  delete(key: string, request: CacheStoreRequest): boolean | Promise<boolean>;
  close?(): void | Promise<void>;
}

export interface CacheStoreOpenContext {
  readonly abortSignal: AbortSignal;
}

export interface CacheStoreDefinition {
  readonly keyPrefix: string;
  readonly open: (
    context: CacheStoreOpenContext,
  ) => CacheStoreHandle | Promise<CacheStoreHandle>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function defineCacheStore(
  definition: CacheStoreDefinition,
): CacheStoreDefinition {
  if (!isPlainObject(definition)) {
    throw new TypeError("cache store definition must be a plain object");
  }
  for (const key of Object.keys(definition)) {
    if (key !== "keyPrefix" && key !== "open") {
      throw new TypeError(`unknown cache store definition field "${key}"`);
    }
  }
  if (typeof definition.keyPrefix !== "string" || definition.keyPrefix.trim() === "") {
    throw new TypeError("cache store keyPrefix must be a non-blank string");
  }
  if (typeof definition.open !== "function") {
    throw new TypeError("cache store open must be a function");
  }

  const store = { keyPrefix: definition.keyPrefix, open: definition.open };
  Object.defineProperty(store, CACHE_STORE_IDENTITY, { value: true });
  return Object.freeze(store);
}

export function isCacheStoreDefinition(value: unknown): value is CacheStoreDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[CACHE_STORE_IDENTITY] === true
  );
}

export function assertCacheStoreHandle(value: unknown): asserts value is CacheStoreHandle {
  if (!isPlainObject(value)) {
    throw new TypeError("cache store open must return a plain handle object");
  }
  if (
    typeof value["get"] !== "function" ||
    typeof value["set"] !== "function" ||
    typeof value["delete"] !== "function" ||
    (value["close"] !== undefined && typeof value["close"] !== "function")
  ) {
    throw new TypeError("cache store handle must provide get, atomic set, delete, and optional close methods");
  }
}

export async function openCacheStore(
  definition: CacheStoreDefinition,
  abortSignal: AbortSignal,
): Promise<CacheStoreHandle> {
  let handle: CacheStoreHandle;
  try {
    handle = await definition.open({ abortSignal });
  } catch (error) {
    if (error instanceof CacheStoreError) throw error;
    throw new CacheStoreError("cache store failed to open", error);
  }
  assertCacheStoreHandle(handle);
  return handle;
}

export async function closeCacheStore(handle: CacheStoreHandle): Promise<void> {
  if (handle.close === undefined) return;
  try {
    await handle.close();
  } catch (error) {
    if (error instanceof CacheStoreError) throw error;
    throw new CacheStoreError("cache store failed to close", error);
  }
}
