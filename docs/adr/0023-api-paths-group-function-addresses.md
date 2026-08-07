# API paths group function addresses; access alone decides admission

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
to `"api"`.** It names the group a function is published in, and the group
decides two things together — the generated binding a caller imports, and the
HTTP root the function answers on.

| `apiPath` | binding | URL |
| --- | --- | --- |
| `"api"` (default) | `api.*` | `/api/*` |
| `"internal"` | `internal.*` | `/internal/*` |
| `"admin"` | `admin.*` | `/admin/*` |

The framework does not decide that "internal" is a correct category: an
application names its own groups, and may add its own functions to any of
them, `admin` included. A name is one identifier-shaped path segment, may not
be a word `export const <name>` rejects, and may not begin with `_` — the
reserved marker, which keeps every root AckerDB may want permanently free of
application routes. The marker rule is stated once and applied wherever a path
is claimed — the group, the module namespace under it, and the free-form path
an MCP endpoint chooses alike. Socket-addressed kinds (channels, realtime) have
no HTTP root to group and refuse `apiPath` at startup.

A group decides *where* a function answers, never *whether* it answers: plain
HTTP still requires `http`, and over the socket a function is addressed by its
dotted name alone, which the group does not touch.

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
  an erased function remotely. With the group reduced to grouping, the
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
literal names a group this application declared is a manifest disagreement, and
manifest disagreements are startup refusals here, as schema and plugin
mismatches already are. Threading the declared groups through every builder as
a sixth type parameter would buy an earlier error and pay for it in the
signature of every kind.

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
