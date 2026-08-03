import { AckerDBError, type Identity, type Principal } from "@ackerdb/server";

export function isStaff(auth: Principal): boolean {
  return auth.kind === "user" && auth.claims.role === "staff";
}

export function ownsIdentity(auth: Principal, identity: Identity): boolean {
  return auth.kind === "user" && auth.identity === identity;
}

export function requireUser(auth: Principal) {
  if (auth.kind !== "user") {
    throw new AckerDBError("unauthorized", "A guest account is required");
  }
  return auth;
}

/** Shared staff-only access policy for query/mutation/procedure declarations. */
export const staffAccess = (ctx: { auth: Principal }): boolean =>
  isStaff(ctx.auth);

/**
 * Access policy for the functions the Admin MCP publishes as tools.
 *
 * A tool is an ordinary registered function now, so it also carries a client
 * address, and this policy is what a client call is judged by: staff only,
 * exactly like the staff mutations these tools reuse.
 *
 * The `mcp` arm is what lets the endpoint serve them. An MCP credential can
 * never reach a client call path — the runtime rejects an `mcp` principal at
 * every HTTP and session entrypoint — so it only ever arrives here through
 * `tools/call`, which has already checked the token's scopes against the
 * `access` the endpoint declares for that tool. Admitting it grants nothing
 * the endpoint has not already authorized; refusing it would deny every
 * external agent host while the in-app chat (a staff user) still worked.
 */
export const adminToolAccess = (ctx: { auth: Principal }): boolean =>
  ctx.auth.kind === "mcp" || isStaff(ctx.auth);
