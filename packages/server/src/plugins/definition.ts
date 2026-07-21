import { validateArgsShape } from "../app/functions.ts";
import type { DbReader, DbWriter } from "../database/types.ts";
import { brand, hasBrand } from "../shared/identity.ts";
import { compareCodeUnits } from "../shared/ordering.ts";
import { isPluginDefinitionId, isPluginIdentifier } from "./identifiers.ts";
import { isSchema, type Schema } from "../schema/definition.ts";
import { canonicalSchemaSnapshot } from "../schema/snapshot.ts";
import {
  v,
  type Descriptor,
  type Expand,
  type InferInputShape,
  type InferShape,
  type InferValidator,
  type ObjectShape,
  type ObjectValidator,
  type StandardValidator,
} from "../validation/v.ts";

const PLUGIN_OPERATION_IDENTITY = Symbol.for("@dbzz/server/PluginOperation/v1");
const PLUGIN_CONTRACT_IDENTITY = Symbol.for("@dbzz/server/PluginContract/v1");
const PLUGIN_IMPLEMENTATION_IDENTITY = Symbol.for("@dbzz/server/PluginImplementation/v1");
const PLUGIN_INSTANCE_IDENTITY = Symbol.for("@dbzz/server/PluginInstance/v1");
const BUILTIN_CONTEXT_FIELDS = new Set([
  "abortSignal",
  "auth",
  "db",
  "linkAccount",
  "mount",
  "timestamp",
  "tx",
  "unlinkAccount",
]);

export type PluginOperationKind = "query" | "mutation" | "procedure";
export type PluginCanonicalCall<
  A extends ObjectShape,
  Result extends StandardValidator<unknown, string>,
> = (
  args: Expand<InferInputShape<A>>,
) => Promise<Expand<InferValidator<Result>>>;
// Public adapters deliberately retain arbitrary caller-facing parameters.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PluginExposedCall = (...args: any[]) => Promise<unknown>;
export type PluginExpose<
  A extends ObjectShape,
  Result extends StandardValidator<unknown, string>,
  Call extends PluginExposedCall = PluginExposedCall,
> = (call: PluginCanonicalCall<A, Result>) => Call;

export interface PluginOperationSpec<
  Kind extends PluginOperationKind = PluginOperationKind,
  A extends ObjectShape = ObjectShape,
  Result extends StandardValidator<unknown, string> = StandardValidator<unknown, string>,
  Call extends PluginExposedCall = PluginExposedCall,
> {
  readonly kind: Kind;
  readonly args: ObjectValidator<A>;
  readonly returns: Result;
  readonly argsDescriptor: Descriptor;
  readonly resultDescriptor: Descriptor;
  readonly expose?: PluginExpose<A, Result, Call>;
  /** Compile-only canonical input accepted before provider normalization. */
  readonly _accepts?: (args: Expand<InferInputShape<A>>) => void;
  /** Compile-only canonical result produced by the provider handler. */
  readonly _produces?: Expand<InferValidator<Result>>;
}

// Descriptor registries deliberately erase each operation's concrete call types,
// but retain the closed operation-kind domain used by the runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyPluginOperationSpec = PluginOperationSpec<PluginOperationKind, any, any, any>;

interface PluginOperationDefinition<
  A extends ObjectShape,
  Result extends StandardValidator<unknown, string>,
  Call extends PluginExposedCall,
> {
  readonly args: A;
  readonly returns: Result;
  readonly expose?: PluginExpose<A, Result, Call>;
}

export interface PluginContractTree {
  readonly [name: string]: AnyPluginOperationSpec | PluginContractTree;
}

export type PluginContract<T extends PluginContractTree = PluginContractTree> = {
  readonly [Name in keyof T]: T[Name] extends AnyPluginOperationSpec
    ? T[Name]
    : T[Name] extends PluginContractTree
      ? PluginContract<T[Name]>
      : never;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertIdentifier(name: string, path: string): void {
  if (!isPluginIdentifier(name)) {
    throw new TypeError(`${path} "${name}" must be an identifier`);
  }
}

function isStandardValidator(
  value: unknown,
): value is StandardValidator<unknown, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { kind?: unknown }).kind === "string" &&
    typeof (value as { check?: unknown }).check === "function" &&
    typeof (value as { tsType?: unknown }).tsType === "function" &&
    typeof (value as { descriptor?: unknown }).descriptor === "function"
  );
}

