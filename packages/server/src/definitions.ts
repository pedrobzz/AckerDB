import type { AnyRegistered } from "./app/functions.ts";
import type { AnyRegisteredChannel } from "./channels/definition.ts";
import type { JobDefinition } from "./jobs/definition.ts";
import type { Http } from "./transport/routing/route.ts";

/** Every application declaration the server can load, identified only by kind. */
export type Definition =
  | AnyRegistered
  | Http
  | JobDefinition
  | AnyRegisteredChannel;

export type DefinitionKind = Definition["kind"];

/**
 * Interpret one module export at the loading seam. Values without a `kind`
 * remain ordinary helpers; a present but unknown kind is a malformed
 * definition and fails here instead of being rediscovered by each registry.
 */
export function definitionFromModuleExport(
  value: unknown,
  where: string,
): Definition | undefined {
  if (
    ((typeof value !== "object" && typeof value !== "function") || value === null) ||
    !Object.hasOwn(value, "kind")
  ) return undefined;

  const kind = (value as { readonly kind?: unknown }).kind;
  switch (kind) {
    case "query":
    case "mutation":
    case "procedure":
    case "sse":
    case "http":
    case "job":
    case "channel":
      return value as Definition;
    default:
      throw new TypeError(`${where} has unknown definition kind ${JSON.stringify(kind)}`);
  }
}
