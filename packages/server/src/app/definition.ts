import { brand, hasBrand } from "../shared/identity.ts";
import {
  assemblePlugins,
  type PluginCapabilities,
  type PluginMounts,
  type PluginOperationKind,
} from "../plugins/definition.ts";
import { isSchema, type Schema } from "../schema/definition.ts";

const APP_IDENTITY = Symbol.for("@ackerdb/server/App/v1");

type EmptyPluginMounts = Readonly<Record<never, never>>;

export interface App<
  S extends Schema = Schema,
  Plugins extends PluginMounts = PluginMounts,
> {
  readonly schema: S;
  readonly plugins: Readonly<Plugins>;
}

export interface AppDefinition<
  S extends Schema,
  Plugins extends PluginMounts = EmptyPluginMounts,
> {
  readonly schema: S;
  readonly plugins?: Plugins;
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
    if (option !== "schema" && option !== "plugins") {
      throw new TypeError(`unknown application option "${option}"`);
    }
  }
  if (!Object.hasOwn(definition, "schema") || !isSchema(definition.schema)) {
    throw new TypeError("application schema must be created with defineSchema(...)");
  }
  const plugins = assemblePlugins(
    definition.plugins === undefined ? {} : definition.plugins,
  ).mounts as Readonly<Plugins>;
  const app = { schema: definition.schema, plugins };
  brand(app, APP_IDENTITY);
  return Object.freeze(app);
}

/** True for an application manifest created by any compatible @ackerdb/server instance. */
export function isApp(value: unknown): value is App {
  return hasBrand(value, APP_IDENTITY);
}