function normalizedDescriptor(value: unknown, path: string): Descriptor {
  const normalize = (current: unknown, at: string): unknown => {
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean" ||
      (typeof current === "number" && Number.isFinite(current))
    ) {
      return current;
    }
    if (Array.isArray(current)) {
      return Object.freeze(current.map((item, index) => normalize(item, `${at}[${index}]`)));
    }
    if (!isPlainObject(current)) {
      throw new TypeError(`${at} must contain only finite descriptor data`);
    }
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(current).sort()) {
      const child = current[key];
      if (child !== undefined) result[key] = normalize(child, `${at}.${key}`);
    }
    if (
      result["k"] === "enum" &&
      Array.isArray(result["values"]) &&
      result["values"].every((variant) => typeof variant === "string")
    ) {
      result["values"] = Object.freeze(
        [...result["values"]].sort(compareCodeUnits),
      );
    }
    return Object.freeze(result);
  };

  const descriptor = normalize(value, path);
  if (!isPlainObject(descriptor) || typeof descriptor["k"] !== "string") {
    throw new TypeError(`${path} must be a validator descriptor`);
  }
  return descriptor as Descriptor;
}

function operationSpec<
  const Kind extends PluginOperationKind,
  const A extends ObjectShape,
  Result extends StandardValidator<unknown, string>,
  Call extends PluginExposedCall = PluginCanonicalCall<A, Result>,
>(
  kind: Kind,
  definition: PluginOperationDefinition<A, Result, Call>,
): PluginOperationSpec<Kind, A, Result, Call> {
  if (!isPlainObject(definition)) {
    throw new TypeError(`plugin ${kind} definition must be a plain object`);
  }
  for (const option of Object.keys(definition)) {
    if (option !== "args" && option !== "returns" && option !== "expose") {
      throw new TypeError(`unknown plugin ${kind} option "${option}"`);
    }
  }
  if (!isPlainObject(definition.args)) {
    throw new TypeError(`plugin ${kind} args must be a plain object shape`);
  }
  for (const [name, validator] of Object.entries(definition.args)) {
    if (!isStandardValidator(validator)) {
      throw new TypeError(`plugin ${kind} args.${name} must be a v validator`);
    }
  }
  validateArgsShape(definition.args, `plugin ${kind} args`);
  if (!isStandardValidator(definition.returns)) {
    throw new TypeError(`plugin ${kind} returns must be a v validator`);
  }
  if (
    definition.returns.kind === "pk" ||
    definition.returns.kind === "scheduleAt" ||
    definition.returns.kind === "tag"
  ) {
    throw new TypeError(
      `plugin ${kind} returns cannot use v.${definition.returns.kind}()`,
    );
  }
  if (definition.expose !== undefined && typeof definition.expose !== "function") {
    throw new TypeError(`plugin ${kind} expose must be a function`);
  }

  const args = Object.freeze(v.object(definition.args));
  const spec = {
    kind,
    args,
    returns: definition.returns,
    argsDescriptor: normalizedDescriptor(args.descriptor(), `plugin ${kind} args descriptor`),
    resultDescriptor: normalizedDescriptor(
      definition.returns.descriptor(),
      `plugin ${kind} result descriptor`,
    ),
    ...(definition.expose === undefined ? {} : { expose: definition.expose }),
  };
  brand(spec, PLUGIN_OPERATION_IDENTITY);
  return Object.freeze(spec) as PluginOperationSpec<Kind, A, Result, Call>;
}

export function pluginQuery<
  const A extends ObjectShape,
  Result extends StandardValidator<unknown, string>,
>(
  definition: PluginOperationDefinition<A, Result, PluginCanonicalCall<A, Result>> & {
    readonly expose?: never;
  },
): PluginOperationSpec<"query", A, Result, PluginCanonicalCall<A, Result>>;
export function pluginQuery<
  const A extends ObjectShape,
  Result extends StandardValidator<unknown, string>,
  Call extends PluginExposedCall,
