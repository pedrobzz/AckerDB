# Scopes, wildcards, and identity credentials

Scopes are AckerDB's built-in permission primitive: one vocabulary declared by
the application, a grant on every Identity, a requirement on any function, and
identity credentials that make agents first-class users. Access policies decide
*whether a caller is admitted at all*; scopes decide *what an admitted caller
may reach*. See [Authentication and authorization](authentication.md) for the
first half and [ADR-0025](adr/0025-scopes-and-wildcards-are-the-one-authorization-vocabulary.md)
for why the two are one system.

## The vocabulary

The application declares its scopes once, in the manifest:

```ts
// app.ts
export default defineApp({
  schema,
  scopes: ["notes:read", "notes:write", "billing:admin"] as const,
});
```

- At most 128 scopes, each a non-empty string of at most 256 UTF-8 bytes,
  unique.
- A scope may not contain `*` — the wildcard belongs to grants, never to the
  vocabulary — and may not begin with `_`, which marks the framework's own
  names.
- Scope strings are opaque to AckerDB. Conventions like `<domain>:<verb>` are
  the application's, not machinery.
- Code generation emits `type Scope` and binds it into the generated
  `query`/`mutation`/`procedure`/`sseProcedure`/`mcp` builders, so naming an
  undeclared scope is a compile error. Startup cross-checks every registered
  requirement against the vocabulary as well, which covers untyped callers.

**Two vocabularies, one namespace.** Application scopes carry no `_`; framework
scopes are pre-declared under it and an application may never declare one. That
is what lets `*` mean "every application scope" and `_*` mean "every framework
scope" without either side enumerating the other. The framework's list is the
[Admin API](admin-api.md)'s `_admin:<domain>:<verb>` names; `_*` names it, and
grows with it, because a grant expands against the vocabulary known at the
moment of the check.

An application may not *require* a framework scope either. The generated `Scope`
union refuses one at compile time, and startup refuses a `_`-prefixed scope on
any function or MCP tool entry the framework does not own — including one your
application published in the `admin` group, since publishing beside the
framework's functions does not make a function the framework's.

## Requirements on functions

Any function may declare a requirement, enforced at the one authorization funnel
after its access policy — every entry path (client call, HTTP, MCP tool, nested
server-side call) reaches the handler only through that enforcer:

```ts
export const purge = mutation({
  access: "authenticated",
  scopes: { allOf: ["notes:write", "billing:admin"] },
  args: {},
  handler: ...,
});
```

- `anyOf` passes when the caller holds at least one of the scopes; `allOf`
  requires every one. Exactly one of the two.
- A requirement names **concrete** scopes. A wildcard there is a declaration
  error: it would ask a reader to hold the vocabulary in their head to know what
  the function admits.
- `access: "public"` with scopes is a registration error — an anonymous caller
  can never hold a scope. `"system"` with scopes is equally an error, because
  system authority bypasses scopes at the funnel and the rule would silently
  never fire.
- An anonymous caller failing a scope check gets `unauthenticated`; an
  authenticated caller without the grant gets `unauthorized`.

MCP tool entries declare the same `{ anyOf | allOf }` shape in their `access`
field, drawn from the same vocabulary. One deliberate difference: a tool entry
is a curation surface, so even system authority passes a scoped entry only
through an explicit local grant.

**What a local delegation grants.** `mcp.aiTools(ctx, { scopes })` is
application code handing a model a curated tool set, and the scopes it names are
a literal in that code — never caller input. So for an ordinary user the
delegation carries the *application's* authority: the procedure has already
passed its own access policy, and what it then lends the model is its decision,
exactly as calling the function directly would be. For a **credential-backed**
caller the delegation is intersected with that credential's own grant, because
such a caller is itself a delegate and the child invariant must not be
sidesteppable through the AI adapter. Authority never exceeds its source; for an
external user the source is the application, and for a credential it is the
credential.

## Grants and wildcards

A grant is a set of **patterns**. A pattern is either a concrete scope or a
prefix followed by exactly one trailing `*`:

| Pattern | Expands to |
| --- | --- |
| `notes:read` | that scope, if it is declared |
| `notes:*` | every known scope starting with `notes:` |
| `ad*` | every known scope starting with `ad` |
| `*` | every application scope, and no framework scope |
| `_*` | every framework scope |
| `["*", "_*"]` | everything — this, and nothing else, is an administrative identity |

The bare `*` carve-out is the only special case. Every other pattern excludes
the framework's half on its own, because a prefix that does not begin with `_`
cannot match a name that does.

**Checking is expansion, then membership.** A holder's patterns are expanded
against the currently known vocabulary and the requirement is tested against the
result. Expansion happens once, when the principal is built, so the funnel does
a plain membership test per call.

Two consequences follow from expanding against the *current* vocabulary:

- A pattern matching nothing grants nothing. Authority is what a grant expands
  to, never what it says.
- A wildcard covers scopes declared after the credential was minted. That is the
  point of it, and it is why a *concrete* entry is held to a stricter rule: it
  must already name a declared scope, because a name nothing answers to is a
  typo rather than a claim on the future.

There is no `admin: true`. An administrative identity holds `["*", "_*"]`;
creating another is creating another identity with those two patterns.

### The Admin Credential

