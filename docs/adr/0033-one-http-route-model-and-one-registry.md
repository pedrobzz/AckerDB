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

## The path language is what the compiler can prove

The published grammar is static segments, `:name`, and at most one terminal
`*`. It is that small because every form must be inferable from the literal
path: `/users/:id` types its handlers' `ctx.params.id` as `string`, a static
path types no parameter keys at all — so a misspelling is a compile error, not
`undefined` — and a terminal `*` types `ctx.params["*"]`.

Both directions of that grammar live in one module. `ValidHttpPath<P>` refuses
a malformed literal at the call site, and `validateRoutePath` refuses the same
shapes at load for values that arrive untyped; `HttpParams<P>` extracts the
names the matcher will capture. A pattern the compiler accepts is a pattern the
router matches, because there is one set of rules and one file.

The result type carries the same discipline. Application handlers answer
`Response`. Bun's contract for an accepted WebSocket upgrade is `undefined`,
which is a real outcome of an HTTP route — the socket has left HTTP — so the
canonical handler generic has a result slot whose default is `Response` and
which the framework's own binding widens. The application-facing factory, and
the generated one, pin it closed.

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
  address-keyed raw-handler map are gone; `registry.exposed` is keyed by
  address, which is what OpenAPI and the Runtime actually consume, and
  `registry.httpRoutes` is the loader's ordered list of authored routes.
  `Runtime.runHttpHandler(address, …)` becomes `runHttpRoute(route, …)`: the
  route value travels instead of a name to be looked up again.
- **Explicit paths may live outside `/api/`.** The reserved set is the built-in
  paths, any first segment carrying `_`, and any second segment carrying `_`
  *under `/api/`*. Reserving the second segment everywhere — which the old
  predicate did, because every path was derived and every derived path began
  with `api` — would forbid `/webhooks/_raw` for nothing.
- **Lifecycle gating moved from a path prefix to route policy.** The old
  `startsWith("/api/")` test is gone. Application routes enter the table as one
  validated synchronous batch at activation with readiness flipping after the
  last insertion, and each carries its own readiness check for the draining
  window; a request no route claims answers unavailable before readiness and
  during drain, `not_found` after.
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
- The File byte routes are two registered patterns
  (`/_files/uploads/:handle`, `/_files/grants/:handle`) instead of one regular
  expression inside the File runtime, which now receives the matched route and
  the captured handle and parses only `<id>.<secret>`. Their `405` loses the
  `cache-control: no-store` header it used to carry, because the registry
  authors one 405 for every route.
- Generated application code exports `http`, `Http`, `HttpHandlerCtx`, the
  canonical `HttpHandler`, and all seven method aliases, each with the
  application's `Schema` bound in and the literal `Path` left to the caller.
