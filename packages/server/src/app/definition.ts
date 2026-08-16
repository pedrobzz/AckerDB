import { brand, hasBrand } from "../shared/identity.ts";
import { isSchema, type Schema } from "../schema/definition.ts";
import { validateScopeVocabulary, type ScopeValues } from "../auth/scopes.ts";

const APP_IDENTITY = Symbol.for("@ackerdb/server/App/v1");

export interface App<
  S extends Schema = Schema,
  Scopes extends ScopeValues | undefined = ScopeValues | undefined,
> {
  readonly schema: S;
  /** The application's scope vocabulary; absent when it declares none. */
  readonly scopes: Scopes;
}

export interface AppDefinition<
  S extends Schema,
  Scopes extends ScopeValues | undefined = undefined,
> {
  readonly schema: S;
  /**
   * The one scope vocabulary every Identity grant and every function
   * requirement draws from. It is the application's alone: AckerDB declares no
   * scopes and reserves no names inside it.
   */
  readonly scopes?: Scopes;
}

/** The application's exact root schema, as consumed by host code generation. */
export type AppSchema<A extends App> = A["schema"];
/**
 * The declared scope union, as consumed by host code generation: generated
 * server modules instantiate the function builders with it, so a function
 * requiring an undeclared scope fails to compile.
 */
export type AppScope<A extends App> = A["scopes"] extends ScopeValues
  ? A["scopes"][number]
  : never;

export function defineApp<
  const S extends Schema,
  const Scopes extends ScopeValues | undefined = undefined,
>(definition: AppDefinition<S, Scopes>): App<S, Scopes> {
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
    if (option !== "schema" && option !== "scopes") {
      throw new TypeError(`unknown application option "${option}"`);
    }
  }
  if (!Object.hasOwn(definition, "schema") || !isSchema(definition.schema)) {
    throw new TypeError("application schema must be created with defineSchema(...)");
  }
  const app = {
    schema: definition.schema,
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
