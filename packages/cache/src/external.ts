import type { PluginProcedureCtx, StandardValidator } from "@dbzz/server";
import {
  type NormalizedExternalConfig,
  type RuntimeSetOptions,
} from "./config.ts";
import { CacheStoreError } from "./errors.ts";
import { encodeCacheKey, type CacheKey } from "./key.ts";
import { decodeCacheValue } from "./payload.ts";
import { externalCacheSchema } from "./schema.ts";
import type { CacheStoreHandle } from "./store.ts";

function opened(handle: CacheStoreHandle | undefined): CacheStoreHandle {
  if (handle === undefined) {
    throw new CacheStoreError(
      "cache store is not open",
      new Error("Plugin lifecycle has not started"),
    );
  }
  return handle;
}

export async function externalGet(
  ctx: PluginProcedureCtx<typeof externalCacheSchema>,
  config: NormalizedExternalConfig,
  handle: CacheStoreHandle | undefined,
  namespace: string,
  validator: StandardValidator<unknown, string> | undefined,
  key: CacheKey,
): Promise<unknown> {
  const encodedKey = encodeCacheKey(config.store.keyPrefix, ctx.mount, namespace, key);
  let payload: string | undefined;
  try {
    payload = await opened(handle).get(encodedKey, { abortSignal: ctx.abortSignal });
    if (payload !== undefined && typeof payload !== "string") {
      throw new TypeError("cache store get must return a payload string or undefined");
    }
  } catch (error) {
    if (error instanceof CacheStoreError) throw error;
    throw new CacheStoreError("cache store read failed", error);
  }
  return payload === undefined ? undefined : decodeCacheValue(payload, validator);
}

export async function externalSet(
  ctx: PluginProcedureCtx<typeof externalCacheSchema>,
  config: NormalizedExternalConfig,
  handle: CacheStoreHandle | undefined,
  namespace: string,
  key: CacheKey,
  payload: string,
  options: RuntimeSetOptions | undefined,
): Promise<boolean> {
  const encodedKey = encodeCacheKey(config.store.keyPrefix, ctx.mount, namespace, key);
  try {
    const written = await opened(handle).set(encodedKey, payload, {
      abortSignal: ctx.abortSignal,
      ...options,
    });
    if (typeof written !== "boolean") {
      throw new TypeError("cache store set must return a boolean");
    }
    return written;
  } catch (error) {
    if (error instanceof CacheStoreError) throw error;
    throw new CacheStoreError("cache store write failed", error);
  }
}

export async function externalDelete(
  ctx: PluginProcedureCtx<typeof externalCacheSchema>,
  config: NormalizedExternalConfig,
  handle: CacheStoreHandle | undefined,
  namespace: string,
  key: CacheKey,
): Promise<boolean> {
  const encodedKey = encodeCacheKey(config.store.keyPrefix, ctx.mount, namespace, key);
  try {
    const removed = await opened(handle).delete(encodedKey, {
      abortSignal: ctx.abortSignal,
    });
    if (typeof removed !== "boolean") {
      throw new TypeError("cache store delete must return a boolean");
    }
    return removed;
  } catch (error) {
    if (error instanceof CacheStoreError) throw error;
    throw new CacheStoreError("cache store delete failed", error);
  }
}
