import { RedisClient } from "bun";
import {
  defineCacheStore,
  type CacheStoreDefinition,
} from "./store.ts";

export interface RedisCacheStoreOptions {
  readonly url: string;
  readonly keyPrefix: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function redisCacheStore(
  options: RedisCacheStoreOptions,
): CacheStoreDefinition {
  if (!isPlainObject(options)) {
    throw new TypeError("Redis cache options must be a plain object");
  }
  for (const key of Object.keys(options)) {
    if (key !== "url" && key !== "keyPrefix") {
      throw new TypeError(`unknown Redis cache option "${key}"`);
    }
  }
  if (typeof options.url !== "string" || options.url.trim() === "") {
    throw new TypeError("Redis url must be a non-blank string");
  }
  const url = options.url;

  return defineCacheStore({
    keyPrefix: options.keyPrefix,
    async open({ abortSignal }) {
      abortSignal.throwIfAborted();
      const client = new RedisClient(url, {
        connectionTimeout: 10_000,
        autoReconnect: true,
        maxRetries: 3,
        enableOfflineQueue: false,
      });
      const closeWhileConnecting = () => client.close();
      abortSignal.addEventListener("abort", closeWhileConnecting, { once: true });
      try {
        await client.connect();
        abortSignal.throwIfAborted();
      } catch (error) {
        client.close();
        throw error;
      } finally {
        abortSignal.removeEventListener("abort", closeWhileConnecting);
      }

      // RedisClient has no per-command AbortSignal. Requests reject before
      // dispatch; afterward the real Redis outcome wins, avoiding ambiguous writes.
      return {
        async get(key, request) {
          request.abortSignal.throwIfAborted();
          return (await client.get(key)) ?? undefined;
        },
        async set(key, payload, request) {
          request.abortSignal.throwIfAborted();
          const args = [key, payload];
          if (request.expiresInMs !== undefined) {
            args.push("PX", String(request.expiresInMs));
          }
          if (request.if !== undefined) {
            args.push(request.if === "missing" ? "NX" : "XX");
          }
          const result: unknown = await client.send("SET", args);
          if (result === null) return false;
          if (result !== "OK") {
            throw new Error("Redis SET returned an unexpected result");
          }
          return true;
        },
        async delete(key, request) {
          request.abortSignal.throwIfAborted();
          return (await client.del(key)) > 0;
        },
        close() {
          client.close();
        },
      };
    },
  });
}
