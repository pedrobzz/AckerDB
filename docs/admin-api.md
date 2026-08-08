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
