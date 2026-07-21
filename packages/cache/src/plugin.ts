import {
  definePlugin,
  type InferValidator,
  type InferValidatorInput,
  type PluginExportTree,
  type PluginInstance,
  type PluginOperationSpec,
  type StandardValidator,
} from "@dbzz/server";
import {
  normalizeConfig,
  type BuiltInNamespacedCacheOptions,
  type BuiltInUncheckedCacheOptions,
  type CacheNamespaces,
  type CacheSetOptions,
  type ExternalNamespacedCacheOptions,
  type ExternalUncheckedCacheOptions,
  type NormalizedBuiltInConfig,
  type NormalizedExternalConfig,
} from "./config.ts";
import { type CacheKey } from "./key.ts";
import { mutationExports, procedureExports } from "./operations.ts";
import { cacheSchema, externalCacheSchema } from "./schema.ts";
import {
  closeCacheStore,
  openCacheStore,
  type CacheStoreHandle,
} from "./store.ts";

const BUILTIN_CACHE_ID = "@dbzz/cache" as const;
const EXTERNAL_CACHE_ID = "@dbzz/cache-external" as const;

type UncheckedGet = <T>(key: CacheKey) => Promise<T | undefined>;
type UncheckedSet = (
  key: CacheKey,
  value: unknown,
  options?: CacheSetOptions,
) => Promise<boolean>;
type CacheDelete = (key: CacheKey) => Promise<boolean>;

type NamespacedGet<V extends StandardValidator<unknown, string, unknown>> = (
  key: CacheKey,
) => Promise<InferValidator<V> | undefined>;
type NamespacedSet<V extends StandardValidator<unknown, string, unknown>> = (
  key: CacheKey,
  value: InferValidatorInput<V>,
  options?: CacheSetOptions,
) => Promise<boolean>;

type CacheArgument<Input, Kind extends string> = StandardValidator<unknown, Kind, Input>;
type CacheResult<Output, Kind extends string> = StandardValidator<Output, Kind, unknown>;
type CacheValueValidator = StandardValidator<unknown, string, unknown>;

type CacheKeyArgs = {
  readonly key: CacheArgument<CacheKey, "jsonb">;
};

type CacheSetArgs<V extends CacheValueValidator | undefined> = {
  readonly key: CacheArgument<CacheKey, "jsonb">;
  readonly value: V extends CacheValueValidator
    ? CacheArgument<InferValidatorInput<V>, V["kind"]>
    : CacheArgument<unknown, "jsonb">;
  readonly options: CacheArgument<CacheSetOptions | undefined, "optional">;
};

type CacheGetOperation<
  Kind extends "mutation" | "procedure",
  V extends CacheValueValidator | undefined,
> = PluginOperationSpec<
  Kind,
  CacheKeyArgs,
  CacheResult<
    V extends CacheValueValidator ? InferValidator<V> | undefined : unknown | undefined,
    "optional"
  >,
  V extends CacheValueValidator ? NamespacedGet<V> : UncheckedGet
>;

type CacheSetOperation<
  Kind extends "mutation" | "procedure",
  V extends CacheValueValidator | undefined,
> = PluginOperationSpec<
  Kind,
  CacheSetArgs<V>,
  CacheResult<boolean, "boolean">,
  V extends CacheValueValidator ? NamespacedSet<V> : UncheckedSet
>;

type CacheDeleteOperation<Kind extends "mutation" | "procedure"> = PluginOperationSpec<
  Kind,
  CacheKeyArgs,
  CacheResult<boolean, "boolean">,
  CacheDelete
>;

export type CacheContract<
  N extends CacheNamespaces | undefined,
  Kind extends "mutation" | "procedure",
> = N extends CacheNamespaces
  ? {
    readonly [Name in keyof N]: {
      readonly get: CacheGetOperation<Kind, N[Name]>;
      readonly set: CacheSetOperation<Kind, N[Name]>;
      readonly delete: CacheDeleteOperation<Kind>;
    };
  }
  : {
    readonly get: CacheGetOperation<Kind, undefined>;
    readonly set: CacheSetOperation<Kind, undefined>;
    readonly delete: CacheDeleteOperation<Kind>;
  };

export type CachePluginInstance<
  N extends CacheNamespaces | undefined,
  Kind extends "mutation" | "procedure",
> = PluginInstance<
  CacheContract<N, Kind>,
  PluginExportTree,
  Kind extends "mutation" ? typeof BUILTIN_CACHE_ID : typeof EXTERNAL_CACHE_ID,
  Kind extends "mutation" ? typeof cacheSchema : typeof externalCacheSchema,
  Readonly<Record<never, never>>
>;

const builtinPlugin = definePlugin({
  id: BUILTIN_CACHE_ID,
  schema: cacheSchema,
  create(builders, config: NormalizedBuiltInConfig) {
    return { exports: mutationExports(builders, config) };
  },
});

const externalPlugin = definePlugin({
  id: EXTERNAL_CACHE_ID,
  schema: externalCacheSchema,
  create(builders, config: NormalizedExternalConfig) {
    let handle: CacheStoreHandle | undefined;
    const exports = procedureExports(builders, config, () => handle);
    const lifecycle = async ({ abortSignal }: { mount: string; abortSignal: AbortSignal }) => {
      handle = await openCacheStore(config.store, abortSignal);
      return async () => {
        const opened = handle;
        handle = undefined;
        if (opened !== undefined) await closeCacheStore(opened);
      };
    };
    return { exports, lifecycle };
  },
});

export function cachePlugin(): CachePluginInstance<undefined, "mutation">;
export function cachePlugin(
  options: BuiltInUncheckedCacheOptions,
): CachePluginInstance<undefined, "mutation">;
export function cachePlugin<const N extends CacheNamespaces>(
  options: BuiltInNamespacedCacheOptions<N>,
): CachePluginInstance<N, "mutation">;
export function cachePlugin(
  options: ExternalUncheckedCacheOptions,
): CachePluginInstance<undefined, "procedure">;
export function cachePlugin<const N extends CacheNamespaces>(
  options: ExternalNamespacedCacheOptions<N>,
): CachePluginInstance<N, "procedure">;
export function cachePlugin(
  options?:
    | BuiltInUncheckedCacheOptions
    | BuiltInNamespacedCacheOptions<CacheNamespaces>
    | ExternalUncheckedCacheOptions
    | ExternalNamespacedCacheOptions<CacheNamespaces>,
): CachePluginInstance<CacheNamespaces | undefined, "mutation" | "procedure"> {
  const config = normalizeConfig(options);
  return (
    "store" in config ? externalPlugin(config) : builtinPlugin(config)
  ) as unknown as CachePluginInstance<
    CacheNamespaces | undefined,
    "mutation" | "procedure"
  >;
}

export type {
  BuiltInNamespacedCacheOptions,
  BuiltInUncheckedCacheOptions,
  CacheNamespaces,
  CacheSetOptions,
  ExternalNamespacedCacheOptions,
  ExternalUncheckedCacheOptions,
} from "./config.ts";
