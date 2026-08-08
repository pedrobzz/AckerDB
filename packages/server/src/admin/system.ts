/**
 * `admin.system.info` — what the application is, answered by the application.
 *
 * An operator's client is reached through whatever proxy or load balancer sits
 * in front of it, so its own origin names that hop and not this server. The
 * welcome frame describes authentication and nothing else, and extending it
 * would put a per-connection cost on every client for a fact one screen reads
 * once. A bespoke health route would put it outside the one authorization
 * funnel. So it is an ordinary Admin API query: addressed, scoped, and served
 * by the same machinery as everything else.
 */
import { PROTOCOL_VERSION, type AdminSystemInfo } from "@ackerdb/core";
import { ADMIN_API_PATH } from "@ackerdb/core";
import { query } from "../app/functions.ts";
import type { ScopeRequirement } from "../auth/scopes.ts";
import { ACKERDB_VERSION } from "../shared/version.ts";
import { v } from "../validation/v.ts";
import type { AdminScope } from "./scopes.ts";
import type { NormalizedAdminOptions } from "./options.ts";

/**
 * The framework's declarations are values, not files, so the module the
 * Registry composes is built from the resolved `admin` object rather than read
 * off a directory. That is the whole of the difference between the framework's
 * contribution and the application's.
 */
export function systemModule(admin: NormalizedAdminOptions) {
  const info = query({
    apiPath: ADMIN_API_PATH,
    // Callable, and absent from the document. Every exposed function is walked
    // into `/_openapi.json`, and publishing the whole administrative surface
    // to anyone who can fetch a schema is a map for a caller who has no grant
    // and cannot use it. `openapi: false` is the exposure field that already
    // says exactly this.
    http: { openapi: false },
    title: "Server information",
    description: "Identifies the application and the AckerDB version serving it.",
    // Authenticated plus a scope, which is the only shape an admin function
    // can have: a scope requirement contradicts "public" and is dead under
    // "system", so both are refused at declaration. The funnel then answers an
    // ungranted caller `unauthorized` and an anonymous one `unauthenticated`.
    access: "authenticated",
    scopes: { anyOf: ["_admin:system:read"] } satisfies ScopeRequirement<AdminScope>,
    args: {},
    returns: v.object({
      name: v.string(),
      version: v.string(),
      ackerdb: v.string(),
      protocol: v.int(),
    }),
    handler: (): AdminSystemInfo => ({
      name: admin.application.name,
      version: admin.application.version,
      ackerdb: ACKERDB_VERSION,
      protocol: PROTOCOL_VERSION,
    }),
  });
  return { info };
}
