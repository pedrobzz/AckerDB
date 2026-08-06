# Scopes on Identity

Status: implemented. This document is the contract for AckerDB's built-in
permission primitive: one application scope vocabulary, a grant on every
Identity, a requirement on any function, and identity credentials that make
agents first-class users. Divergences discovered during implementation must
update it.

## The vocabulary

The application declares its scope vocabulary once, in the manifest:

```ts
// app.ts
export default defineApp({
  schema,
  scopes: ["notes:read", "notes:write", "billing:admin"] as const,
});
```

- At most 128 scopes of at most 256 UTF-8 bytes each, unique, non-empty.
- The `studio:*` and `internal:*` prefixes are framework-owned and rejected
  here, so no user scope can collide with or impersonate framework authority.
- Scope strings are opaque to the framework. Patterns such as
  `mcp:<name>:<scope>:<level>` are application conventions, not machinery.
- Codegen emits `type Scope = AppScope<typeof app>` and binds it into the
  generated `query`/`mutation`/`procedure`/`sseProcedure`/`mcp` builders, so
  naming an undeclared scope is a compile error. Startup cross-checks every
  registered requirement against the vocabulary as well, covering untyped
  callers.

## Requirements on functions

Any function may declare a requirement, enforced at the one authorization
funnel (`compileAccess` in `app/invocation.ts`) after its base access policy —
every entry path (client call, HTTP, MCP tool, nested server-side call)
reaches the handler only through that enforcer:

```ts
export const purge = mutation({
  access: "authenticated",
  scopes: { allOf: ["notes:write", "billing:admin"] },
  args: {},
  handler: ...,
});
```

- `anyOf` passes when the caller holds at least one scope; `allOf` requires
  every one. Exactly one of the two.
- `access: "public"` with scopes is a registration error (anonymous callers
  can never hold a scope); `"system"` with scopes is dead configuration and
  equally an error. System authority bypasses scope checks at the funnel — it
  is already the framework's own unrestricted authority.
- An anonymous caller failing a scope check gets `unauthenticated`; an
  authenticated caller without the grant gets `unauthorized`.

MCP tool entries declare the same `{ anyOf | allOf }` shape in their `access`
field, drawn from the same vocabulary. One deliberate difference: a tool entry
is a curation surface, so even system authority passes a scoped entry only
through an explicit local grant.

## Grants on Identity

Every `user` principal carries `scopes: readonly string[]`. Where it comes
from:

- **External accounts** (OIDC or a custom verifier): the application's
  `ScopeResolver` — `(identity, account) => readonly string[]` — configured as
  `scopeResolver` (a module path whose default export is the resolver) in
  `.ackerdb.config.json`, or programmatically as `resolveScopes` on
  `startApp` / `Runtime`. Absent resolver = empty grant. The resolver is
  re-read on every credential verification and auth-epoch transition; when a
  grant changes, publish an account invalidation through the verifier's
  invalidation channel and live sessions re-authorize immediately.
  `account` is `null` when the framework re-derives an issuer's grant for the
  child-credential intersection below.
- **Identity credentials** (below): the credential's effective grant.
- Anonymous and workload principals hold no grant; system bypasses scopes.

## Identity credentials

An issued credential IS an Identity. `credentials.create(ctx, { name, scopes,
metadata })` mints a fresh child Identity whose parent is the calling user;
`systemCredentials.create(ctx, parentIdentity | null, input)` is the
privileged surface and may create **standalone** identities (`null` parent)
whose scopes are granted directly. The returned opaque bearer
(`ackerdb_credential.<id>.<secret>`) is shown exactly once; only its SHA-256
digest is stored, in `_ackerdb_credentials`.

The child-credential invariant is enforced at BOTH ends:

- **Issuance**: `create` and `updateScopes` reject any scope the issuing
  principal's own grant does not currently hold (`unauthorized`), after
  validating the request against the vocabulary (`validation`).
- **Use**: the effective grant is the stored scopes intersected with every
  ancestor's *current* grant up the delegation chain (agents may mint bounded
  sub-credentials; identity creation order keeps the chain acyclic), ending at
  the application resolver for a non-credential root. A parent losing a scope
  narrows all of its children immediately, with no revocation sweep.

Agents are first-class users. A credential bearer authenticates on every
transport — WebSocket sessions, exposed HTTP functions, and MCP endpoints —
through the Runtime's one composed credential authority, producing an
ordinary `user` principal (`issuer: "ackerdb:credentials"`, subject = token
id, non-expiring). A vault-prefixed bearer can never fall through to an
application verifier. Fairness, files ownership, and analytics all key on the
credential's own child Identity.

## Live invalidation

Grant changes ride the one generic auth-invalidation path
(`auth/invalidation.ts`):

- `credentials.revoke` and any `updateScopes` change stage on the write set
  and publish after commit as account invalidations under the synthetic
  `ackerdb:credentials` issuer. Live WebSocket sessions and MCP HTTP leases
  holding that credential are cancelled immediately; the next verification
  reads the new grant.
- Resolver-backed user grants re-authorize through the same path when the
  application publishes an invalidation for the account.

Shipping enforcement without live invalidation would be a security
regression; this propagation is part of the feature's contract, not an
optimization.