>(
  definition: PluginOperationDefinition<A, Result, Call> & {
    readonly expose: PluginExpose<A, Result, Call>;
  },
): PluginOperationSpec<"query", A, Result, Call>;
export function pluginQuery<
  const A extends ObjectShape,
  Result extends StandardValidator<unknown, string>,
  Call extends PluginExposedCall,
>(
  definition: PluginOperationDefinition<A, Result, Call>,
): PluginOperationSpec<"query", A, Result, Call> {
  return operationSpec("query", definition);
}

export function pluginMutation<
  const A extends ObjectShape,
  Result extends StandardValidator<unknown, string>,
>(
  definition: PluginOperationDefinition<A, Result, PluginCanonicalCall<A, Result>> & {
    readonly expose?: never;
  },
): PluginOperationSpec<"mutation", A, Result, PluginCanonicalCall<A, Result>>;
export function pluginMutation<
  const A extends ObjectShape,
  Result extends StandardValidator<unknown, string>,
  Call extends PluginExposedCall,
>(
  definition: PluginOperationDefinition<A, Result, Call> & {
    readonly expose: PluginExpose<A, Result, Call>;
  },
): PluginOperationSpec<"mutation", A, Result, Call>;
export function pluginMutation<
  const A extends ObjectShape,
  Result extends StandardValidator<unknown, string>,
  Call extends PluginExposedCall,
>(
  definition: PluginOperationDefinition<A, Result, Call>,
): PluginOperationSpec<"mutation", A, Result, Call> {
  return operationSpec("mutation", definition);
}

export function pluginProcedure<
  const A extends ObjectShape,
  Result extends StandardValidator<unknown, string>,
>(
  definition: PluginOperationDefinition<A, Result, PluginCanonicalCall<A, Result>> & {
    readonly expose?: never;
  },
): PluginOperationSpec<"procedure", A, Result, PluginCanonicalCall<A, Result>>;
export function pluginProcedure<
  const A extends ObjectShape,
  Result extends StandardValidator<unknown, string>,
  Call extends PluginExposedCall,
>(
  definition: PluginOperationDefinition<A, Result, Call> & {
    readonly expose: PluginExpose<A, Result, Call>;
  },
): PluginOperationSpec<"procedure", A, Result, Call>;
export function pluginProcedure<
  const A extends ObjectShape,
  Result extends StandardValidator<unknown, string>,
  Call extends PluginExposedCall,
>(
  definition: PluginOperationDefinition<A, Result, Call>,
): PluginOperationSpec<"procedure", A, Result, Call> {
  return operationSpec("procedure", definition);
}

export function isPluginOperationSpec(value: unknown): value is AnyPluginOperationSpec {
  return hasBrand(value, PLUGIN_OPERATION_IDENTITY);
}

function freezeContract<T extends PluginContractTree>(
  tree: T,
  path: string,
  active: WeakSet<object>,
  freeze = true,
): PluginContract<T> {
  if (!isPlainObject(tree)) {
    throw new TypeError(`${path} must be a plain object`);
  }
  if (active.has(tree)) throw new TypeError(`${path} must be an acyclic tree`);
  active.add(tree);
  const frozen: Record<string, unknown> = {};
  for (const [name, node] of Object.entries(tree)) {
    assertIdentifier(name, `${path} name`);
    frozen[name] = isPluginOperationSpec(node)
      ? node
      : freezeContract(node as PluginContractTree, `${path}.${name}`, active);
  }
  active.delete(tree);
  return (freeze ? Object.freeze(frozen) : frozen) as PluginContract<T>;
}

export function definePluginContract<const T extends PluginContractTree>(
  tree: T,
): PluginContract<T> {
  const contract = freezeContract(tree, "plugin contract", new WeakSet(), false);
  brand(contract, PLUGIN_CONTRACT_IDENTITY);
  return Object.freeze(contract);
}

export function isPluginContract(value: unknown): value is PluginContract {
  return hasBrand(value, PLUGIN_CONTRACT_IDENTITY);
}

