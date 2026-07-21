import {
  defineApp,
  defineSchema,
  v,
  type AppPluginCapabilities,
} from "@dbzz/server";
import { cachePlugin, defineCacheStore } from "../../src/index.ts";

const unchecked = cachePlugin();
const builtinDefinitionId: "@dbzz/cache" = unchecked.definitionId;
const uncheckedApp = defineApp({
  schema: defineSchema({}),
  plugins: { cache: unchecked },
});

declare const uncheckedQuery: AppPluginCapabilities<typeof uncheckedApp, "query">;
// @ts-expect-error built-in cache is absent from Query
uncheckedQuery.cache;

declare const uncheckedMutation: AppPluginCapabilities<typeof uncheckedApp, "mutation">;
const genericHit: Promise<{ name: string } | undefined> =
  uncheckedMutation.cache.get<{ name: string }>("profile:1");
const wrote: Promise<boolean> = uncheckedMutation.cache.set("profile:1", { name: "Pedro" });
const removed: Promise<boolean> = uncheckedMutation.cache.delete("profile:1");
// @ts-expect-error cache keys are primitive
uncheckedMutation.cache.get({ id: 1 });
void genericHit;
void wrote;
void removed;

const namespaced = cachePlugin({
  namespaces: {
    profile: v.object({ name: v.string(), age: v.int().optional() }),
  },
});
const namespacedApp = defineApp({
  schema: defineSchema({}),
  plugins: { cache: namespaced },
});
declare const namespacedMutation: AppPluginCapabilities<typeof namespacedApp, "mutation">;
const profile: Promise<{ name: string; age?: number } | undefined> =
  namespacedMutation.cache.profile.get(1n);
namespacedMutation.cache.profile.set(1n, { name: "Pedro" });
namespacedMutation.cache.profile.set(1n, { name: "Pedro", age: 32 }, { if: "present" });
// @ts-expect-error namespaces replace the root unchecked operations
namespacedMutation.cache.get;
// @ts-expect-error namespace input is inferred from its validator
namespacedMutation.cache.profile.set(1n, { name: 42 });
void profile;

const externalStore = defineCacheStore({
  keyPrefix: "types",
  open: () => ({
    get: () => undefined,
    set: () => true,
    delete: () => false,
  }),
});
const externalCache = cachePlugin({ store: externalStore });
const externalDefinitionId: "@dbzz/cache-external" = externalCache.definitionId;
const externalApp = defineApp({
  schema: defineSchema({}),
  plugins: { cache: externalCache },
});
// @ts-expect-error external caches do not own SQLite tables
externalCache.schema.tables.entries;
declare const externalMutation: AppPluginCapabilities<typeof externalApp, "mutation">;
// @ts-expect-error external cache is absent from Mutation and transaction contexts
externalMutation.cache;
declare const externalProcedure: AppPluginCapabilities<typeof externalApp, "procedure">;
externalProcedure.cache.set("key", "value", { expiresInMs: 10 });
externalProcedure.cache.get<string>("key");
void builtinDefinitionId;
void externalDefinitionId;

// @ts-expect-error external stores own capacity and forbid built-in limits
cachePlugin({ store: externalStore, maxBytes: 10 });
// @ts-expect-error invalid cache key type
externalProcedure.cache.delete(false);
