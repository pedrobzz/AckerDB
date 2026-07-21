export {
  cachePlugin,
  type BuiltInNamespacedCacheOptions,
  type BuiltInUncheckedCacheOptions,
  type CacheContract,
  type CacheNamespaces,
  type CachePluginInstance,
  type CacheSetOptions,
  type ExternalNamespacedCacheOptions,
  type ExternalUncheckedCacheOptions,
} from "./plugin/definition.ts";
export {
  CacheEntryTooLargeError,
  CacheStoreError,
  InvalidCacheExpirationError,
} from "./storage/errors.ts";
export {
  defineCacheStore,
  type CacheStoreDefinition,
  type CacheStoreHandle,
  type CacheStoreOpenContext,
  type CacheStoreRequest,
  type CacheStoreSetRequest,
} from "./storage/store.ts";
export type { CacheKey } from "./storage/key.ts";
