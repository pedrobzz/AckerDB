/**
 * The framework's own scope vocabulary, `_admin:<domain>:<verb>`.
 *
 * It is one closed list, declared beside the surface it authorizes and read by
 * `auth/scopes.ts` as the framework half of the known vocabulary. An
 * application never declares one — the reserved marker is what keeps the two
 * halves apart inside the single namespace — so a grant reaches this list only
 * through `_*` or an explicit `_admin:` pattern, and never through a bare `*`.
 *
 * **A domain is what an operator authorizes.** `jobs`, `database`, and `system` are
 * the things a scope screen offers and an agent credential is narrowed to; the
 * category above them is not, so the vocabulary is two levels deep and not
 * three.
 *
 * The list may grow without invalidating anything already issued: a grant
 * expands against the vocabulary known *at the moment of the check*, so a
 * credential minted today covers a domain added tomorrow. That is why this
 * list carries only the domains the surface has decided on, and not every one
 * it may eventually want.
 */

/**
 * Every scope the framework defines. Sorted, because `expandScopeGrant`
 * returns matches in vocabulary order and two equivalent grants should render
 * identically.
 */
export const ADMIN_SCOPES = Object.freeze([
  "_admin:credentials:read",
  "_admin:credentials:write",
  "_admin:database:read",
  "_admin:database:write",
  "_admin:errors:read",
  "_admin:errors:write",
  "_admin:functions:run",
  "_admin:impersonate",
  "_admin:jobs:read",
  "_admin:jobs:write",
  "_admin:system:read",
] as const);

/**
 * One scope from the framework's vocabulary. Admin declarations annotate their
 * requirement with it, so a typo inside the framework is a compile error here
 * rather than a startup refusal in somebody else's application.
 */
export type AdminScope = (typeof ADMIN_SCOPES)[number];
