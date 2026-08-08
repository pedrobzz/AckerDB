# The Admin API

The Admin API is the built-in administration surface every AckerDB application
carries: functions the framework declares itself, in a group it publishes on
every application's behalf, authorized by a vocabulary of its own. It is the
server side of administration, named for what it does rather than for any client
that consumes it — Studio is one such client, not its owner.

There is no administrative transport, no second registry, and no private
side-channel. An admin function is an ordinary registered function: it has an
address, a route, an access policy, a scope requirement, and it is dispatched
through the same funnel as everything you write. See
[ADR-0026](adr/0026-administration-is-a-first-class-surface.md) for why.

## The `admin` group

A function's address begins with its API path, so the framework's functions
begin with `admin`:

| binding | address | HTTP route | scope |
| --- | --- | --- | --- |
| `admin.credentials.list` | `admin.credentials.list` | `/admin/credentials/list` | `_admin:credentials:read` |
| `admin.credentials.rotate` | `admin.credentials.rotate` | `/admin/credentials/rotate` | `_admin:credentials:write` |
| `admin.system.info` | `admin.system.info` | `/admin/system/info` | `_admin:system:read` |

The group carries no reserved marker, because a group's name becomes a
generated binding and the marker is reserved against exactly that. What makes
the surface unsquattable is the address rule itself ([ADR-0023](adr/0023-api-paths-group-function-addresses.md)):
your `functions/system.ts` exporting `info` publishes `api.system.info`, which
is a different function from `admin.system.info`. Naming the framework's group,
module, and export at once is the only way to collide, and the one address space
refuses that at startup rather than replacing the declaration.

**`admin` is never listed in a manifest.** Like `"api"`, every application
publishes it, so `defineApp({ apiPaths: ["admin"] })` is a declaration error —
listing it would emit the binding twice into one generated file.

### Publishing your own functions there

The group is shared, not sealed. A function of yours may declare it:

```ts
// functions/ops.ts
export const audit = query({
  apiPath: "admin",
  http: true,
  access: "authenticated",
  scopes: { anyOf: ["ops:audit"] },
  args: {},
  handler: async (ctx) => ctx.db.auditLog.query().take(100),
});
```

That publishes `admin.ops.audit` at `/admin/ops/audit`. It requires **your**
scope. Publishing a function beside the framework's does not make it the
framework's, so it may not require an `_admin:` scope — see below.

## Scopes

Every admin function declares its requirement from the framework's own
vocabulary, `_admin:<domain>:<verb>`:

```
_admin:credentials:read  _admin:credentials:write
_admin:database:read     _admin:database:write
_admin:errors:read       _admin:errors:write
_admin:functions:run     _admin:impersonate
_admin:jobs:read         _admin:jobs:write
_admin:logs:read         _admin:system:read
_admin:traces:read
```

A domain is what an operator authorizes — `logs`, `jobs`, `database` — so the
vocabulary is two levels deep and not three. The list may grow: a grant expands
against the vocabulary known *at the moment of the check*, so a credential
minted today covers a domain added tomorrow.

**An application never declares an admin scope, and never requires one.**
`defineApp({ scopes })` refuses any name beginning with `_`, and startup refuses
a `_`-prefixed scope on any function or MCP tool entry the framework does not
own. The generated `Scope` union already refuses it at compile time; the startup
check is what closes the same hole for an untyped declaration, because a rule
the type system holds and the runtime does not is a rule with a hole in it.

**An administrative identity is one holding `["*", "_*"]`** — nothing more. A
bare `*` deliberately excludes every reserved name, so the most generous
application grant reaches no admin function at all. See [Scopes and identity
credentials](scopes.md).

## What "inert" means

Every admin function is registered in every application, and none of them
performs any work or discloses any data without a grant covering its scope:

- `access` is `"authenticated"` and the declaration carries `scopes`. That is
  the only shape available — a scope requirement contradicts `"public"` and is
  dead under `"system"`, so both are declaration errors.
- The one authorization funnel answers an anonymous caller `unauthenticated`
  (HTTP 401) and an authenticated caller without the grant `unauthorized`
  (HTTP 403). Never `not_found`: the route is live, and saying otherwise would
  be a lie a caller cannot act on.
- Framework-declared admin functions carry `http: { openapi: false }`. They are
  callable over plain HTTP and absent from `GET /_openapi.json`, so fetching the
  schema does not hand out a map of the administrative surface.

**It does not mean unlistable.** A live route answers `401` or `403` where an
absent one answers `404`, so a caller who guesses an address learns whether it
exists — and this page names the addresses anyway. That is deliberate: answering
*not found* for a route that is there would be a lie a caller cannot act on.
Arguments are also validated before the scope requirement is enforced, as they
are for every function in the framework, because an access policy callback
receives validated arguments — so an authenticated caller holding no admin scope
can learn an admin function's argument shape from a validation error. What no
caller without a grant can do is reach a handler, read a row, or change
anything.

## Typed references

The framework's declarations are statically known, so they do not go through
your code generation. Their reference tree ships from `@ackerdb/core`:

```ts
import { adminApi } from "@ackerdb/core";

const info = await client.query(adminApi.system.info, {});
```

Generated `_generated/api.ts` re-exports that tree as its `admin` binding,
intersected with whatever your application published into the group:

```ts
import { admin } from "./_generated/api.ts";

admin.system.info;   // the framework's, typed from @ackerdb/core
admin.ops.audit;     // yours, typed from your module
```

