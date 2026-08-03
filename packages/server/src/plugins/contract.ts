import { validateArgsShape } from "../validation/declarations.ts";
import { brand, hasBrand } from "../shared/identity.ts";
import { compareCodeUnits } from "../shared/ordering.ts";
import { assertIdentifier } from "./identifiers.ts";
import { isStandardValidator } from "./validator.ts";
import type {
  Descriptor,
  Expand,
  InferValidator,
  StandardValidator,
} from "../validation/validator.ts";
import type {
  InferInputShape,
  InferShape,
  ObjectShape,
  ObjectValidator,
} from "../validation/composites.ts";
import { v } from "../validation/v.ts";

const PLUGIN_OPERATION_IDENTITY = Symbol.for("@ackerdb/server/PluginOperation/v1");
const PLUGIN_CONTRACT_IDENTITY = Symbol.for("@ackerdb/server/PluginContract/v1");

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

export interface PluginOperationDefinition<
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

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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

export function operationSpec<
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
