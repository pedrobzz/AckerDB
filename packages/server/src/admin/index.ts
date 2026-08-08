/**
 * The single composition point for the functions the AckerDB framework
 * declares itself, in the `admin` group it publishes on every application's
 * behalf.
 *
 * **The framework is a contributor to the registry, not a special case inside
 * it.** `database/framework-schema.ts` already answers this question for
 * tables — framework tables live inside the logical schema, planned and
 * queryable like any application table, injected by the Engine rather than
 * declared by the application. Functions get the same answer: the Registry
 * takes the framework's modules and the application's modules as two
 * contributions and runs one set of passes over both, so an admin function is
 * addressed, routed, codec-compiled, and documented by exactly the code every
 * other function goes through.
 *
 * The two contributions stay separate records rather than merging into one,
 * and that is the whole reason this returns a record instead of wrapping the
 * application's. A module key is a directory name with no reserved marker, so
 * `functions/system.ts` and the framework's `system` module are one key; a
 * merge would let one silently replace the other. Two sources cannot: the
 * group is the first segment of the address, so the framework's export is
 * `admin.system.info` and the application's is `api.system.info`, and only a
 * declaration that names the framework's own group *and* its module and export
 * name collides — which the address space refuses out loud.
 */
import { credentialsModule } from "./credentials.ts";
import { normalizeAdminOptions, type AdminOptions } from "./options.ts";
import { systemModule } from "./system.ts";

/**
 * The framework's function modules, keyed exactly as an application's are —
 * an object type rather than an interface, so it satisfies the same
 * `Record<string, Record<string, unknown>>` the walk of a functions directory
 * produces and the Registry takes one kind of contribution.
 */
export type FrameworkFunctionModules = {
  readonly credentials: typeof credentialsModule;
  readonly system: ReturnType<typeof systemModule>;
};

/**
 * Build the framework's contribution from the resolved `admin` object. It is
 * built rather than imported because some of its declarations close over
 * configuration: what the surface reports about an application is decided by
 * the operator, and a module-level constant could only report the framework.
 * A module that closes over nothing — what a credential is does not depend on
 * how an application was described — stays a constant and is named here.
 */
export function frameworkFunctionModules(
  admin: AdminOptions = {},
): FrameworkFunctionModules {
  return {
    credentials: credentialsModule,
    system: systemModule(normalizeAdminOptions(admin)),
  };
}
