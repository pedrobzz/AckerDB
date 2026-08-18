# One HTTP route model and one registry

AckerDB's listener did not have an HTTP model. `/live` and `/ready` were the
first two branches of a fourteen-branch `if` chain in `fetch`; raw handlers and
exposed functions lived in two path-keyed maps consulted at different points in
that chain; the File routes were a regular expression parsed inside the File
runtime; the WebSocket door, the SSE receiver credit, `/status`, and the
OpenAPI document were four more branches. Method checking, the readiness gate,
`404`, and `405 + Allow` were written between three and five times each, in
subtly different shapes — one branch answered a Protocol-2 frame where its
neighbour answered a bare `Outcome`, and a global `OPTIONS → 204` sat in the
middle of the chain so that an unknown path answered a preflight it had no
route for.

Two things followed from that. Equivalent HTTP behaviour looked unrelated: a
webhook and an exposed function both own a path, a set of methods, and a
callable, and the listener distinguished them on every request. And the
framework could not use the interface it offered applications, so nothing
exercised that interface but applications.

The application-facing surface reflected the same split. `httpHandler` derived
a fixed path from an export address, took `methods: [...]` plus one handler,
and offered no route parameters and no wildcard — a handler serving two methods
inspected `request.method` itself, and a provider-dictated URL was
unexpressible.

The decision: **one canonical `Http` value, one public `http` factory, and one
`HttpRegistry` that owns generic HTTP dispatch and nothing else.**

## The model

An `Http` is an explicit path and a non-empty method-keyed map of handlers. It
carries no route-kind discriminator and no optional per-kind payload, because
dispatch never needs one. Health probes, `/status`, the File byte routes, the
WebSocket door, the SSE receiver credit, the OpenAPI document, exposed
functions, and application-owned raw routes are all this value, in one table.
`fetch` is one permanent function whose whole body is a registry lookup;
lifecycle transitions change what the table holds and what its handlers answer,
never which function Bun calls.

The line between the registry and its handlers is the line between generic HTTP
and AckerDB policy:

- the registry matches paths, applies precedence, extracts and decodes
  captures, selects the method, answers `405` with a complete `Allow` built
  from the route itself, and hands an unmatched request to its owner's
  fallback;
- handlers own reachability, admission, authentication, decoding, idempotency,
  body limits, response shaping, File behaviour, and upgrade behaviour.

The registry never learns that a route is a probe, a webhook, or a File.

## The path language types its captures

The published grammar is static segments, `:name`, and at most one terminal
`*`. It is that small because every form must be inferable from the literal
path: `/users/:id` types its handlers' `ctx.params.id` as `string`, a static
path types no parameter keys at all — so a misspelling is a compile error, not
`undefined` — and a terminal `*` types `ctx.params["*"]`.

`HttpParams<P>` extracts the names the matcher will capture. The type rejects a
non-absolute literal; `validateRoutePath` owns the complete runtime grammar,
including empty segments, terminal wildcard placement, duplicate names, and
matcher syntax.

The grammar is closed rather than merely restricted. A static segment may not
carry any character the matcher reads as syntax — `( ) { } \` as well as
AckerDB's own `: *`, plus `? #`, which a pathname cannot contain — and a
parameter name is exactly the character set the matcher treats as a *plain*
named parameter. Without that, `/v(1)/x` would type as a static, zero-parameter
path and register as a pattern-constrained one: the underlying language
leaking through a hole in the published one, which is the failure mode the
seam exists to prevent.

Ownership is by pattern and method, not by written path. `/users/:id` and
`/users/:slug` may contribute different methods to the same matched route but
cannot both claim `GET`.

Application handlers answer `Response`; framework handlers may also answer
`undefined` after a WebSocket upgrade. Two thin construction adapters close
that genuine execution difference over one opaque executable `Http` model:
public `http` enters Runtime policy, while internal `frameworkHttp` calls the
framework handler directly. `HttpRegistry.add` consumes either value without
conversion and dispatch remains route-kind blind.

## Matching is adopted, not built

Routing with dynamic registration, named parameters, a terminal catch-all, and
deterministic precedence is commodity that predates AckerDB by decades. The
options were surveyed in OpenSRC:

- **`Bun.serve({ routes })`** is the closest prior art for the *public shape*
  (literal path, method-keyed handlers, static-before-parameter-before-wildcard
  precedence, literal-path inference) and is the reason that shape is what
  AckerDB publishes. It is not usable as the *mechanism*: it is a static table
  swapped by `server.reload()`, which is exactly the "replace the dispatch
  implementation on a lifecycle transition" this decision removes.