export type PluginOperationCall<Spec extends AnyPluginOperationSpec> =
  Spec extends PluginOperationSpec<
    PluginOperationKind,
    any,
    any,
    infer Call
  >
    ? Call
    : never;

type OperationKinds<Node> = Node extends PluginOperationSpec<infer Kind, any, any, any>
  ? Kind
  : Node extends PluginContractTree
    ? { [Name in keyof Node]: OperationKinds<Node[Name]> }[keyof Node]
    : never;

type CallableKinds<Caller extends PluginOperationKind> = Caller extends "query"
  ? "query"
  : Caller extends "mutation"
    ? "query" | "mutation"
    : PluginOperationKind;

export type PluginCapabilities<
  Contract extends PluginContractTree,
  Caller extends PluginOperationKind,
> = {
  readonly [Name in keyof Contract as Extract<
    OperationKinds<Contract[Name]>,
    CallableKinds<Caller>
  > extends never
    ? never
    : Name]: Contract[Name] extends AnyPluginOperationSpec
      ? Contract[Name]["kind"] extends CallableKinds<Caller>
        ? PluginOperationCall<Contract[Name]>
        : never
      : Contract[Name] extends PluginContractTree
        ? PluginCapabilities<Contract[Name], Caller>
        : never;
};

export type PluginQueryCapabilities<Contract extends PluginContractTree> =
  PluginCapabilities<Contract, "query">;
export type PluginMutationCapabilities<Contract extends PluginContractTree> =
  PluginCapabilities<Contract, "mutation">;
export type PluginProcedureCapabilities<Contract extends PluginContractTree> =
  PluginCapabilities<Contract, "procedure">;

export type PluginDependencyContracts = Readonly<Record<string, PluginContractTree>>;
type DependencyCapabilities<
  Dependencies extends PluginDependencyContracts,
  Kind extends PluginOperationKind,
> = {
  readonly [Slot in keyof Dependencies as keyof PluginCapabilities<
    Dependencies[Slot],
    Kind
  > extends never ? never : Slot]: PluginCapabilities<Dependencies[Slot], Kind>;
};

export interface PluginInvocationCtx {
  readonly timestamp: number;
  readonly mount: string;
}

export type PluginQueryCtx<
  S extends Schema,
  Dependencies extends PluginDependencyContracts = Readonly<Record<never, never>>,
> = PluginInvocationCtx &
  { readonly db: DbReader<S> } &
  DependencyCapabilities<Dependencies, "query">;

export type PluginMutationCtx<
  S extends Schema,
  Dependencies extends PluginDependencyContracts = Readonly<Record<never, never>>,
> = PluginInvocationCtx &
  { readonly db: DbWriter<S> } &
  DependencyCapabilities<Dependencies, "mutation">;

export type PluginProcedureCtx<
  S extends Schema,
  Dependencies extends PluginDependencyContracts = Readonly<Record<never, never>>,
> = PluginInvocationCtx &
  DependencyCapabilities<Dependencies, "procedure"> & {
    readonly abortSignal: AbortSignal;
    tx<T>(
      work: (ctx: PluginMutationCtx<S, Dependencies>) => T | Promise<T>,
    ): Promise<T>;
  };

type PluginCtxFor<
  Kind extends PluginOperationKind,
  S extends Schema,
  Dependencies extends PluginDependencyContracts,
> = Kind extends "query"
  ? PluginQueryCtx<S, Dependencies>
  : Kind extends "mutation"
    ? PluginMutationCtx<S, Dependencies>
    : PluginProcedureCtx<S, Dependencies>;

type PluginHandler<Ctx, Spec extends AnyPluginOperationSpec> =
  Spec extends PluginOperationSpec<PluginOperationKind, infer A, infer Result, any>
    ? (
      ctx: Ctx,
      args: Expand<InferShape<A>>,
    ) => Expand<InferValidator<Result>> | Promise<Expand<InferValidator<Result>>>
    : never;

export interface PluginOperationImplementation<
  Spec extends AnyPluginOperationSpec = AnyPluginOperationSpec,
  Ctx = unknown,
> {
  readonly spec: Spec;
  readonly handler: PluginHandler<Ctx, Spec>;
}

