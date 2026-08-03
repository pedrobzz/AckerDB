import { brand, hasBrand } from "../shared/identity.ts";
import { isSchema, type Schema } from "../schema/definition.ts";
import { assertIdentifier, BUILTIN_CONTEXT_FIELDS, isPluginDefinitionId } from "./identifiers.ts";
import {
  isPlainObject,
  isPluginContract,
  type AnyPluginOperationSpec,
  type PluginContract,
  type PluginContractTree,
  type PluginOperationSpec,
} from "./contract.ts";
import type { PluginDependencyContracts } from "./capabilities.ts";
import {
  createOperationBuilder,
  isPluginOperationImplementation,
  type AnyPluginOperationImplementation,
  type PluginBuilders,
  type PluginOperationImplementation,
} from "./builders.ts";

const PLUGIN_INSTANCE_IDENTITY = Symbol.for("@ackerdb/server/PluginInstance/v1");

export interface PluginExportTree {
  readonly [name: string]: AnyPluginOperationImplementation | PluginExportTree;
}

export type PluginContractOfExports<Exports extends PluginExportTree> = {
  readonly [Name in keyof Exports]: Exports[Name] extends PluginOperationImplementation<
    infer Spec,
    any
  >
    ? Spec
    : Exports[Name] extends PluginExportTree
      ? PluginContractOfExports<Exports[Name]>
      : never;
};

export interface PluginCreation<Exports extends PluginExportTree> {
  readonly exports: Exports;
  readonly lifecycle?: PluginLifecycle;
}

export interface PluginLifecycleContext {
  readonly mount: string;
  readonly abortSignal: AbortSignal;
}

/** Cleanup return values are deliberately ignored after synchronous/async settlement. */
export type PluginCleanup = () => unknown | Promise<unknown>;

/** A side-effect-free declaration whose start callback is owned by AckerDB startup. */
export type PluginLifecycle = (
  context: Readonly<PluginLifecycleContext>,
) => void | PluginCleanup | Promise<void | PluginCleanup>;

type ProviderContract<Contract extends PluginContractTree> = {
  readonly [Name in keyof Contract]: Contract[Name] extends AnyPluginOperationSpec
    ? Pick<Contract[Name], "kind" | "_accepts" | "_produces">
    : Contract[Name] extends PluginContractTree
      ? ProviderContract<Contract[Name]>
      : never;
};

/** Provider compatibility is canonical; each consumer owns its exposed call shape. */
export type PluginProvider<Contract extends PluginContractTree> = Omit<
  PluginInstance<any, any, any, any, any>,
  "_contract"
> & { readonly _contract?: ProviderContract<Contract> };
export type PluginProviders<Dependencies extends PluginDependencyContracts> = {
  readonly [Slot in keyof Dependencies]: PluginProvider<Dependencies[Slot]>;
};

export interface PluginInstance<
  Contract extends PluginContractTree = PluginContractTree,
  Exports extends PluginExportTree = PluginExportTree,
  Id extends string = string,
  S extends Schema = Schema,
  Dependencies extends PluginDependencyContracts = PluginDependencyContracts,
> {
  readonly definitionId: Id;
  readonly schema: S;
  readonly exports: Exports;
  readonly dependencies: Dependencies;
  readonly providers: PluginProviders<Dependencies>;
  readonly lifecycle?: PluginLifecycle;
  /** Compile-only provider compatibility marker. */
  readonly _contract?: Contract;
}

type EmptyPluginConfig = Readonly<Record<never, never>>;
type PluginFactoryOptions<
  Config extends object,
  Dependencies extends PluginDependencyContracts,
> = Config & PluginProviders<Dependencies>;
type PluginFactoryArguments<Options extends object> = {} extends Options
  ? [options?: Options]
  : [options: Options];

export interface PluginFactory<
  Id extends string,
  S extends Schema,
  Dependencies extends PluginDependencyContracts,
  Config extends object,
  Exports extends PluginExportTree,
> {
  (
    ...args: PluginFactoryArguments<PluginFactoryOptions<Config, Dependencies>>
  ): PluginInstance<PluginContractOfExports<Exports>, Exports, Id, S, Dependencies>;
  readonly id: Id;
  readonly schema: S;
  readonly dependencies: Dependencies;
}

interface PluginDefinitionBase<
  Id extends string,
  S extends Schema,
  Dependencies extends PluginDependencyContracts,
> {
  readonly id: Id;
  readonly schema: S;
  readonly dependencies?: Dependencies;
}

type ConfigDependencyCollision<
  Config extends object,
  Dependencies extends PluginDependencyContracts,
> = Extract<keyof Config, keyof Dependencies> extends never
  ? unknown
  : { readonly "plugin config keys must not overlap dependency slots": never };

export function definePlugin<
  const Id extends string,
  S extends Schema,
  const Exports extends PluginExportTree,
  const Dependencies extends PluginDependencyContracts = Readonly<Record<never, never>>,
  Config extends object = EmptyPluginConfig,
