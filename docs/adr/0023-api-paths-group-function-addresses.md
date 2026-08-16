# API paths group function addresses; access alone decides admission

> Amended by [ADR-0032](0032-ackerdb-provides-credentials-not-an-administration-product.md):
> the framework publishes no group of its own. `api` is the only group every
> application carries, and `admin` is an ordinary name an application declares
> in `apiPaths` like any other — the rows and sentences below that treat it as
> framework-owned are history. The address grammar, the one-root rule, and
> "access alone decides admission" are unchanged.

> Amended: the group is now the *first segment* of a function address rather
> than a field beside it, which is what makes this document's title true. The
> sections below already read that way; **The group is a namespace, not a
> label** records what changed and what it deleted.

> Amended again: `PROTOCOL_VERSION` no longer exists, so the paragraph below
> about the address grammar "moving" it describes a number that is gone. What it
> was reaching for still holds and is now direct: a frame declares the AckerDB
> version of the build that produced it, and a decoder accepts exactly its own,
> so a stale client's group-free `ref` is refused as a mixed install before it
> can name a different function. The number was the indirection; the refusal was
> the point.

**This decision replaces the erased-visibility model recorded in ADR-0021,
"Internal functions are erased visibility, not a separate function kind."**
That record is deleted rather than kept as a tombstone: the model it described
merged into `canary` and was never released, so nothing outside this repository
ever depended on it. Its number is retired rather than reused, because an ADR
number is a citation and two documents answering to one number would make every
existing reference ambiguous. The gap at 0021 is the record that something
stood there.

Every registered query, mutation, and procedure is a wire endpoint, and the
generated `api` tree is the whole of it. Two unrelated needs pressed on that
single tree. First, durable job steps want reusable named targets that are
deliberately not part of an application's client surface. Second, the
framework's own administration functions need a surface of their own that no
application module can squat on. A plain TypeScript helper answers neither: it
forfeits argument validation, the typed result contract, and the nested
mutation scope.

ADR-0021's answer was `internal: true` — a literal boolean that erased a
function from the client tree and published it on a sibling `internal.*` tree
with no wire address at all. It shipped a category the framework asserted was
meaningful, and it made *addressability* a declaration-time property, which
forced two special cases: a startup refusal for `internal` combined with HTTP
exposure (a function cannot both have no address and claim a path), and a
transport lookup that resolved internal names as though they never existed.
It also invited a scope, `internal:run`, whose only job was to let an
administrator reach past the erasure.

The decision: **`internal: true` is replaced by `apiPath`, a string defaulting
to `"api"`, and that string is the first segment of a function's address.** It
names the group a function is published in, and the group decides two things
together — the generated binding a caller imports, and the HTTP root the
function answers on — because both are read off the one address.

A function address is `<apiPath>.<...directory segments>.<export name>`, and it
is the same value everywhere: the socket names a function by it, the registry
keys by it, and an exposed function's URL is it segment for segment.

| `apiPath` | address | binding | URL |
| --- | --- | --- | --- |
| `"api"` (default) | `api.users.list` | `api.*` | `/api/*` |
| `"internal"` | `internal.users.list` | `internal.*` | `/internal/*` |
| `"admin"` | `admin.users.list` | `admin.*` | `/admin/*` |

The framework does not decide that "internal" is a correct category: an
application names its own groups, and may add its own functions to any of
them, `admin` included. A name is one identifier-shaped path segment, may not
be a word `export const <name>` rejects, and may not begin with `_` — the
reserved marker, which keeps every root AckerDB may want permanently free of
application routes. The marker rule is stated once and applied wherever a path
is claimed — the group, the module namespace under it, and the free-form path
an MCP endpoint chooses alike. The socket-addressed kind (channels) has no
HTTP root to group and refuses `apiPath` at startup.

A group decides *where* a function answers, never *whether* it answers: plain
HTTP still requires `http`, and over the socket a function is addressed by the
same dotted name the URL spells.

**A group is never an access rule.** Who may call a function is decided by
`access` alone — `"public" | "authenticated" | "system" | (ctx, args) =>
boolean` — plus its orthogonal scope requirement, both enforced at the single
invocation funnel. An application may publish a `"public"` function in the
`internal` group; that is its right and its mistake to make. Making a group
imply a policy would put admission in two places and let a rename change who
may call.

Three consequences follow, all deletions:

- **The internal-plus-HTTP contradiction rule is gone.** It existed only
  because internal meant *no address*. Under `apiPath` every function has an
  address in its group, so the contradiction is unrepresentable.
- **`Registry.remote` is gone.** The transport and in-process resolution are
  the same lookup again, because there is no longer a class of function with a
  wire address that is deliberately absent.
- **`internal:run` is gone.** It was invented so an administrator could invoke
  an erased function remotely. With the group reduced to namespacing, the
  function's own `access` decides: an administrative identity holds every
  scope and so satisfies any application requirement, while an `access:
  "system"` function stays unreachable — correctly, and for the same reason it
  always was.

This is a deliberate behavioural change against the erasure model: a function
in the `internal` group is now reachable at `/internal/...`, protected solely
by its `access`. Nothing becomes exposed by accident, because `access` is
already a required field on every declaration — the model moves the decision
to where it was always enforced rather than adding a second gate.