- **`find-my-way`** (Fastify's router) is mature and complete, and brings
  constraints, versioning, and its own 404/405 handling — machinery AckerDB
  must own rather than delegate, since those answers are part of its outcome
  contract.
- **hono's `TrieRouter`/`RegExpRouter`** are coupled to hono's `Context` and
  application object; the repo's `hono` and `@hono/node-server` entries are an
  overrides pin and an unused advisory dependency, imported by nothing.
- **`rou3`** (the unjs/h3 router, MIT, no runtime dependencies) is a radix tree
  with dynamic `addRoute`, named parameters, a named catch-all, and precisely
  the precedence above. It is what h3 v2 and Nitro dispatch on.

`rou3@0.9.1` is adopted, pinned exactly. AckerDB keeps the policy on its side
of a narrow seam: the published grammar is validated by AckerDB and translated
into rou3's syntax once at insertion, so nothing rou3 additionally supports —
regular-expression parameters, optional modifiers, group delimiters — becomes
an AckerDB route language. Path ownership, method selection, `Allow`, capture
decoding, and every response shape stay AckerDB's. Routes are inserted under a
single method key and method dispatch is done by the registry, so one lookup
answers both "which route" and "which methods does it serve".

## Consequences

- `httpHandler` is deleted outright, with no alias, shim, or second
  declaration shape. `Registry.httpHandler(address)`, the path-keyed
  `registry.exposed` map, `registry.httpRoutes` as a path map, and the
  address-keyed raw-handler map are gone. `registry.functions` is the only
  addressable-function collection. The listener derives each exposed function
  from it, compiles the function's codec, and registers the resulting handler
  directly in the live `HttpRegistry`; OpenAPI walks the same function
  collection independently. A raw `Http` has no application address and no
  second holding collection: the loader contributes the validated value
  directly to that same `HttpRegistry`. `Runtime.runHttpHandler(address, …)` becomes
  `runHttpRoute(route, …)`: the route value travels instead of a name to be
  looked up again.
- **Explicit paths may live outside `/api/`.** The reserved set is the built-in
  paths, any first segment carrying `_`, and any second segment carrying `_`
  *under `/api/`*. Reserving the second segment everywhere — which the old
  predicate did, because every path was derived and every derived path began
  with `api` — would forbid `/webhooks/_raw` for nothing.
- **Lifecycle gating moved from a path prefix to route policy.** The old
  `startsWith("/api/")` test is gone. Framework routes enter the table before
  the listener binds; application loading contributes each validated `Http` to
  that same table. Presence is not reachability: a supported application
  handler refuses execution until the Runtime is ready and again while it
  drains, while generic routing facts such as an unsupported method remain
  truthful as soon as the route exists. A request no route claims answers the
  lifecycle fallback before readiness and during drain, `not_found` after.
- **`Allow` now names every method the route registered**, the framework's CORS
  preflight included: `POST, OPTIONS` where an exposed procedure previously
  answered `POST`. It is built from the route rather than from a table beside
  it, so it cannot understate what the route serves.
- **The blanket `OPTIONS → 204` is gone.** Exposed and framework routes that
  use framework CORS register an `OPTIONS` handler in their own method map; a
  raw route answers preflight only if it declares one, as before. `OPTIONS` on
  a path no route claims is now `404` (or the lifecycle outcome) instead of
  `204`.
- **Two responses changed shape, both toward the majority.** A wrong method on
  `/_ws` answers the bare `Outcome` the registry authors rather than a
  Protocol-2 frame, and `frameMethodNotAllowed` is deleted. An unmatched path
  before readiness answers the bare unavailable `Outcome` rather than a frame.
- **Every 405 carries `cache-control: no-store`.** 405 is one of the few
  statuses HTTP caches by default, and a route's method set changes with a
  deploy. The File routes used to set it themselves; now one answer sets it for
  every route, which is both simpler and strictly safer.
- The File byte routes are two registered patterns
  (`/_files/uploads/:handle`, `/_files/grants/:handle`) instead of one regular
  expression inside the File runtime, which now receives the matched route and
  the captured handle and parses only `<id>.<secret>`. Their `405` loses the
  `cache-control: no-store` header it used to carry, because the registry
  authors one 405 for every route.
- Generated application code exports `http`, `Http`, `HttpHandlerCtx`, the
  canonical `HttpHandler`, and all seven method aliases, each with the
  application's `Schema` bound in and the literal `Path` left to the caller.
  `@ackerdb/server` publishes that set and nothing more: the registry, the
  route context it builds, and the shapes it holds stay transport-owned.
- **A File handle is percent-decoded** before it is parsed, where the old
  regular expression ran on the raw pathname. Harmless — the secret is
  compared by digest in constant time, so a decoded variant simply fails to
  match — but `/_files/grants/%31%37.<secret>` now resolves where it used to
  404.
- Three matcher edges are accepted rather than guarded, and are written down in
  [the route contract](../http-routes.md): a parameter matches an empty
  segment, exactly one trailing slash is stripped, and a wildcard capture is
  decoded as one string.

## The line count went up, and that is the honest result

#322 asks for "a net reduction in source lines, excluding tests and
documentation". It is not met: production source is currently 186 lines over
`canary`. The simplification review removed 354 production lines from the
original PR without weakening the public handler types. The mechanism half of
the criterion *is* met — one dispatch
function, one route model, one collision owner, one 405, one 404, one method
selection; the fourteen-branch chain, both path maps, `Registry.httpHandler`,
`frameMethodNotAllowed`, and the File route's regular expression are all gone.

The remaining lines provide typed parameters and wildcards, decoded captures,
seven exported handler aliases, the public application adapter, the internal
framework adapter, and the matcher-backed registry. No further clear deletion
was found that would preserve those requirements; compressing types or moving
the same decisions elsewhere was rejected as metric gaming.
