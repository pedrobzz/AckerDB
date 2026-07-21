import {
  defineCacheStore,
  type CacheStoreDefinition,
} from "../storage/store.ts";

export type UpstashFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface UpstashCacheStoreOptions {
  readonly url: string;
  readonly token: string;
  readonly keyPrefix: string;
  readonly fetch?: UpstashFetch;
}

interface UpstashResponse {
  readonly result?: unknown;
  readonly error?: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function endpoint(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError("Upstash Redis url must be a non-blank HTTPS URL");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("Upstash Redis url must be a valid HTTPS URL");
  }
  if (parsed.protocol !== "https:") {
    throw new TypeError("Upstash Redis url must use HTTPS");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new TypeError("Upstash Redis url must not contain credentials");
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new TypeError("Upstash Redis url must not contain a query or fragment");
  }
  return parsed.toString();
}

function responseObject(value: unknown): UpstashResponse {
  if (!isPlainObject(value)) {
    throw new Error("Upstash Redis returned a malformed JSON response");
  }
  return value;
}

export function upstashCacheStore(
  options: UpstashCacheStoreOptions,
): CacheStoreDefinition {
  if (!isPlainObject(options)) {
    throw new TypeError("Upstash Redis cache options must be a plain object");
  }
  for (const key of Object.keys(options)) {
    if (key !== "url" && key !== "token" && key !== "keyPrefix" && key !== "fetch") {
      throw new TypeError(`unknown Upstash Redis cache option "${key}"`);
    }
  }
  const url = endpoint(options.url);
  if (typeof options.token !== "string" || options.token.trim() === "") {
    throw new TypeError("Upstash Redis token must be a non-blank string");
  }
  if (options.fetch !== undefined && typeof options.fetch !== "function") {
    throw new TypeError("Upstash Redis fetch must be a function");
  }
  const token = options.token;
  const transport = options.fetch ?? globalThis.fetch;

  return defineCacheStore({
    keyPrefix: options.keyPrefix,
    open({ abortSignal }) {
      abortSignal.throwIfAborted();

      const command = async (
        parts: readonly (string | number)[],
        signal: AbortSignal,
      ): Promise<unknown> => {
        signal.throwIfAborted();
        const response = await transport(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(parts),
          signal,
        });
        let body: unknown;
        try {
          body = await response.json();
        } catch (error) {
          throw new Error("Upstash Redis returned an unreadable JSON response", { cause: error });
        }
        const parsed = responseObject(body);
        if (Object.hasOwn(parsed, "error")) {
          if (typeof parsed.error !== "string") {
            throw new Error("Upstash Redis returned a malformed error response");
          }
          throw new Error(`Upstash Redis command failed: ${parsed.error}`);
        }
        if (!response.ok) {
          throw new Error(`Upstash Redis request failed with HTTP ${response.status}`);
        }
        if (!Object.hasOwn(parsed, "result")) {
          throw new Error("Upstash Redis response is missing its result");
        }
        return parsed.result;
      };

      return {
        async get(key, request) {
          const result = await command(["GET", key], request.abortSignal);
          if (result === null) return undefined;
          if (typeof result !== "string") {
            throw new Error("Upstash Redis GET returned an unexpected result");
          }
          return result;
        },
        async set(key, payload, request) {
          const parts: Array<string | number> = ["SET", key, payload];
          if (request.expiresInMs !== undefined) {
            parts.push("PX", request.expiresInMs);
          }
          if (request.if !== undefined) {
            parts.push(request.if === "missing" ? "NX" : "XX");
          }
          const result = await command(parts, request.abortSignal);
          if (result === null) return false;
          if (result !== "OK") {
            throw new Error("Upstash Redis SET returned an unexpected result");
          }
          return true;
        },
        async delete(key, request) {
          const result = await command(["DEL", key], request.abortSignal);
          if (typeof result !== "number" || !Number.isSafeInteger(result) || result < 0) {
            throw new Error("Upstash Redis DEL returned an unexpected result");
          }
          return result > 0;
        },
      };
    },
  });
}