// Export registries deliberately erase each handler's concrete context while
// retaining the operation metadata's closed kind domain.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyPluginOperationImplementation = PluginOperationImplementation<
  AnyPluginOperationSpec,
  any
>;

interface InlinePluginOperationDefinition<
  A extends ObjectShape,
  Result extends StandardValidator<unknown, string>,
  Call extends PluginExposedCall,
  Ctx,
> extends PluginOperationDefinition<A, Result, Call> {
  readonly handler: PluginHandler<Ctx, PluginOperationSpec<PluginOperationKind, A, Result, Call>>;
}

export interface PluginOperationBuilder<
  Kind extends PluginOperationKind,
  S extends Schema,
  Dependencies extends PluginDependencyContracts,
> {
  <Spec extends PluginOperationSpec<Kind, any, any, any>>(
    spec: Spec,
    handler: PluginHandler<PluginCtxFor<Kind, S, Dependencies>, Spec>,
  ): PluginOperationImplementation<Spec, PluginCtxFor<Kind, S, Dependencies>>;
  <
    const A extends ObjectShape,
    Result extends StandardValidator<unknown, string>,
  >(
    definition: InlinePluginOperationDefinition<
      A,
      Result,
      PluginCanonicalCall<A, Result>,
      PluginCtxFor<Kind, S, Dependencies>
    > & { readonly expose?: never },
  ): PluginOperationImplementation<
    PluginOperationSpec<Kind, A, Result, PluginCanonicalCall<A, Result>>,
    PluginCtxFor<Kind, S, Dependencies>
  >;
  <
    const A extends ObjectShape,
    Result extends StandardValidator<unknown, string>,
    Call extends PluginExposedCall,
  >(
    definition: InlinePluginOperationDefinition<
      A,
      Result,
      Call,
      PluginCtxFor<Kind, S, Dependencies>
    > & { readonly expose: PluginExpose<A, Result, Call> },
  ): PluginOperationImplementation<
    PluginOperationSpec<Kind, A, Result, Call>,
    PluginCtxFor<Kind, S, Dependencies>
  >;
}

export interface PluginBuilders<
  S extends Schema,
  Dependencies extends PluginDependencyContracts,
> {
  readonly query: PluginOperationBuilder<"query", S, Dependencies>;
  readonly mutation: PluginOperationBuilder<"mutation", S, Dependencies>;
  readonly procedure: PluginOperationBuilder<"procedure", S, Dependencies>;
}

export function isPluginOperationImplementation(
  value: unknown,
): value is AnyPluginOperationImplementation {
  return hasBrand(value, PLUGIN_IMPLEMENTATION_IDENTITY);
}

function createOperationBuilder<
  Kind extends PluginOperationKind,
  S extends Schema,
  Dependencies extends PluginDependencyContracts,
>(kind: Kind): PluginOperationBuilder<Kind, S, Dependencies> {
  const builder = (
    specOrDefinition: AnyPluginOperationSpec | Record<string, unknown>,
    sharedHandler?: unknown,
  ): AnyPluginOperationImplementation => {
    let spec: AnyPluginOperationSpec;
    let handler: unknown;
    if (isPluginOperationSpec(specOrDefinition)) {
      if (specOrDefinition.kind !== kind) {
        throw new TypeError(
          `plugin ${kind} builder cannot implement a ${specOrDefinition.kind} spec`,
        );
      }
      spec = specOrDefinition;
      handler = sharedHandler;
    } else {
      if (!isPlainObject(specOrDefinition)) {
        throw new TypeError(`inline plugin ${kind} definition must be a plain object`);
      }
      for (const option of Object.keys(specOrDefinition)) {
        if (
          option !== "args" &&
          option !== "returns" &&
          option !== "expose" &&
          option !== "handler"
        ) {
          throw new TypeError(`unknown inline plugin ${kind} option "${option}"`);
        }
      }
      handler = specOrDefinition["handler"];
      spec = operationSpec(kind, {
        args: specOrDefinition["args"] as ObjectShape,
        returns: specOrDefinition["returns"] as StandardValidator<unknown, string>,
        ...(specOrDefinition["expose"] === undefined
          ? {}
          : { expose: specOrDefinition["expose"] as PluginExpose<ObjectShape, StandardValidator<unknown, string>> }),
      });
    }
    if (typeof handler !== "function") {
      throw new TypeError(`plugin ${kind} implementation requires a handler`);
    }
    const implementation = { spec, handler };
    brand(implementation, PLUGIN_IMPLEMENTATION_IDENTITY);
    return Object.freeze(implementation) as AnyPluginOperationImplementation;
  };
  return Object.freeze(builder) as PluginOperationBuilder<Kind, S, Dependencies>;
}

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

