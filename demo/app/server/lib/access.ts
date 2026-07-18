import { DbzzError, type Identity, type Principal } from "@dbzz/server";

export function isStaff(auth: Principal): boolean {
  return auth.kind === "user" && auth.claims.role === "staff";
}

export function ownsIdentity(auth: Principal, identity: Identity): boolean {
  return auth.kind === "user" && auth.identity === identity;
}

export function requireUser(auth: Principal) {
  if (auth.kind !== "user") {
    throw new DbzzError("unauthorized", "A guest account is required");
  }
  return auth;
}

/** Shared staff-only access policy for query/mutation/procedure declarations. */
export const staffAccess = (ctx: { auth: Principal }): boolean =>
  isStaff(ctx.auth);
