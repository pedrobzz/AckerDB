/**
 * Child credentials: agents as first-class identities (prototype sketch).
 *
 * When MCP tokens become identities, an agent token is no longer a parallel
 * principal kind — it is an Identity like any user, with two possible shapes:
 *
 * 1. **Standalone agent identity**: an Identity with no parent. Its scopes
 *    are granted directly (by system authority or an admin flow) from the
 *    application vocabulary. It authenticates with an issued credential and
 *    dispatches through the exact same choke point as a user. Nothing about
 *    it is special at enforcement time.
 *
 * 2. **Child of a user**: an Identity issued *by* a parent Identity (the
 *    "create a token for my agent" flow — today's `mcpAuth` token UX). The
 *    invariant: a child's scopes are a SUBSET of its parent's, never more.
 *
 * ## Where the subset invariant is enforced — decision
 *
 * At BOTH issuance and use:
 *
 * - **Issuance** (`issueChildScopes`): requesting a scope the parent does not
 *   hold is a typed `unauthorized` error. This is the UX boundary — the
 *   parent cannot mint authority it does not have.
 * - **Use** (`effectiveChildScopes`): the child's effective grant is the
 *   intersection of its stored scopes with the parent's CURRENT scopes,
 *   computed when the principal is built at authentication time. When the
 *   parent later loses a scope, every child narrows immediately and
 *   silently — authority can only ever shrink downstream, never outlive its
 *   source. This replaces today's MCP `scopes_reduced` invalidation push
 *   (mcp/token-invalidation.ts) for the *narrowing* case: no live-lease
 *   cancellation is needed to remove a scope, because the next enforcement
 *   reads the intersection. Revocation of the credential itself still
 *   invalidates live leases, exactly as MCP revocation does today.
 *
 * Issuance-only enforcement was rejected: it leaves a window where a child
 * keeps authority its parent lost, which inverts the delegation invariant.
 * Use-only enforcement was rejected: it makes over-issuance silently
 * representable and pushes the error to a confusing later moment.
 *
 * Storage sketch (not built here): today's `_ackerdb_mcp_tokens` table
 * becomes `_ackerdb_credentials` — token_id, identity (the CHILD identity,
 * new per token), parent_identity (nullable: null = standalone), secret
 * digest, name, metadata, scopes, timestamps. Issuance UX
 * (`ctx.credentials.create(...)`), secret hashing, and revocation move from
 * mcp/token-vault.ts + mcp/token-context.ts into this auth/ neighborhood
 * unchanged in mechanism.
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