/** A side-effect-free declaration whose start callback is owned by DBzz startup. */
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyPluginInstance = PluginInstance<any, any, any, any, any>;
export type PluginMounts = Readonly<Record<string, AnyPluginInstance>>;

export interface PluginAssembly<Mounts extends PluginMounts = PluginMounts> {
  readonly mounts: Readonly<Mounts>;
  readonly order: readonly (keyof Mounts & string)[];
}

function assertExportTree(
  exports: unknown,
  path: string,
  active: WeakSet<object>,
): asserts exports is PluginExportTree {
  if (!isPlainObject(exports)) throw new TypeError(`${path} must be a plain object`);
  if (active.has(exports)) throw new TypeError(`${path} must be an acyclic tree`);
  active.add(exports);
  for (const [name, node] of Object.entries(exports)) {
    assertIdentifier(name, `${path} name`);
    if (isPluginOperationImplementation(node)) {
      if (!isPluginOperationSpec(node.spec) || typeof node.handler !== "function") {
        throw new TypeError(`${path}.${name} is a malformed Plugin operation implementation`);
      }
    } else {
      assertExportTree(node, `${path}.${name}`, active);
    }
  }
  active.delete(exports);
}

function sameDescriptor(left: Descriptor, right: Descriptor): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertProviderCompatible(
  required: PluginContractTree,
  provided: PluginExportTree,
  path: string,
): void {
  for (const [name, requirement] of Object.entries(required)) {
    const implementation = provided[name];
    const operationPath = `${path}.${name}`;
    if (isPluginOperationSpec(requirement)) {
      if (!isPluginOperationImplementation(implementation)) {
        throw new TypeError(`${operationPath} is missing from the provider`);
      }
      const providedSpec = implementation.spec;
      if (providedSpec.kind !== requirement.kind) {
        throw new TypeError(
          `${operationPath} is ${providedSpec.kind}, but the dependency requires ${requirement.kind}`,
        );
      }
      if (!sameDescriptor(providedSpec.argsDescriptor, requirement.argsDescriptor)) {
        throw new TypeError(`${operationPath} argument validators do not satisfy the dependency`);
      }
      if (!sameDescriptor(providedSpec.resultDescriptor, requirement.resultDescriptor)) {
        throw new TypeError(`${operationPath} result validator does not satisfy the dependency`);
      }
      continue;
    }
    if (!isPlainObject(implementation) || isPluginOperationImplementation(implementation)) {
      throw new TypeError(`${operationPath} namespace is missing from the provider`);
    }
    assertProviderCompatible(requirement, implementation as PluginExportTree, operationPath);
  }
}

