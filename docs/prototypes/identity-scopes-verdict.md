# Scopes on Identity — prototype verdict (wayfinder #214)

Branch: `prototype/identity-scopes`. Question: should scopes become a
first-class Identity capability — declared once in `defineApp`, carried by
every principal, declarable by any function — replacing the MCP-local scope
concept, with MCP tokens becoming identities?

**Recommendation: simplifies-and-adds-a-feature — conditional on rebuilding
grant invalidation generically.** Reasons at the end; numbers first.

## What was built (all measured, typechecked, smoke-tested)

- `defineApp({ scopes: [...] as const })` vocabulary with reserved-namespace
  rejection (`studio:*`, `internal:*`) — `packages/server/src/app/definition.ts`,
  validation in `packages/server/src/auth/access-policy.ts`.
- `UserPrincipal.scopes: readonly string[]` (anonymous/system carry none),
  resolved by an optional `ScopeResolver` riding the existing
  `resolveIdentity` seam — `packages/server/src/auth/credentials.ts`,
  `auth/lease.ts`, `subscriptions/session/{contract,session}.ts`.
- `scopes: { anyOf | allOf }` on `query`/`mutation`/`procedure`/`sseProcedure`
  definitions, enforced at the ONE existing dispatch choke point
  (`compileAccess` in `packages/server/src/app/invocation.ts`) — every entry
  path (client call, HTTP, MCP tool, nested server-side call) already funnels
  through it, so enforcement is a compile-once wrapper, not a new layer.
  `"public"`/`"system"` + scopes is a registration error.
- Typed vocabulary sketch: `AppScope<typeof app>` union; the four builder
  aliases (`QueryBuilder` et al.) gained a `Scope` parameter codegen binds,
  so an undeclared scope is a compile error — same guarantee `mcpAuth`
  scopes give today, now app-wide.
- Child-credential subset invariant — `packages/server/src/auth/child-credentials.ts`:
  enforced at BOTH issuance (typed `unauthorized` on over-delegation) and use
  (effective grant = stored ∩ parent-current, so a parent losing a scope
  narrows every child immediately; authority never outlives its source).
  Standalone agent = identity with no parent, scopes granted directly, same
  choke point as users. Note: `effectiveGrant` at `mcp/ai.ts:251` is already
  this exact intersection — the invariant exists in MCP today, unnamed.
- MCP scope machinery unified onto the shared module: `mcp/scopes.ts` now
  imports grant validation from `auth/access-policy.ts` and its
  `McpToolAccessPolicy` is literally `"public" | "authenticated" |
  ScopeRequirement<Scope>`.

Smoke-tested end to end: scoped query passes with grant, denies without
(`unauthorized`), anonymous fails `unauthenticated`, `public`+scopes rejects
at registration, reserved namespaces reject in `defineApp`, subset invariant
holds at issuance and use.

## (a) LoC — added by seam vs deletable by unification

Prototype diff vs `origin/main`: **+456 / −42 across 12 files** (a large
fraction of insertions is inline design documentation; mechanical code is
roughly half).

| Seam (added) | + | − |
| --- | --- | --- |
| `auth/access-policy.ts` (new shared module) | 177 | 0 |
| `auth/child-credentials.ts` (new, subset invariant) | 82 | 0 |
| `app/functions.ts` (builders declare `scopes`) | 56 | 3 |
| `auth/credentials.ts` (principal scopes + resolver) | 38 | 7 |
| `app/invocation.ts` (choke-point enforcement) | 33 | 2 |
| `app/definition.ts` (defineApp vocabulary) | 29 | 3 |
| `mcp/scopes.ts` (unification, first deletions land) | 16 | 25 |
| `index.ts`, `lease.ts`, session contract, vault import | 23 | 2 |

Deletable if MCP tokens become identities (inventory below): **~565 lines
die; ~610 more relocate from `mcp/` to `auth/`** where they serve every
credential rather than one protocol. Net direction: the full feature is
roughly LoC-neutral in mechanical code (+~450 real code incl. the grant
storage/invalidation work below, −~565), while deleting an entire parallel
authority system and its concepts (`mcpAuth` provider, `McpPrincipal`,
per-endpoint scope descriptors).

## MCP unification inventory (what dies, what remains)

Dies outright (~565 lines):

- `mcp/auth.ts` (112 lines, whole file): the `mcpAuth` provider concept —
  per-provider scope vocabularies are replaced by the app vocabulary; token
  operations become generic credential operations.
- `mcp/scopes.ts` (~140 of 141 remaining lines): `createMcpScopeDescriptor`
  + `normalizeMcpScopeGrant` (47–94 pre-prototype) die into `defineApp`
  validation; `normalizeMcpToolAccess` (96–135) dies into the same
  registration validation functions use (`scopeFields`,
  `app/functions.ts`); `isMcpToolAuthorized` dies into `isScopeAuthorized`
  + the choke point.
