/**
 * Child credentials: agents as first-class identities.
 *
 * An issued credential is an Identity like any user, in one of two shapes: a
 * standalone identity with no parent, whose grant comes straight from the
 * vocabulary, or a child issued *by* a parent Identity — the "mint a token for
 * my agent" flow. The child invariant is that a child's authority is a subset
 * of its parent's, never more, and it is enforced at BOTH ends:
 *
 * - **Issuance** (`issueChildScopes`): the requested patterns must expand
 *   inside the issuer's own expansion. A parent cannot mint authority it does
 *   not hold. Issuance-only enforcement would leave a window where a child
 *   keeps authority its parent lost.
 * - **Use** (`effectiveChildScopes`): the child's live grant is its expanded
 *   patterns intersected with its parent's *current* expanded grant, computed
 *   when the principal is built. A parent losing a scope narrows every child
 *   immediately, with no revocation sweep. Use-only enforcement would make
 *   over-issuance silently representable.
 *
 * Both ends compare expanded sets, so wildcards change nothing about the
 * invariant's shape. The child keeps its patterns rather than the expansion:
 * that is what lets `notes:*` cover a scope declared after issuance — bounded
 * at use by the parent's own expansion of the same day.
 */
import { AckerDBError } from "../shared/errors.ts";
import { expandScopeGrant, isScopeGrant } from "./scopes.ts";

/** Issuance-time subset enforcement: a parent can only delegate what it holds. */
export function issueChildScopes(
  parentScopes: readonly string[],
  requestedPatterns: readonly string[],
  vocabulary: readonly string[],
): readonly string[] {
  if (!isScopeGrant(requestedPatterns)) {
    throw new AckerDBError("validation", "requested child scopes must be a valid scope grant");
  }
  const parent = new Set(parentScopes);
  for (const scope of expandScopeGrant(requestedPatterns, vocabulary)) {
    if (!parent.has(scope)) {
      throw new AckerDBError(
        "unauthorized",
        `cannot delegate scope ${JSON.stringify(scope)}: the issuing identity does not hold it`,
      );
    }
  }
  return Object.freeze([...requestedPatterns]);
}

/**
 * Use-time narrowing: the child's live grant is its expanded scopes ∩ the
 * parent's current expanded scopes. Both arguments are already expanded, so
 * this is a plain intersection — a standalone identity passes its own grant as
 * both, where the intersection is the identity function.
 */
export function effectiveChildScopes(
  childScopes: readonly string[],
  parentScopes: readonly string[],
): readonly string[] {
  const parent = new Set(parentScopes);
  return Object.freeze(childScopes.filter((scope) => parent.has(scope)));
}
