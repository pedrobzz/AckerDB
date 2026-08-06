import { brand, hasBrand } from "../shared/identity.ts";
import type { PluginCapabilities } from "../plugins/capabilities.ts";
import type { PluginOperationKind } from "../plugins/contract.ts";
import {
  assemblePlugins,
  type PluginMounts,
} from "../plugins/assembly.ts";
import { isSchema, type Schema } from "../schema/definition.ts";
import {
  validateScopeVocabulary,
  type ScopeValues,
} from "../auth/access-policy.ts";

const APP_IDENTITY = Symbol.for("@ackerdb/server/App/v1");

type EmptyPluginMounts = Readonly<Record<never, never>>;

export interface App<
  S extends Schema = Schema,
  Plugins extends PluginMounts = PluginMounts,
  Scopes extends ScopeValues | undefined = ScopeValues | undefined,
> {
  readonly schema: S;
  readonly plugins: Readonly<Plugins>;
  /** The application's scope vocabulary; absent when the app declares none. */
  readonly scopes: Scopes;
}

export interface AppDefinition<
  S extends Schema,
  Plugins extends PluginMounts = EmptyPluginMounts,
  Scopes extends ScopeValues | undefined = undefined,
> {
  readonly schema: S;
  readonly plugins?: Plugins;
  /**
   * The one scope vocabulary every Identity grant and every function
   * requirement draws from. Reserved namespaces (`studio:*`, `internal:*`)
   * are rejected at declaration.
   */
  readonly scopes?: Scopes;
}

/** The application's exact root schema, as consumed by host code generation. */
export type AppSchema<A extends App> = A["schema"];
/** The application's exact Plugin mount map, as consumed by host code generation. */
export type AppPlugins<A extends App> = A["plugins"];
/**
 * The declared scope union, as consumed by host code generation: generated
 * server modules instantiate function builders with this union, so a function
 * requiring an undeclared scope fails to compile.
 */
export type AppScope<A extends App> = A["scopes"] extends ScopeValues
  ? A["scopes"][number]
  : never;

/** Direct host capabilities for every mounted Plugin at one execution boundary. */
export type AppPluginCapabilities<
  A extends App,
  Kind extends PluginOperationKind,
> = {
  readonly [Mount in keyof AppPlugins<A> as keyof PluginCapabilities<
    NonNullable<AppPlugins<A>[Mount]["_contract"]>,
    Kind
  > extends never
    ? never
    : Mount]: PluginCapabilities<
      NonNullable<AppPlugins<A>[Mount]["_contract"]>,
      Kind
    >;
};

export function defineApp<
  const S extends Schema,
  const Plugins extends PluginMounts = EmptyPluginMounts,
  const Scopes extends ScopeValues | undefined = undefined,
>(definition: AppDefinition<S, Plugins, Scopes>): App<S, Plugins, Scopes> {
  if (
    typeof definition !== "object" ||
    definition === null ||
    Array.isArray(definition) ||
    (Object.getPrototypeOf(definition) !== Object.prototype &&
      Object.getPrototypeOf(definition) !== null)
  ) {
    throw new TypeError("application definition must be a plain object");
  }
  for (const option of Object.keys(definition)) {
    if (option !== "schema" && option !== "plugins" && option !== "scopes") {
      throw new TypeError(`unknown application option "${option}"`);
    }
  }
  if (!Object.hasOwn(definition, "schema") || !isSchema(definition.schema)) {
    throw new TypeError("application schema must be created with defineSchema(...)");
  }
  const scopes = definition.scopes === undefined
    ? undefined
    : validateScopeVocabulary(definition.scopes);
  const plugins = assemblePlugins(
    definition.plugins === undefined ? {} : definition.plugins,
  ).mounts as Readonly<Plugins>;
  const app = { schema: definition.schema, plugins, scopes: scopes as Scopes };
  brand(app, APP_IDENTITY);
  return Object.freeze(app);
}

/** True for an application manifest created by any compatible @ackerdb/server instance. */
export function isApp(value: unknown): value is App {
  return hasBrand(value, APP_IDENTITY);
}