Both forms name one address. A package with no application of its own — an
operator's tool, or Studio — imports `adminApi` directly and gets exactly the
same typed references, which is the reason the tree lives in core rather than
being generated per application.

## Configuration

Everything administrative is configured in one `admin` object, in
`.ackerdb.config.json`:

```json
{
  "admin": {
    "application": {
      "name": "savoria-eu",
      "version": "2.1.0"
    }
  }
}
```

`admin.application` is what the surface calls this application. It defaults to
the application package's own `name` and `version`, then to the app directory's
name and `0.0.0`. The same values are the OpenAPI document's title and version,
resolved once, so an application never has two names.

## The Admin Credential

Administration authenticates with an ordinary identity credential — a random
secret, only its SHA-256 digest stored, presented as `Authorization: Bearer` —
that happens to hold the administrative grant. There is no second auth story:
the vault verifier exists whether or not an application configures one, so this
works on an application with **no authentication authority at all**, which is
what makes `acker dev` zero-config.

What makes one is defined once, in the vault: a root credential whose stored
patterns are exactly `["*", "_*"]`. See
[Scopes and identity credentials](scopes.md#the-admin-credential).

### Boot-mint

A server whose vault holds no Admin Credential issues one during startup and
prints the plaintext, once:

```
[ackerdb] Admin Credential kJ8nQ2wR7pL4vX1cB9tY3a issued — copy it now, it is shown once:
[ackerdb] ackerdb_credential.kJ8nQ2wR7pL4vX1cB9tY3a.<secret>
```

Copy it and paste it into the connect screen. Only the digest is stored, so no
later command can show it again — `acker credential reset` below is the recourse.

A start that finds a master already there prints nothing and writes nothing: the
existence test is the same one the reset uses, and a boot with nothing to do
touches no rows. A start that *cannot* issue one **fails**. A server nobody can
administer, that printed nothing to say so, is discovered at the moment
administration is needed most; the message names `acker credential reset` as the
way out.

### Rotation

`admin.credentials.rotate` issues a new Admin Credential and revokes every
credential that was administrative before the mint, in one transaction:

```ts
const { id, token } = unwrap(await client.mutation(adminApi.credentials.rotate, {}));
```

The two exist together for the length of that transaction, which is what makes
the rotation downtime-free: the replacement already works when the old one stops.

**It replaces the credential you called it with, so you have to be holding one.**
Requires `_admin:credentials:write`, and the presented credential must itself be
one of the Admin Credentials being replaced. Holding a grant that covers the
whole vocabulary is a different and weaker claim: an Agent Credential issued
`["*", "_*"]` beneath a master covers it too, and minting a root from there would
trade authority its parent can narrow at any moment for authority nobody can —
an escalation in permanence rather than in reach. A resolver-backed user the
application granted `_admin:*` is refused for the same reason, and would
otherwise have been able to destroy the operator's master as well. Both get
`unauthorized`.

Three consequences worth knowing before you rotate:

- **The administrative Identity changes.** A credential *is* an Identity, and
  the replacement is a new credential. Anything keyed on the old Identity —
  Files it owns, analytics attributed to it — keeps pointing at an Identity no
  credential answers to any more. Re-keying the row instead was considered and
  rejected: the invalidation channel names a credential by its token id, so an
  old secret and its replacement sharing one id would be one subject, and
  "revoke the leaked secret's sessions but not the new one's" would not be
  expressible. A rotation whose purpose is to defeat a leaked secret has to
  produce a different subject.
- **Credentials delegated beneath the old master go with it**, by the ordinary
  revocation cascade: a child of a revoked parent has no source left to be
  bounded by.
- **It is not retryable.** The result is marked non-replayable, so a retry with
  the same `Idempotency-Key` answers a receipt and never a second secret — and
  in any case the old credential is gone by then. If the answer is lost after
  the commit — a dropped connection, or a `convergence_unavailable` outcome,
  which reports `committed: true` precisely so you can tell — the recourse is
  break-glass. That is the cost of storing only a digest, and it is the reason
  break-glass exists.

`admin.credentials.list` answers with the masters — `id`, `name`, `createdAt` —
and never a secret; no read can return one.

**Neither is an MCP tool.** The subset invariant blocks escalation but not
persistence: an agent holding credential-write mints a second credential with its
own scopes and survives revocation of the first. Issuing authority is the one
operation whose product is authority, and it requires a human.

### Break-glass

For a lost secret, or an application that no longer starts:

```sh
acker credential reset [app-dir]
```

It clears every Admin Credential — and everything delegated beneath them — so
the next start issues a fresh one and prints it. It opens the database file
directly: no application is imported, no schema is needed, and nothing about it
depends on the code that may be what broke.

**It works only with the server stopped**, and that is a lock rather than a
check: it takes the same database ownership every AckerDB process takes, so a
running server makes it fail before anything is read.

## `admin.system.info`

```ts
const { name, version, ackerdb, protocol } = unwrap(
  await client.query(adminApi.system.info, {}),
);
```

| field | what it is |
| --- | --- |
| `name` | the application's own name |
| `version` | the application's own version |
| `ackerdb` | the AckerDB version serving it |
| `protocol` | the wire protocol this server speaks |

Requires `_admin:system:read`.

It exists because nothing else identifies the application. The welcome frame
describes authentication and nothing else; a client reached through a proxy sees
the proxy's own origin, not the application's. A dedicated health route would
have put the same answer outside the one authorization funnel, and extending the
welcome frame would have put a per-connection cost on every client for a fact
one screen reads once.
