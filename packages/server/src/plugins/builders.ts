import { brand, hasBrand } from "../shared/identity.ts";
import type { Schema } from "../schema/definition.ts";
import type { StandardValidator } from "../validation/validator.ts";
import type { ObjectShape } from "../validation/composites.ts";
import {
  isPlainObject,
  isPluginOperationSpec,
  operationSpec,
  type AnyPluginOperationSpec,
  type PluginCanonicalCall,
  type PluginExpose,
  type PluginExposedCall,
  type PluginOperationDefinition,
  type PluginOperationKind,
  type PluginOperationSpec,
} from "./contract.ts";
import type {
  PluginCtxFor,
  PluginDependencyContracts,
  PluginHandler,
} from "./capabilities.ts";

const PLUGIN_IMPLEMENTATION_IDENTITY = Symbol.for("@ackerdb/server/PluginImplementation/v1");

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

export function createOperationBuilder<
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