- `auth/credentials.ts:51–57, 97–107` (~20): `McpPrincipal` and its
  `isPrincipal` branch — MCP callers become ordinary identity principals.
  Seven `kind === "mcp"` branch sites simplify one union member each
  (`runtime/caller.ts:42`, `runtime/http/runtime.ts:512`,
  `runtime/sessions/store.ts:158`, `subscriptions/session/session.ts:648`,
  `files/namespace.ts:100`, `files/procedure.ts:30`,
  `telemetry/application-signals/application-signals.ts:45`).
- `mcp/token-vault.ts` (~110 of 440): per-endpoint `scopeDescriptor`
  plumbing — `descriptor()` cross-validation (169–196), `updateScopes`
  (364–398), `authenticate` descriptor normalization (413–439 partial).
- `mcp/token-context.ts` (~40 of 284): provider-name keying and descriptor
  parameters.
- `mcp/token-invalidation.ts` (~35 incl. staging at
  `token-context.ts:222–228`): the `scopes_reduced` push — use-time
  intersection replaces it for narrowing (see risk #1).
- `mcp/ai.ts:174–194, 251–258` (~35): `withMcpLocalAuthority` /
  `mcpLocalGrant` / `effectiveGrant` — subsumed by `effectiveChildScopes`.
- `runtime/mcp/runtime.ts` (~65): `verifyToken` + provider lookup
  (281–322) become the generic credential-authentication path;
  `authorizeTool` provider-match and explicit-grant plumbing (152–194
  partial) collapse into the standard choke point.

Remains, relocated to `auth/` (~610 lines): the credential vault mechanism —
secret hashing, timing-safe verification, CRUD, capacity
(`token-vault.ts` ~330), the `ctx.credentials` issuance/administration UX
(`token-context.ts` ~245), opaque-token prefix parsing
(`mcp/credential.ts` 36), revocation live-lease cancellation
(`McpTokenInvalidationBoundary`, the `revoked` half). Schema: the
`_ackerdb_mcp_tokens` table gains `parent_identity` (nullable) and each
token mints a child Identity — a real migration.

## (b) Seams touched

**8 built** (manifest, builders, choke point, principal shape, lease,
session re-auth contract, MCP scope module, public exports).
**4 identified, deliberately not built**: `RuntimePort` implementation
plumbing of `resolveScopes` through `runtime/runtime.ts` + serve config;
load-time vocabulary cross-check where App meets Registry
(`checkRequirementAgainstVocabulary` is written, the CLI manifest call site
is not); MCP tool entries adopting function-level scopes; codegen actually
instantiating builders with `AppScope`.

## (c) Invariants at risk

1. **Grant-change propagation (the load-bearing one).** Today MCP pushes
   `scopes_reduced` invalidation to live leases. The unified model reads
   grants at credential verification, so an admin revoking a scope reaches
   live sessions/leases only at the next auth-epoch / token expiry. The
   deletion of the push machinery is only safe if grant changes join the
   generic auth-invalidation path (`auth/invalidation.ts`) or the staleness
   window is an explicit accepted contract. Skipping this silently is a
   security regression, not a simplification.
2. **Subscriber principal + auth-epoch.** Scopes ride the principal, so
   auth-epoch transitions re-resolve them and reactive re-execution
   enforces against the session principal — correct by construction, but
   only once `resolveScopes` is plumbed into the `RuntimePort`
   implementation (contract seam done, implementation not).
3. **Plugin authority is explicit-pass-only.** Plugin builders share
   `register()`; a plugin declaring `scopes` would name scopes from a host
   vocabulary it cannot know. Needs a decision: forbid scopes in plugin
   builders, or namespace them per mount. Unresolved.
4. **Parent-loses-scope.** Decided: subset enforced at issuance AND use
   (intersection with parent-current), so children narrow instantly and
   never outlive parental authority; subject to risk #1 for live leases.
5. **Anonymous / system.** Anonymous holds the empty grant and
   `public`+scopes is unrepresentable-by-registration; system bypasses
   scopes (it is already unrestricted framework authority) — both are
   deliberate, documented decisions, not gaps.
6. **Principal hardening ripple.** `UserPrincipal.scopes` is required
   (no back-compat by policy): src compiles clean; 10 type errors across 9
   test files, each a one-line `scopes: []` fixture fix.

## (d) The verdict

**Simplifies-and-adds-a-feature**, on three load-bearing observations:

1. **The choke point already existed.** Authorization has exactly one
   funnel (`compileAccess`), so app-wide scopes cost a compile-once wrapper
   (+33 lines at that seam) instead of a new enforcement layer — the
   riskiest part of a permission system was already paid for.
2. **The parallel system is mostly duplication.** ~565 lines of MCP-local
   scope machinery are re-derivable from the shared shape (the prototype
   already deleted 25 of them just by unifying the module), and the subset
   invariant MCP needs (`effectiveGrant`) is the same three-line
   intersection users need for agent tokens. One vocabulary, one
   requirement shape, one evaluator.
3. **The honest price is invalidation, not enforcement.** The condition on
   this verdict: rebuild grant-change propagation generically (risk #1) and
   migrate the token table to identity-bearing children. If that work is
   cut, the unification trades a working security property for LoC — do it
   whole or keep MCP scopes local.