function assertInstanceDescriptor(instance: AnyPluginInstance, mount: string): void {
  if (
    typeof instance.definitionId !== "string" ||
    !isPluginDefinitionId(instance.definitionId)
  ) {
    throw new TypeError(`plugin mount "${mount}" has an invalid definition id`);
  }
  if (!isSchema(instance.schema)) {
    throw new TypeError(`plugin mount "${mount}" has an invalid private schema`);
  }
  assertExportTree(instance.exports, `plugin mount "${mount}" exports`, new WeakSet());
  if (!isPlainObject(instance.dependencies) || !isPlainObject(instance.providers)) {
    throw new TypeError(`plugin mount "${mount}" has malformed dependencies`);
  }
  if (
    instance.lifecycle !== undefined &&
    typeof instance.lifecycle !== "function"
  ) {
    throw new TypeError(`plugin mount "${mount}" has a malformed lifecycle`);
  }
  for (const [slot, contract] of Object.entries(instance.dependencies)) {
    assertIdentifier(slot, `plugin mount "${mount}" dependency`);
    if (BUILTIN_CONTEXT_FIELDS.has(slot)) {
      throw new TypeError(
        `plugin mount "${mount}" dependency "${slot}" collides with a built-in context field`,
      );
    }
    if (!isPluginContract(contract)) {
      throw new TypeError(`plugin mount "${mount}" dependency "${slot}" has an invalid contract`);
    }
    if (!Object.hasOwn(instance.providers, slot)) {
      throw new TypeError(`plugin mount "${mount}" dependency "${slot}" has no provider`);
    }
  }
  for (const slot of Object.keys(instance.providers)) {
    if (!Object.hasOwn(instance.dependencies, slot)) {
      throw new TypeError(`plugin mount "${mount}" has undeclared provider "${slot}"`);
    }
  }
}

export function assemblePlugins<const Mounts extends PluginMounts>(
  plugins: Mounts,
): PluginAssembly<Mounts> {
  if (!isPlainObject(plugins)) {
    throw new TypeError("application plugins must be a plain object");
  }
  const mounts: Record<string, AnyPluginInstance> = {};
  const mountOf = new Map<AnyPluginInstance, string>();
  const schemaByDefinition = new Map<
    string,
    { readonly mount: string; readonly snapshot: string }
  >();
  for (const [mount, instance] of Object.entries(plugins)) {
    assertIdentifier(mount, "plugin mount");
    if (BUILTIN_CONTEXT_FIELDS.has(mount)) {
      throw new TypeError(`plugin mount "${mount}" collides with a built-in context field`);
    }
    if (!isPluginInstance(instance)) {
      throw new TypeError(`plugin mount "${mount}" must be a Plugin instance`);
    }
    const previousMount = mountOf.get(instance);
    if (previousMount !== undefined) {
      throw new TypeError(
        `Plugin instance is mounted twice as "${previousMount}" and "${mount}"`,
      );
    }
    assertInstanceDescriptor(instance, mount);
    const snapshot = canonicalSchemaSnapshot(instance.schema);
    const established = schemaByDefinition.get(instance.definitionId);
    if (established !== undefined && established.snapshot !== snapshot) {
      throw new TypeError(
        `Plugin definition "${instance.definitionId}" has conflicting private schemas at mounts "${established.mount}" and "${mount}"`,
      );
    }
    if (established === undefined) {
      schemaByDefinition.set(instance.definitionId, { mount, snapshot });
    }
    mounts[mount] = instance;
    mountOf.set(instance, mount);
  }

  for (const [mount, instance] of Object.entries(mounts)) {
    for (const [slot, contract] of Object.entries(
      instance.dependencies as PluginDependencyContracts,
    )) {
      const provider = instance.providers[slot];
      if (!isPluginInstance(provider)) {
        throw new TypeError(`plugin "${mount}" dependency "${slot}" has an invalid provider`);
      }
      const providerMount = mountOf.get(provider);
      if (providerMount === undefined) {
        throw new TypeError(
          `plugin "${mount}" dependency "${slot}" provider is not mounted`,
        );
      }
      assertProviderCompatible(
        contract,
        provider.exports,
        `plugin "${mount}" dependency "${slot}"`,
      );
    }
  }

  const order: string[] = [];
  const states = new Map<AnyPluginInstance, "visiting" | "visited">();
  const visit = (instance: AnyPluginInstance): void => {
    const state = states.get(instance);
    if (state === "visited") return;
    const mount = mountOf.get(instance)!;
    if (state === "visiting") {
      throw new TypeError(`Plugin dependency cycle reaches mount "${mount}"`);
    }
    states.set(instance, "visiting");
    for (const provider of Object.values(instance.providers)) visit(provider);
    states.set(instance, "visited");
    order.push(mount);
  };
  for (const instance of Object.values(mounts)) visit(instance);

  return Object.freeze({
    mounts: Object.freeze(mounts) as Readonly<Mounts>,
    order: Object.freeze(order) as readonly (keyof Mounts & string)[],
  });
}
