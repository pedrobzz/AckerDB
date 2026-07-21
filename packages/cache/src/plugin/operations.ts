import {
  pluginMutation,
  pluginProcedure,
  v,
  type PluginBuilders,
  type PluginExportTree,
  type StandardValidator,
} from "@dbzz/server";
import { builtinDelete, builtinGet, builtinSet } from "../storage/built-in.ts";
import {
  normalizeSetOptions,
  type CacheSetOptions,
  type NormalizedBuiltInConfig,
  type NormalizedExternalConfig,
} from "./config.ts";
import { externalDelete, externalGet, externalSet } from "../storage/external.ts";
import { assertCacheKey, type CacheKey } from "../storage/key.ts";
import { encodeCacheValue } from "../storage/payload.ts";
import { cacheSchema, externalCacheSchema } from "./schema.ts";
import type { CacheStoreHandle } from "../storage/store.ts";
import {
  normalizingValidator,
  opaqueValidator,
  optionalValidator,
} from "./validators.ts";

type EmptyDependencies = Readonly<Record<never, never>>;

const keyValidator = opaqueValidator<CacheKey>((value) => assertCacheKey(value));
const optionsValidator = optionalValidator(normalizingValidator(
  opaqueValidator<CacheSetOptions>(),
  normalizeSetOptions,
));
const uncheckedValueValidator = opaqueValidator<unknown>();
const uncheckedResultValidator = optionalValidator(opaqueValidator<unknown>());

function namespaceTree(
  namespaces: Readonly<Record<string, StandardValidator<unknown, string>>> | undefined,
  make: (
    namespace: string,
    validator?: StandardValidator<unknown, string>,
  ) => PluginExportTree,
): PluginExportTree {
  if (namespaces === undefined) return make("");
  return Object.fromEntries(
    Object.entries(namespaces).map(([name, validator]) => [name, make(name, validator)]),
  );
}

export function mutationExports(
  builders: PluginBuilders<typeof cacheSchema, EmptyDependencies>,
  config: NormalizedBuiltInConfig,
): PluginExportTree {
  return namespaceTree(config.namespaces, (namespace, validator) => {
    const payloadValidator = normalizingValidator(
      validator ?? uncheckedValueValidator,
      encodeCacheValue,
    );
    return {
      get: builders.mutation(
        pluginMutation({
          args: { key: keyValidator },
          returns: validator === undefined
            ? uncheckedResultValidator
            : optionalValidator(validator),
          expose: (call) => (key: CacheKey) => call({ key }),
        }),
        (ctx, args) => builtinGet(ctx, namespace, validator, args.key),
      ),
      set: builders.mutation(
        pluginMutation({
          args: {
            key: keyValidator,
            value: payloadValidator,
            options: optionsValidator,
          },
          returns: v.boolean(),
          expose: (call) => (key: CacheKey, value: unknown, options?: CacheSetOptions) =>
            call({ key, value, options }),
        }),
        (ctx, args) => builtinSet(ctx, config, namespace, args.key, args.value, args.options),
      ),
      delete: builders.mutation(
        pluginMutation({
          args: { key: keyValidator },
          returns: v.boolean(),
          expose: (call) => (key: CacheKey) => call({ key }),
        }),
        (ctx, args) => builtinDelete(ctx, namespace, args.key),
      ),
    };
  });
}

export function procedureExports(
  builders: PluginBuilders<typeof externalCacheSchema, EmptyDependencies>,
  config: NormalizedExternalConfig,
  currentHandle: () => CacheStoreHandle | undefined,
): PluginExportTree {
  return namespaceTree(config.namespaces, (namespace, validator) => {
    const payloadValidator = normalizingValidator(
      validator ?? uncheckedValueValidator,
      encodeCacheValue,
    );
    return {
      get: builders.procedure(
        pluginProcedure({
          args: { key: keyValidator },
          returns: validator === undefined
            ? uncheckedResultValidator
            : optionalValidator(validator),
          expose: (call) => (key: CacheKey) => call({ key }),
        }),
        (ctx, args) => externalGet(ctx, config, currentHandle(), namespace, validator, args.key),
      ),
      set: builders.procedure(
        pluginProcedure({
          args: {
            key: keyValidator,
            value: payloadValidator,
            options: optionsValidator,
          },
          returns: v.boolean(),
          expose: (call) => (key: CacheKey, value: unknown, options?: CacheSetOptions) =>
            call({ key, value, options }),
        }),
        (ctx, args) =>
          externalSet(ctx, config, currentHandle(), namespace, args.key, args.value, args.options),
      ),
      delete: builders.procedure(
        pluginProcedure({
          args: { key: keyValidator },
          returns: v.boolean(),
          expose: (call) => (key: CacheKey) => call({ key }),
        }),
        (ctx, args) => externalDelete(ctx, config, currentHandle(), namespace, args.key),
      ),
    };
  });
}
