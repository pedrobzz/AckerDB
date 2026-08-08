/**
 * The framework's own registrations, named once so a suite about an
 * application's surface can assert the application's half exactly.
 *
 * Every Registry carries the `admin` group, because every application does.
 * Filtering by address prefix would be wrong — an application may publish its
 * own functions in that group — so the set is derived from the framework's
 * contribution itself, which is also the one thing that keeps it true as the
 * surface grows.
 */
import { httpPathForAddress } from "@ackerdb/core";
import {
  frameworkFunctionModules,
  isRegisteredFunction,
  type Registry,
} from "@ackerdb/server";

export const FRAMEWORK_ADDRESSES: ReadonlySet<string> = new Set(
  Object.entries(frameworkFunctionModules()).flatMap(([modulePath, exports]) =>
    Object.entries(exports as Record<string, unknown>)
      .filter(([, value]) => isRegisteredFunction(value))
      .map(([exportName, value]) =>
        `${(value as { readonly apiPath: string }).apiPath}.${modulePath}.${exportName}`)),
);

/** Every route the framework serves, for a suite asserting one is or is not there. */
export const FRAMEWORK_ROUTES: readonly string[] = [...FRAMEWORK_ADDRESSES]
  .map(httpPathForAddress)
  .sort();

/** The addresses this application registered, sorted. */
export function applicationAddresses(registry: Registry): string[] {
  return [...registry.functions.keys()]
    .filter((address) => !FRAMEWORK_ADDRESSES.has(address))
    .sort();
}

/** The HTTP routes this application claimed, sorted. */
export function applicationRoutes(registry: Registry): string[] {
  return [...registry.exposed.values()]
    .filter((exposed) => !FRAMEWORK_ADDRESSES.has(exposed.address))
    .map((exposed) => exposed.path)
    .sort();
}
