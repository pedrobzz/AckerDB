/**
 * Compile-time assertions that the Admin API core publishes and the Admin API
 * the server declares are the same surface. Never executed — `bun run
 * typecheck` failing is the test.
 *
 * The tree lives in `@ackerdb/core` because a client package must be able to
 * import it, and the declarations live here because only the server can make
 * them. Two files, therefore, and this is what keeps them one contract: a leaf
 * added, renamed, or retyped on either side fails the build.
 */
import type { AdminApi, AdminApiPath, ApiFromModules } from "@ackerdb/core";
import type { FrameworkFunctionModules } from "../../src/admin/index.ts";

type DeclaredAdminApi = ApiFromModules<FrameworkFunctionModules, AdminApiPath>;

declare const declared: DeclaredAdminApi;
declare const published: AdminApi;

// Everything the framework declares is in the tree clients address.
declared satisfies AdminApi;
// Everything clients address is something the framework declares.
published satisfies DeclaredAdminApi;
