# AckerDB provides a credential capability, not an administration product

AckerDB shipped an administration product to every application whether it
wanted one or not. The framework contributed an `admin` function group, reserved
half the scope namespace under `_`, defined a specially-classified Admin
Credential, minted one during the boot and printed its plaintext, owned listing
and rotation of it, shipped an offline break-glass command to clear it, and
carried an `admin` configuration object and a generated client binding for the
whole thing.

None of that is necessary for AckerDB to give an application credentials, and
all of it made credentials harder to use: an application's own administration
had to work *around* framework-owned administration rather than being written as
the functions, scopes, and screens the application actually wanted. Meanwhile
credentials themselves sat on a parallel storage path — Engine-internal physical
tables, raw SQLite reads, credential-specific reactive keys, and a WeakMap
capability bag — beside a managed database that already answers every one of
those questions for application tables.

The decision is two halves of one sentence: **AckerDB owns the invariants that
make a credential safe, and nothing else about administering one.**

## The Admin product is deleted, not replaced

There is no framework-declared function left, so the Registry has one
contributor. There is no `admin` group, so `admin` is an ordinary name an
application may declare like `internal` or `reports`. There is no `admin`
configuration, so the OpenAPI document takes its title and version from the
application's package manifest — which is where the old configuration's own
defaults came from. There is no boot credential, so an application with zero
credentials is a valid application and the boot has no phase, no output, and no
failure mode about issuing one. There is no `acker credential reset`, because
AckerDB no longer claims a recovery policy on an application's behalf.

The rejected alternative was a smaller Admin: keep the group, drop the extras.
It fails the same way the original did — whatever the framework declares, an
application inherits and must design around. A capability an application reaches
*into* composes; a surface the framework publishes *at* it does not.

## The scope vocabulary is the application's, whole

`*` now covers every declared scope, `_` reserves nothing, and `_*` is an
ordinary prefix pattern. The reserved marker still guards API paths and HTTP
roots, where the framework really does own names; inside the scope namespace it
guarded a vocabulary that no longer exists, and an application that wanted a
scope called `_internal:purge` was refused for no reason it could see.

Requirements stay concrete and grants keep trailing wildcards. Nothing about the
subset-at-issuance / intersection-at-use invariant changes; there is simply one
half of the namespace left.

## Credentials are managed tables, and the module is one module

`_ackerdb_credentials`, `_ackerdb_identities`, and `_ackerdb_identity_accounts`
are now logical tables, contributed by the domain modules that implement them
and composed with Jobs and Files at one seam that refuses a duplicate table name
or a conflicting named type instead of letting one contribution overwrite
another. The framework-table set is derived from that composition rather than
maintained beside it, so hiding and migration behaviour cannot drift from the
schema.

What follows from being managed is most of the deletion. Transactions, indexes,
ordering, pagination, predicate dependencies, and write keys are the database's
already, so a credential query is reactive because it is a query, and a
revocation participates in the caller's transaction because it is a write. The
credential vault, its raw connection, its bespoke `internal:credentials:<owner>`
read and write keys, and the WeakMap that lent a context its capability are all
gone; `ctx.credentials` is a property on the invocation context exactly as
`ctx.db`, `ctx.jobs`, and `ctx.files` are, with the same lifetime and the same
rule that retaining a context past its invocation is programmer error.

One module owns what remains, and it is all policy: mint a token id and a
secret, store only the digest, disclose the plaintext exactly once and mark the
result non-replayable, mint an Identity per credential, bound a child at
issuance by the issuer's current grant and at use by every ancestor's, revoke
descendants with their source, and stage authentication invalidations on the
transaction so a rollback publishes none.

## Two adapters, because there are two execution roots

An invocation has a principal, a transaction, and collectors; pre-invocation
bearer authentication has a snapshot read and nothing else — no subscription to
invalidate, no transaction to join. That is a real difference, so it gets an
adapter rather than a flag: the invocation adapter binds the module to the
managed reader or writer the invocation already carries, and the runtime
adapter binds it to a managed reader over a snapshot with no ReadRecorder. They
share one module and one table definition, which is what keeps them from
drifting on an invariant.

Framework implementations reach their tables through `ctx.internal.db`, built
from the same managed reader or writer over the composed framework schema. It
does not swap in the system principal — storage capability and caller authority
are separate — and it is absent from the application-facing context types, which
is the same boundary that keeps `_ackerdb_credentials` out of `ctx.db`.

## `manage` carries no framework check, and that is the product decision

`ctx.credentials` is owner-scoped: it addresses the credentials the calling
Identity issued directly, refuses an anonymous or system caller as
unauthenticated, and is bounded by the grant that Identity holds.
`ctx.credentials.manage` is global and admits whoever the containing registered
function admits — public bootstrap door, authenticated screen, system flow,
custom policy, or nothing at all.

The rejected alternative was a framework scope or principal check behind
`manage`. Any such rule is a bootstrap policy, and a bootstrap policy is exactly
what the Admin product got wrong: the framework cannot know whether an
application wants a one-time public setup route, an invite flow, an operator
CLI, or no root credential ever. Leaving the decision at the function boundary
costs nothing in safety — a function is already the one authorization funnel —
and it is the whole difference between a capability and a product.

## Consequences

- Every pre-existing database is refused at open. The engine schema version
  moves to 15 because the promoted tables carry the same physical names as the
  internal ones they replace with different shapes, and a clean refusal by
  version is better than a reconcile that tries to create a table it can see.
  No migration promotes old rows; this is a deliberate break, not an oversight.
- The pre-split jobs framework migration goes with it: it could only ever run
  against a database written before the break, which no longer opens. The
  framework-migration facility stays and its list is empty.
- Credential operations are asynchronous, because managed table access is.
- Provisioning an Identity for a first-seen external account is now an ordinary
  coordinated write, so it allocates a commit version and publishes write keys
  like any other insert.
- `ctx.db` hides Credentials, Identities, Identity Accounts, and the File
  tables. It still shows the Jobs tables: a Job's scheduling intent is
  application state, guarded column by column at the write seam, and that has
  not changed.
- Savoria's Admin Panel, Admin Chat, Admin MCP, and Agents page keep their
  names. They are an application's own administration feature, which is exactly
  the thing this decision says applications should build.
