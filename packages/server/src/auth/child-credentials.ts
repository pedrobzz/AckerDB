/**
 * Child credentials: agents as first-class identities.
 *
 * An issued credential is an Identity like any user, in one of two shapes:
 * a standalone identity with no parent whose scopes are granted directly
 * from the application vocabulary, or a child issued *by* a parent Identity
 * (the "create a token for my agent" flow). The child invariant: a child's
 * scopes are a SUBSET of its parent's, never more — enforced at BOTH
 * issuance and use.
 *
 * - **Issuance** (`issueChildScopes`): requesting a scope the parent does not
 *   hold is a typed `unauthorized` error — the parent cannot mint authority
 *   it does not have. Issuance-only enforcement would leave a window where a
 *   child keeps authority its parent lost.
 * - **Use** (`effectiveChildScopes`): the child's effective grant is the
 *   intersection of its stored scopes with the parent's CURRENT scopes,
 *   computed when the principal is built at authentication time. A parent
 *   losing a scope narrows every child immediately — authority never
 *   outlives its source, with no revocation sweep. Use-only enforcement
 *   would make over-issuance silently representable.
 */
import { AckerDBError } from "../shared/errors.ts";
import { isScopeGrant } from "./access-policy.ts";

/** Issuance-time subset enforcement: a parent can only delegate what it holds. */
export function issueChildScopes(
  parentScopes: readonly string[],
  requestedScopes: readonly string[],
): readonly string[] {
  if (!isScopeGrant(requestedScopes)) {
    throw new AckerDBError("validation", "requested child scopes must be a valid scope grant");
  }
  const parent = new Set(parentScopes);
  for (const scope of requestedScopes) {
    if (!parent.has(scope)) {
      throw new AckerDBError(
        "unauthorized",
        `cannot delegate scope ${JSON.stringify(scope)}: the issuing identity does not hold it`,
      );
    }
  }
  return Object.freeze([...requestedScopes]);
}

/**
 * Use-time narrowing: the child's live grant is its stored scopes ∩ the
 * parent's current scopes. Standalone agents pass their own scopes as both
 * arguments (the intersection is the identity function).
 */
export function effectiveChildScopes(
  storedChildScopes: readonly string[],
  parentCurrentScopes: readonly string[],
): readonly string[] {
  const parent = new Set(parentCurrentScopes);
  return Object.freeze(storedChildScopes.filter((scope) => parent.has(scope)));
}
