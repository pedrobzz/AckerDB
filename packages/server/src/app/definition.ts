import { brand, hasBrand } from "../shared/identity.ts";
import type { PluginCapabilities } from "../plugins/capabilities.ts";
import type { PluginOperationKind } from "../plugins/contract.ts";
import {
  assemblePlugins,
  type PluginMounts,
} from "../plugins/assembly.ts";
import { isSchema, type Schema } from "../schema/definition.ts";
import { DEFAULT_API_PATH } from "@ackerdb/core";
import { apiPath } from "./functions.ts";

const APP_IDENTITY = Symbol.for("@ackerdb/server/App/v1");

type EmptyPluginMounts = Readonly<Record<never, never>>;

export interface App<
  S extends Schema = Schema,
  Plugins extends PluginMounts = PluginMounts,
> {
  readonly schema: S;
  readonly plugins: Readonly<Plugins>;
  /** Groups beyond `"api"` that this application publishes functions in. */
  readonly apiPaths: readonly string[];
}

export interface AppDefinition<
  S extends Schema,
  Plugins extends PluginMounts = EmptyPluginMounts,
> {
  readonly schema: S;
  readonly plugins?: Plugins;
  /**
   * The API paths this application publishes beyond the default `"api"`. Code
   * generation reads only this manifest — never the function modules, which
   * import what it writes — so a group earns its `internal.*` binding by being
   * named here once.
   */
  readonly apiPaths?: readonly string[];
}

/** The application's exact root schema, as consumed by host code generation. */
export type AppSchema<A extends App> = A["schema"];
/** The application's exact Plugin mount map, as consumed by host code generation. */
export type AppPlugins<A extends App> = A["plugins"];

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
 * The extra groups, validated exactly as a declaration's own `apiPath` is and
 * sorted like every other list code generation reads, so reordering `app.ts`
 * never rewrites a generated file. `"api"` is not listed: every application
 * publishes it, and naming it would offer a way to leave it out.
 */
function declaredApiPaths(value: unknown): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) {
    throw new TypeError("application apiPaths must be an array of group names");
  }
  const declared = new Set<string>();
  for (const entry of value) {
    // `apiPath` refuses every name a binding cannot be, `events` included.
    // Only `"api"` is legal on a declaration yet illegal here, because every
    // application publishes it and listing it would offer a way to leave it out.
    const path = apiPath(entry, "application apiPaths entry");
    if (path === DEFAULT_API_PATH) {
      throw new TypeError(
        `application apiPaths must not list "${DEFAULT_API_PATH}" — every application publishes it`,
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
>(definition: AppDefinition<S, Plugins>): App<S, Plugins> {
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
    if (option !== "schema" && option !== "plugins" && option !== "apiPaths") {
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
  };
  brand(app, APP_IDENTITY);
  return Object.freeze(app);
}

/** True for an application manifest created by any compatible @ackerdb/server instance. */
export function isApp(value: unknown): value is App {
  return hasBrand(value, APP_IDENTITY);
}