Groups beyond `"api"` are declared once in the manifest, `defineApp({ apiPaths
})`. Code generation reads the manifest and never the function modules — the
modules import the files it writes, so importing them would be a bootstrap
cycle — and a group's binding is a named export, which no type-level
computation can produce. The manifest is therefore the only place the list can
honestly live.

That makes the manifest and the declarations two statements of one fact, so the
registry reconciles them: a function published in a group the manifest does not
name is a startup refusal. Without it a misspelled `apiPath` would serve a live
route whose binding nobody can import — invisible in exactly the way the
erasure model made impossible. The reconciliation has no off switch: declaring
no group leaves the default one, rather than waiving the rule.

The agreement is enforced at startup rather than in the type system. A widened
`apiPath` *is* a compile error, because a group that is not one literal breaks
the type-level tree selection — a type problem with a type fix. Whether a
a literal names a group this application declared is a manifest disagreement,
and manifest disagreements are startup refusals here, as schema mismatches
already are. Threading the declared groups through every builder as
a sixth type parameter would buy an earlier error and pay for it in the
signature of every kind.

## The group is a namespace, not a label

As first shipped, `apiPath` grouped nothing. `apiGroup("admin").jobs.list`
produced `{ $ref: "jobs.list", $apiPath: "admin" }` — the group rode beside the
address and only the URL builder ever read it. Two consequences followed, and
both contradict the paragraphs above. `api.messages.list` and
`internal.messages.list` were one function at two URLs, not two functions. And
a group could be squatted: the framework declaring `admin.jobs.list` would have
claimed the bare address `jobs.list`, so any application with a
`functions/jobs.ts` exporting `list` failed to start — which is the opposite of
"a surface of their own that no application module can squat on".

Making the group the address's first segment closes both, and it deletes rather
than adds. `$apiPath` on the reference proxy and `refApiPath()` are gone; the
group is `address.split(".")[0]` when anyone needs it, and nobody does.
`httpPathForAddress` lost its group argument and is now one `replaceAll` over
the address. The Registry keeps one flat key, and its duplicate rule becomes
correct rather than over-broad: two groups may each hold a `messages.list`, and
one group may not hold it twice.

The address grammar is part of the wire envelope, and a change to it is exactly
why the envelope carries a version at all. It is the only surface where the
string changed — an exposed function's URL is byte-identical before and after,
because the group was already its first path segment — and a client from another
build would otherwise send a group-free `ref` that names a different function
here. One refusal at the decoder is the honest outcome; a call that lands
somewhere else is not.

Event-table references take the same treatment — `api.events.<table>` — because
they are leaves of the default group's tree like everything else in it. The
alternative, a group-free `events.` prefix, would be the one address in the
system that does not begin with a group, which is a special case for nothing.

The group is still declared on the function and never inferred from a
directory. `functions/admin/users.ts` publishes into whatever group each of its
functions declares — the default one included — because a directory is a module
name and only `apiPath` names a group. Inferring it would make a rename of a
folder a rename of a route, and would leave no way to publish two groups from
one directory.

## An index file takes its directory's name

`functions/orders/index.ts` publishes `api.orders.*`, not `api.orders.index.*`.
The collapse is the only reason two files can claim one module name, so two
refusals stand at the manifest, where the name is decided, and both name the
files involved: `functions/orders.ts` beside `functions/orders/index.ts`, and a
`functions/index.ts` with no directory to be named after. The second could
instead publish its exports directly under the group, but that is a module with
no name at all — neither the generated tree nor an address can hold one.

The layout this makes ordinary is an `index.ts` beside its siblings, which is a
module and a namespace at one name. The generated tree intersects the two:
`orders: typeof _m_orders & { refunds: typeof _m_orders_refunds }`. Keeping
only one — which is what the tree did before, silently — leaves a registered
address with no binding anybody can import, the exact failure the manifest
reconciliation exists to prevent.

## One path, one function

A unique address does not imply a unique route. The projection joins segments
with `/` where the address joined them with `.`, and an export named through a
string literal may contain either, so `api.notes.a/b` and `api.notes.a.b` are
two functions with two access policies at one URL. The path claim refuses the
second rather than replacing the first, beside the reserved-marker and MCP
refusals it already owned — the one place a path is claimed is the one place
that can know a path is taken.

## Two costs accepted deliberately

**A group's binding lists every module namespace, not only the ones that reach
it.** `internal.` offers `internal.messages` even when nothing under
`messages` is in that group; the leaves are selected correctly, so the empty
branch is autocomplete noise rather than a wrong type. The type-level fix —
testing a namespace for emptiness before keeping its key — makes that test and
`ApiFromModules` mutually recursive, and TypeScript rejects it as an
excessively deep instantiation on real module trees. Filtering at generation
time instead is not available either, and for the same reason the manifest
exists: code generation builds the module tree from the *file list* and never
imports a function module, so it cannot know which module holds which group.
Both honest fixes are closed; the noise stays.

**A misspelled group is a startup refusal, not a compile error.** See above —
the earlier error is buyable only by putting the manifest's groups into the
type of every builder.