A **root** credential — one with no parent — whose stored grant is exactly those
two patterns is the [Admin Credential](admin-api.md#the-admin-credential). That
is the whole definition, it lives in the vault, and every path that asks the
question calls it: boot-mint, `admin.credentials.*`, and `acker credential
reset`. Two things follow from the shape of the test:

- It is on the patterns **as written**, not on what they expand to. A grant that
  happens to cover today's vocabulary stops covering it the moment a scope is
  declared, and a credential's kind must not change because an application grew.
- A **child** holding the same patterns is not one. Its live authority is
  intersected with its parent's, so it is bounded by a master rather than being
  one; counting it would make a rotation revoke credentials that never were.

## Grants on Identity

Every `user` principal carries `scopes: readonly string[]` — the expanded grant.
Where the patterns come from:

- **External accounts** (OIDC or a custom verifier): the application's
  `ScopeResolver` — `(identity, account) => readonly string[]` — configured as
  `scopeResolver` (a module path whose default export is the resolver) in
  `.ackerdb.config.json`, or programmatically as `resolveScopes` on `startApp` /
  `Runtime`. An absent resolver means the empty grant. The resolver is re-read on
  every credential verification and auth-epoch transition; when a grant changes,
  publish an account invalidation through the verifier's invalidation channel and
  live sessions re-authorize immediately. `account` is `null` when the framework
  re-derives an issuer's grant for the child-credential intersection below.
- **Identity credentials** (below): the credential's effective grant.
- Anonymous and workload principals hold no grant; system bypasses scopes.

## Identity credentials

An issued credential **is** an Identity. `credentials.create(ctx, { name,
scopes, metadata })` mints an Identity whose parent is the calling user;
`systemCredentials.create(ctx, parentIdentity | null, input)` is the privileged
surface and may create **standalone** identities (`null` parent) whose grants
come straight from the vocabulary — which is how an administrative `["*", "_*"]`
credential is minted without any identity holding that authority first. The
returned opaque bearer (`ackerdb_credential.<id>.<secret>`) is shown exactly
once; only its SHA-256 digest is stored, in `_ackerdb_credentials`.

The child invariant is enforced at BOTH ends:

- **Issuance**: `create` and `updateScopes` expand the request and reject any
  scope the issuing principal's own expanded grant does not currently hold
  (`unauthorized`), after validating the request's shape and its concrete
  entries against the vocabulary (`validation`).
- **Use**: the effective grant is the credential's expansion intersected with
  every ancestor's *current* expansion up the delegation chain (agents may mint
  bounded sub-credentials; Identity creation order keeps the chain acyclic),
  ending at the application resolver for a non-credential root. A parent losing
  a scope narrows all of its descendants immediately, with no revocation sweep.

**Revoking a credential revokes everything delegated beneath it.** The cascade
is the invariant rather than a convenience: a surviving child of a revoked
parent would have no source left to be bounded by, and — because an Identity
with no credential row reads as an ordinary application root — it would be
resolved by the application's own scope resolver instead of failing closed.

Agents are first-class users. A credential bearer authenticates on every
transport — WebSocket sessions, exposed HTTP functions, and MCP endpoints —
through the Runtime's one composed credential authority, producing an ordinary
`user` principal (`issuer: "ackerdb:credentials"`, subject = token id,
non-expiring). A vault-prefixed bearer can never fall through to an application
verifier. Fairness, File ownership, and analytics all key on the credential's own
Identity, and a credential cannot be linked as an external account onto another
Identity.

Limits live in `limits.credentials`: `maxPerIdentity`, `maxNameBytes`,
`maxMetadataBytes`.

## Live invalidation

Grant changes ride the one generic auth-invalidation path (`auth/invalidation.ts`):

- `credentials.revoke` and any `updateScopes` change stage on the write set and
  publish after commit as account invalidations under the synthetic
  `ackerdb:credentials` issuer. Live WebSocket sessions and HTTP leases holding
  that credential are cancelled immediately; the next verification reads the new
  grant.
- **The caller that made the change is the one exception, and only until its
  answer has left.** A commit carries the originating principal's own
  subscription, and an invalidation naming that principal is withheld from it
  until the transport has handed off the response — the same deferral
  `ctx.unlinkAccount` uses. Without it, revoking the credential you are
  authenticated with would close the connection carrying the result from inside
  your own commit: on a WebSocket the session terminates before the result
  frame, and on the MCP endpoint the tool call's own signal aborts. Every other
  holder is still cancelled at commit, and the origin follows immediately after.
  Every subscriber is addressable, so no door is exempt from the exclusion.
- One change publishes for **every credential it reaches** — the credential
  itself and every credential delegated beneath it. A descendant's live session
  matches on its own token id, so publishing only for the changed credential
  would leave a descendant holding an authority its source no longer has, and a
  vault principal never expires out of it.
- Resolver-backed user grants re-authorize through the same path when the
  application publishes an invalidation for the account.
- An **external** identity's grant change reaches the credentials delegated
  from it too. A delegate is live under `ackerdb:credentials` with its own
  subject, so nothing about its account resembles the external one — it
  therefore carries that account, recorded when its lineage was walked at
  authentication. Matching an ancestor then costs a comparison, where resolving
  one would cost an Engine read on a channel that must stay synchronous.
  An invalidation naming an exact `tokenId` is the one that does not travel
  down the lineage: it names a single credential, and a descendant is another.

Shipping enforcement without live invalidation would be a security regression;
this propagation is part of the feature's contract, not an optimization.
