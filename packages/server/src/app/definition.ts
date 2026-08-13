import { brand, hasBrand } from "../shared/identity.ts";
import type { PluginCapabilities } from "../plugins/capabilities.ts";
import type { PluginOperationKind } from "../plugins/contract.ts";
import {
  assemblePlugins,
  type PluginMounts,
} from "../plugins/assembly.ts";
import { isSchema, type Schema } from "../schema/definition.ts";
import { ADMIN_API_PATH, DEFAULT_API_PATH } from "@ackerdb/core";
import { apiPath } from "./functions.ts";
import { validateScopeVocabulary, type ScopeValues } from "../auth/scopes.ts";

const APP_IDENTITY = Symbol.for("@ackerdb/server/App/v1");

type EmptyPluginMounts = Readonly<Record<never, never>>;

export interface App<
  S extends Schema = Schema,
  Plugins extends PluginMounts = PluginMounts,
  Scopes extends ScopeValues | undefined = ScopeValues | undefined,
> {
  readonly schema: S;
  readonly plugins: Readonly<Plugins>;
  /** Groups beyond the framework's own that this application publishes in. */
  readonly apiPaths: readonly string[];
  /** The application's scope vocabulary; absent when it declares none. */
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
   * The API paths this application publishes beyond the framework's own
   * `"api"` and `"admin"`. Code generation reads only this manifest — never
   * the function modules, which import what it writes — so a group earns its
   * `internal.*` binding by being named here once.
   */
  readonly apiPaths?: readonly string[];
  /**
   * The one scope vocabulary every Identity grant and every function
   * requirement draws from. Names carrying the reserved marker belong to the
   * framework and are refused here.
   */
  readonly scopes?: Scopes;
}

/** The application's exact root schema, as consumed by host code generation. */
export type AppSchema<A extends App> = A["schema"];
/** The application's exact Plugin mount map, as consumed by host code generation. */
export type AppPlugins<A extends App> = A["plugins"];
/**
 * The declared scope union, as consumed by host code generation: generated
 * server modules instantiate the function builders with it, so a function
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

/**
 * The groups the framework publishes on every application's behalf: the
 * default one every declaration falls back to, and the one the Admin API is
 * declared in. Neither is listed in a manifest, and both are known to the
 * Registry and to code generation without one.
 */
const FRAMEWORK_API_PATHS: ReadonlySet<string> = new Set([
  DEFAULT_API_PATH,
  ADMIN_API_PATH,
]);

/**
 * The extra groups, validated exactly as a declaration's own `apiPath` is and
 * sorted like every other list code generation reads, so reordering `app.ts`
 * never rewrites a generated file. Neither framework group is listed: every
 * application publishes both, and naming one would offer a way to leave it out.
 */
function declaredApiPaths(value: unknown): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) {
    throw new TypeError("application apiPaths must be an array of group names");
  }
  const declared = new Set<string>();
  for (const entry of value) {
    // `apiPath` refuses every name a binding cannot be, `events` included.
    // Only the framework's two are legal on a declaration yet illegal here —
    // an application publishes its own functions in either, and code
    // generation emits both bindings whether or not a manifest says so, so
    // listing one would emit it twice.
    const path = apiPath(entry, "application apiPaths entry");
    if (FRAMEWORK_API_PATHS.has(path)) {
      throw new TypeError(
        `application apiPaths must not list "${path}" — every application publishes it`,
      );
    }
    if (declared.has(path)) {
      throw new TypeError(`application apiPaths repeats "${path}"`);
    }
    declared.add(path);
  }
  return Object.freeze([...declared].sort());
}

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
    if (
      option !== "schema" &&
      option !== "plugins" &&
      option !== "apiPaths" &&
      option !== "scopes"
    ) {
      throw new TypeError(`unknown application option "${option}"`);
    }
  }
  if (!Object.hasOwn(definition, "schema") || !isSchema(definition.schema)) {
    throw new TypeError("application schema must be created with defineSchema(...)");
  }
  const plugins = assemblePlugins(
    definition.plugins === undefined ? {} : definition.plugins,
  ).mounts as Readonly<Plugins>;
  const app = {
    schema: definition.schema,
    plugins,
    apiPaths: declaredApiPaths(definition.apiPaths),
    scopes: (definition.scopes === undefined
      ? undefined
      : validateScopeVocabulary(definition.scopes)) as Scopes,
  };
  brand(app, APP_IDENTITY);
  return Object.freeze(app);
}

/** True for an application manifest created by any compatible @ackerdb/server instance. */
export function isApp(value: unknown): value is App {
  return hasBrand(value, APP_IDENTITY);
}
