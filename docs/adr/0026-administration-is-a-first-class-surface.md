# Administration is a first-class surface, declared by the framework and reached through the ordinary funnel

Every application needs to be looked at: its logs read, its jobs inspected, its
rows corrected. Until now AckerDB shipped none of that, and the machinery that
would carry it was built for exactly one producer. `Registry`'s only input was a
walk of the user's `functionsDir`; `packages/server/src/**` never called
`query()`, `mutation()` or `procedure()` once, and every reference to the
declaration builders from framework code was `import type`. `FRAMEWORK_SCOPES`
was `Object.freeze([])`, which meant `expandScopeGrant` returned the empty set
for it and an administrative grant of `["*", "_*"]` expanded to **zero**
authority — the credential named the whole framework vocabulary and reached
nothing in it.

The decision: **administration is a first-class surface of the framework, not a
client bolted onto one.** The framework declares functions of its own, in a
group it publishes for every application, authorized by a vocabulary it owns,
and every one of them is dispatched by the same code as an application's. It is
named the Admin API rather than after any client that reads it: Studio is one
consumer, and naming a set of server functions after the tool that happens to
call them is the tail wagging the dog.

## The framework is a contributor, not a special case

The Registry now takes two contributions — the framework's modules and the
application's — flattens them into one list, and runs a single set of passes
over both. Nothing downstream asks where an export came from, so an admin
function is addressed, routed, codec-compiled and documented by exactly the code
every other function goes through.

The Engine already answered this question for tables:
`withFrameworkTables(schema)` injects `_ackerdb_jobs` and the File tables into
the logical schema, where they are planned, reactive and queryable like any
application table. A second answer for functions would have been the parallel
path we refuse everywhere else.

Two contributions rather than one merged record, though, and that difference is
load-bearing. A module key is a directory name carrying no reserved marker, so
`functions/system.ts` and the framework's `system` module are one key; merging
would let either silently replace the other. Kept apart, the group disambiguates
them: the framework's export is `admin.system.info` and the application's is
`api.system.info`.

The alternative — the CLI injecting the framework's modules at each call site —
was rejected because there are two of them, `acker start` and `acker openapi`,
and "always registered in every application" stated twice is a fact that drifts.

## The group is `admin`, and the address is what protects it

The framework claims a name in a namespace the application shares. The reserved
marker exists for exactly that problem, and it is closed here from both ends: a
group's name is written straight into `export const <name>`, and generated
`api.ts` reserves the entire `_` prefix for its own identifiers precisely
because no group may use it. `_admin` is unrepresentable, and buying it would
mean reopening the identifier rule, `claimsReservedName`, and code generation's
own reservation.

It buys nothing, because the address rule already does the work. Since
[ADR-0023](0023-api-paths-group-function-addresses.md)'s amendment the group is
the address's *first segment*, so `logs.list` in an application is
`api.logs.list` and can never be `admin.logs.list`. Squatting requires naming
the framework's group, module and export at once, and the one address space
refuses that at startup with the collision it already had.

So `admin` is an ordinary shared group, and the sharing is explicit: an
application may publish its own functions there, which the ticket, ADR-0023 and
this document all say on purpose. `declaredApiPaths` refuses the literal
`"admin"` with the message `"api"` already had — every application publishes it,
and listing it would emit the binding twice into one generated file.

## An application may not require a framework scope

`validateScopeVocabulary` already refused an application *declaring* a
`_`-prefixed scope. Once `FRAMEWORK_SCOPES` is populated, an untyped
`scopes: { anyOf: ["_admin:logs:read"] }` on an application declaration passes
`checkRequirementAgainstVocabulary` — the name is in the known vocabulary — while
the generated `Scope` union refuses it at compile time. **The type system saying
no and the runtime saying yes is the bug**, and the hole is reachable by any
declaration written without the generated builders.

`Registry.checkScopeRequirements` now refuses a reserved scope on any function or
MCP tool entry the framework does not own. Ownership is recorded by identity, not
by address prefix, because the `admin` group is shared: publishing a function
beside the framework's does not make it the framework's.

## Inert, restated as what it can be

"Inert without an authorized credential" cannot mean the surface is absent.
`access` is required on every declaration and a scope requirement contradicts
`"public"` and is dead under `"system"`, so an admin function is `authenticated`
plus scopes and the funnel answers `unauthorized` or `unauthenticated` — never
*not found*, which would be a lie about a live route.

What it does mean is exact: **no admin function performs any work or discloses
any data without a grant covering its scope.** One deliberate decision about
discoverability sits beside it — framework-declared admin functions carry
`http: { openapi: false }`, an exposure field that already existed — so they stay
callable while absent from `/_openapi.json`. Publishing the entire administrative
surface to anyone who can fetch a schema is a map for a caller who has no grant
and could not use it.

## The reference tree ships, it is not generated

Code generation builds a group's tree from a walk of the *consumer's* functions
directory. A shipped package has no such directory, so no amount of bending the
generator gives `@ackerdb/studio` typed `admin.*` references. The framework's
declarations are statically known and have no business going through an
application's code generation at all.

The tree therefore ships as an ordinary export of `@ackerdb/core`, beside the
reference builder that makes it, and generated `api.ts` re-exports it as the
`admin` binding intersected with whatever the application published into that
group. The contract lives in core rather than in the server package that
implements it because core is what every client already depends on and a browser
bundle has no business importing a server; the two halves are held together by a
compile-time proof, so a leaf added, renamed or retyped on either side fails the
build.

The rejected alternative — a hand-written `adminApi` object beside the generated
one — is the parallel path again: the group binding is the contract, and it must
come out of one place.

## `admin` is where administration is configured

One object holds it, because an operator reasons about administration as one
thing and a setting per subsystem would scatter that decision across four option
bags. Its one field today is `admin.application`, the name and version the
surface reports.

That field exists because nothing else in the framework identifies the
application: the manifest describes a schema, the configuration describes paths
and ports, and the protocol's welcome frame describes authentication. It
defaults to the application package's own name and version, which is the same
fact the OpenAPI document's title already read off `package.json` — so that read
moves into the resolved configuration and both take it from there. An
application never has two names.

## Consequences

- `FRAMEWORK_SCOPES` is no longer empty, so `_*` grants real authority and a
  scoped admin credential can be verified.
- Every `Registry` carries the `admin` group, including the ones tests build.
  A suite asserting an application's surface asserts the application's half.
- `defineApp({ apiPaths: ["admin"] })` is now a declaration error.
- `acker openapi` no longer reads `package.json` itself; the document's identity
  comes from the resolved `admin.application`, which is configurable.
- An application declaration requiring an `_`-prefixed scope now fails startup
  rather than being quietly honoured.