>(
  definition: PluginDefinitionBase<Id, S, Dependencies> & {
    readonly create: (
      builders: PluginBuilders<S, Dependencies>,
      config: Config,
    ) => PluginCreation<Exports>;
  } & ConfigDependencyCollision<Config, Dependencies>,
): PluginFactory<Id, S, Dependencies, Config, Exports>;
export function definePlugin(
  definition: PluginDefinitionBase<string, Schema, PluginDependencyContracts> & {
    readonly create: (
      builders: PluginBuilders<Schema, PluginDependencyContracts>,
      config: Record<string, unknown>,
    ) => PluginCreation<PluginExportTree>;
  },
): PluginFactory<string, Schema, PluginDependencyContracts, object, PluginExportTree> {
  if (!isPlainObject(definition)) {
    throw new TypeError("plugin definition must be a plain object");
  }
  for (const option of Object.keys(definition)) {
    if (option !== "id" && option !== "schema" && option !== "dependencies" && option !== "create") {
      throw new TypeError(`unknown plugin definition option "${option}"`);
    }
  }
  if (typeof definition.id !== "string" || !isPluginDefinitionId(definition.id)) {
    throw new TypeError(`plugin id must be a package-like stable name`);
  }
  if (!isSchema(definition.schema)) {
    throw new TypeError("plugin schema must be created with defineSchema(...)");
  }
  if (typeof definition.create !== "function") {
    throw new TypeError("plugin create must be a function");
  }

  const dependenciesInput = definition.dependencies ?? {};
  if (!isPlainObject(dependenciesInput)) {
    throw new TypeError("plugin dependencies must be a plain object");
  }
  const dependencies: Record<string, PluginContractTree> = {};
  for (const [slot, contract] of Object.entries(dependenciesInput)) {
    assertIdentifier(slot, "plugin dependency");
    if (BUILTIN_CONTEXT_FIELDS.has(slot)) {
      throw new TypeError(`plugin dependency "${slot}" collides with a built-in context field`);
    }
    if (!isPluginContract(contract)) {
      throw new TypeError(`plugin dependency "${slot}" must be created with definePluginContract(...)`);
    }
    dependencies[slot] = contract;
  }
  const frozenDependencies = Object.freeze(dependencies);
  const builders = Object.freeze({
    query: createOperationBuilder("query"),
    mutation: createOperationBuilder("mutation"),
    procedure: createOperationBuilder("procedure"),
  });

  const factory = ((options?: Record<string, unknown>) => {
    const source = options ?? {};
    if (!isPlainObject(source)) {
      throw new TypeError(`plugin "${definition.id}" options must be a plain object`);
    }
    const providers: Record<string, PluginInstance> = {};
    for (const slot of Object.keys(frozenDependencies)) {
      const provider = source[slot];
      if (!isPluginInstance(provider)) {
        throw new TypeError(`plugin "${definition.id}" dependency "${slot}" requires a Plugin instance`);
      }
      providers[slot] = provider;
    }
    const config: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(source)) {
      if (!Object.hasOwn(frozenDependencies, name)) config[name] = value;
    }
    const created = definition.create(
      builders as PluginBuilders<Schema, PluginDependencyContracts>,
      Object.freeze(config),
    );
    if (!isPlainObject(created) || !Object.hasOwn(created, "exports")) {
      throw new TypeError(`plugin "${definition.id}" create must return { exports, lifecycle? }`);
    }
    for (const option of Object.keys(created)) {
      if (option !== "exports" && option !== "lifecycle") {
        throw new TypeError(`unknown plugin creation field "${option}"`);
      }
    }
    let lifecycle: PluginLifecycle | undefined;
    if (created.lifecycle !== undefined) {
      if (typeof created.lifecycle !== "function") {
        throw new TypeError(`plugin "${definition.id}" lifecycle must be a function`);
      }
      lifecycle = created.lifecycle;
    }
    const instance = {
      definitionId: definition.id,
      schema: definition.schema,
      exports: freezeExports(created.exports, `plugin "${definition.id}" exports`, new WeakSet()),
      dependencies: frozenDependencies,
      providers: Object.freeze(providers),
      ...(lifecycle === undefined ? {} : { lifecycle }),
    };
    brand(instance, PLUGIN_INSTANCE_IDENTITY);
    return Object.freeze(instance);
  }) as PluginFactory<string, Schema, PluginDependencyContracts, object, PluginExportTree>;
  Object.defineProperties(factory, {
    id: { enumerable: true, value: definition.id },
    schema: { enumerable: true, value: definition.schema },
    dependencies: { enumerable: true, value: frozenDependencies },
  });
  return Object.freeze(factory);
}

function freezeExports<Exports extends PluginExportTree>(
  exports: Exports,
  path: string,
  active: WeakSet<object>,
): Exports {
  if (!isPlainObject(exports)) throw new TypeError(`${path} must be a plain object`);
  if (active.has(exports)) throw new TypeError(`${path} must be an acyclic tree`);
  active.add(exports);
  const frozen: Record<string, unknown> = {};
  for (const [name, node] of Object.entries(exports)) {
    assertIdentifier(name, `${path} name`);
    frozen[name] = isPluginOperationImplementation(node)
      ? node
      : freezeExports(node as PluginExportTree, `${path}.${name}`, active);
  }
  active.delete(exports);
  return Object.freeze(frozen) as Exports;
}

export function isPluginInstance(value: unknown): value is PluginInstance {
  return hasBrand(value, PLUGIN_INSTANCE_IDENTITY);
}

// Assembly registries deliberately erase each mounted instance's concrete types.
