import { EVENTS_NAMESPACE } from "@ackerdb/core";
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

/** One imported definition module and the filesystem origin that published it. */
export interface ImportedDefinitionModule {
  readonly name: string;
  readonly origin: string;
  readonly exports: Readonly<Record<string, unknown>>;
}

/** One factory result after deterministic module collection. */
export interface CollectedDefinition {
  readonly name: string;
  readonly definition: Definition;
  readonly origin: string;
}

function definitionFromExport(value: unknown): Definition | undefined {
  if (
    (typeof value !== "object" && typeof value !== "function") ||
    value === null
  ) return undefined;

  switch ((value as { readonly kind?: unknown }).kind) {
    case "query":
    case "mutation":
    case "procedure":
    case "sse":
    case "http":
    case "job":
    case "channel":
      return value as Definition;
    default:
      return undefined;
  }
}

/** Purely collect recognized factory results from already-imported modules. */
export function collectDefinitions(
  modules: readonly ImportedDefinitionModule[],
): readonly CollectedDefinition[] {
  const claimed = new Map<string, string>();
  const collected: CollectedDefinition[] = [];

  for (const module of modules) {
    if (
      module.name === EVENTS_NAMESPACE ||
      module.name.startsWith(`${EVENTS_NAMESPACE}.`)
    ) {
      throw new Error(
        `definition module "${module.origin}": the "${EVENTS_NAMESPACE}" namespace is reserved for event-table references`,
      );
    }
    for (const [exportName, value] of Object.entries(module.exports).sort(([a], [b]) =>
      a.localeCompare(b))) {
      const definition = definitionFromExport(value);
      if (definition === undefined) continue;
      const name = `${module.name}.${exportName}`;
      const owner = claimed.get(name);
      if (owner !== undefined) {
        throw new Error(
          `definition "${name}" is published by both "${owner}" and "${module.origin}"`,
        );
      }
      claimed.set(name, module.origin);
      collected.push(Object.freeze({ name, definition, origin: module.origin }));
    }
  }
  return Object.freeze(collected);
}
