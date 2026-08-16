import { brand, hasBrand } from "../shared/identity.ts";
import { isSchema, type Schema } from "../schema/definition.ts";
import { DEFAULT_API_PATH } from "@ackerdb/core";
import { apiPath } from "./functions.ts";
import { validateScopeVocabulary, type ScopeValues } from "../auth/scopes.ts";

const APP_IDENTITY = Symbol.for("@ackerdb/server/App/v1");

export interface App<
  S extends Schema = Schema,
  Scopes extends ScopeValues | undefined = ScopeValues | undefined,
> {
  readonly schema: S;
  /** Groups beyond the default one that this application publishes in. */
  readonly apiPaths: readonly string[];
  /** The application's scope vocabulary; absent when it declares none. */
  readonly scopes: Scopes;
}

export interface AppDefinition<
  S extends Schema,
  Scopes extends ScopeValues | undefined = undefined,
> {
  readonly schema: S;
  /**
   * The API paths this application publishes beyond the default `"api"`. Code
   * generation reads only this manifest — never the function modules, which
   * import what it writes — so a group earns its `internal.*` binding by being
   * named here once.
   */
  readonly apiPaths?: readonly string[];
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

/**
 * The extra groups, validated exactly as a declaration's own `apiPath` is and
 * sorted like every other list code generation reads, so reordering `app.ts`
 * never rewrites a generated file. The default group is not listed: every
 * application publishes it, and naming it would offer a way to leave it out.
 * Every other name is the application's to claim, `admin` included.
 */
function declaredApiPaths(value: unknown): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) {
    throw new TypeError("application apiPaths must be an array of group names");
  }
  const declared = new Set<string>();
  for (const entry of value) {
    // `apiPath` refuses every name a binding cannot be, `events` included.
    const path = apiPath(entry, "application apiPaths entry");
    if (path === DEFAULT_API_PATH) {
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
  if (!Object.hasOwn(definition, "schema") || !isSchema(definition.schema)) {
    throw new TypeError("application schema must be created with defineSchema(...)");
  }
  const app = {
    schema: definition.schema,
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
