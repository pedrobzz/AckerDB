# HTTP exposure

Status: implemented. This document is the contract for exposing
queries, mutations, procedures, and SSE procedures to plain HTTP callers —
clients that speak `fetch`/curl/any language, without the WebSocket protocol —
plus OpenAPI generation for that surface. Implementation issues reference this
document; divergences discovered during implementation must update it.

This document covers the *contract* surface: functions served through their
`v` validators and published in OpenAPI. Endpoints whose shapes an external
party dictates — webhooks verifying an HMAC over raw bytes, OAuth callbacks —
are the contract-less side of the same surface, owned by
[HTTP routes](http-routes.md). Both sides are `Http` values in the same
registry; what differs is that this side is served through its contract.
Contract functions state their public path explicitly; their canonical address
remains the transport-independent identity used by the runtime, generated
references, jobs, and the typed SSE transport.

## Motivation

Every registered function is callable through its native transport: the
WebSocket session for queries, mutations, and procedures, and `POST /_sse/open`
for SSE. External services and non-JS consumers may additionally need a normal
HTTP surface with application-chosen paths, plain
JSON in and out, and a machine-readable schema. The runtime already has every
piece this needs: an HTTP listener with auth, admission, and body limits; a
transport-free query boundary (`executeQuery`); an HTTP-native procedure path
(`runProcedure`); and `v` validators that emit JSON Schema.

## The surface

An exposed function states its public URL explicitly. A function at address
`api.messages.list` may choose `/messages`, `/v1/messages`, or
`/api/messages/list`; the address does not decide. The wire format is plain
JSON — no protocol envelope. The registered route already identifies the
function, correlation is the HTTP response itself, and the protocol version is
the package version (no implicit `/v1` segment; breaks are explicit).

| Kind | Methods | Request args | Response |
| --- | --- | --- | --- |
| query | GET, POST | GET: `?args=<url-encoded JSON>`; POST: JSON body | JSON value |
| mutation | POST | JSON body | JSON value + receipt headers |
| procedure | POST | JSON body | JSON value |
| sse | POST | JSON body | `text/event-stream` |

- POST bodies are `application/json` and contain the args object directly, in
  the standard JSON described under *Wire format* below. Absent or empty args
  mean `{}`: an empty body, an omitted GET `args` parameter, and an empty one
  are the same call. Anything else that is not parseable JSON is a `malformed`
  caller error, and the args parameter is bounded by `maxRequestBytes` exactly
  like a body.
- Args are validated by the function's `v` validators through the normal
  invocation path — HTTP adds no second validation system.
- GET exists for queries only: it makes anonymous/public queries cacheable
  and curl-able. Individual query parameters (`?limit=10`) are deliberately
  not supported; string coercion fights the validator model. Large or
  sensitive args belong in a POST body — URLs are routinely retained by HTTP infrastructure.
- Cancellation is the HTTP request abort; there is no cancel endpoint.
- Callers send no request id. The listener numbers HTTP calls from
  its own monotonic sequence; the id never reaches the response.
- A value response emits no `Cache-Control`; caching policy belongs to the
  operator. An SSE response is not policy — it sets
  `Cache-Control: no-cache, no-transform` (and `X-Accel-Buffering: no`), because
  a buffered or transformed stream is not a stream. Both carry
  `Vary: Authorization`: one URL answers different bearer credentials with
  different bodies, and the GET query form is the cacheable one.
- CORS allows the methods the listener serves: `GET, POST, OPTIONS` for the
  exposed function surface, plus `PUT, PATCH, DELETE` for raw HTTP handler
  routes. It accepts `Idempotency-Key` and `x-ackerdb-function` beside
  `Content-Type` and `Authorization`, and exposes the receipt and SSE stream
  headers so a browser caller can read the values documented below.

### Wire format

The surface speaks **standard JSON**, derived from each function's own
contract — the exact form the OpenAPI document publishes, so a caller obeying
the document is understood and a generated client receives what it was
promised. It is deliberately not Protocol-2's escape form
(`{"$":"b","v":"1"}`), which carries values JSON cannot express at the cost of
being unreadable to the external callers this surface exists for. The
WebSocket session keeps that form unchanged; only this surface is plain JSON.

| Validator | Request | Response |
| --- | --- | --- |
| `v.bigint()`, `v.identity()`, `v.file()`, `v.fileGrant()` | canonical decimal string, or a JSON safe integer | canonical decimal string |
| `v.bytes()` | canonical padded base64 | canonical padded base64 |
| `v.literal(1n)` | the literal's decimal string | the literal's decimal string |
| everything else | itself | itself |

Nothing is escaped: an object with a literal `"$"` key is an ordinary object
here. The mapping applies to `args`, `returns`, an sse chunk (`yields`), and a
declared error's `body`; an `Outcome` is already plain JSON. `v.bigint()`
accepts a JSON number on the way in only when it is a safe integer, because
every larger JSON integer literal has already lost precision by the time it is
parsed — proto3's int64 rule.

Each registered function retains an object validator for `args`; every
validator owns `parse`, `decode`, `encode`, and `toJsonSchema`. The transport therefore calls
`fn.args.decode(...)`, `fn.returns.encode(...)`, `fn.yields.encode(...)`, or the
declared error body's `encode(...)` directly. There is no function-level codec
or registration-time contract cache:

- `v.primaryKey()` carries the same decimal JSON as `v.bigint()`, while
  `v.scheduleAt()` carries the same finite JSON number as `v.float()`; their
  database meaning and documentation do not create a different wire type.
- A value a particular validator cannot carry, such as
  `v.literal(Infinity)`, is rejected by that validator's own `encode` and
  `toJsonSchema` implementation. There is no registry-wide kind classifier.
- A value with no validator to describe it — `returns` omitted, or an
  application error whose code the function does not declare — crosses through
  the same structural mapping. Declaring a validator changes what a caller is
  *promised*, never what one receives.
- A validator AckerDB did not build (a hand-written `Validator`, as AI chunk
  streams use) owns its own `parse`, `decode`, and `encode` behavior. No JSON
  Schema can describe such a kind, so an
  operation carrying one fails the *document* — during CLI export or runtime
  OpenAPI assembly — not the call.

### SSE

Typed SSE calls use one framework-owned route:

```http
POST /_sse/open
x-ackerdb-function: api.messages.tail

{ "channel": "general" }
```

The header names a registered SSE function and the body is its args object in
standard JSON. This route exists for every SSE function whether or not that
function declares a public `http` route. Unknown addresses, non-SSE addresses,
and a missing header all answer the same `not_found` outcome.

The response carries the existing stream contract unchanged:
`x-ackerdb-sse-stream` and `x-ackerdb-sse-max-stall-ms` response headers, and
chunk acknowledgement at `POST /_sse/ack` with the existing
`sse_ack` frame. Only the call route moves; the ack machinery is
stream-id-keyed and does not know which function produced the stream.
Every event's `data` is therefore a whole frame — `sse_chunk`, `sse_done`, or
`sse_error` — and never a bare chunk; the standard-JSON `yields` value is a
chunk frame's `value` alone. The credit is mandatory: the producer holds the
next frame until the receiver acknowledges the last one, so a receiver that
never acks reads exactly one event and the stream fails at `maxStallMs`.
A GET/`EventSource` variant is deliberately excluded: `EventSource` cannot
send an `Authorization` header, so it would serve only anonymous streams.

## Route namespace

**The framework's own routes live at the root, behind the `_` marker.** `_`
belongs to AckerDB at the HTTP root, and directly under `/api/`, so future
built-ins cannot be captured by application declarations.

Both contract functions and raw [HTTP routes](http-routes.md) state their URL
explicitly and may claim anything outside the reserved set — the root included.
The second segment remains reserved beneath `/api/` and nowhere else;
`/webhooks/_raw` is an application/provider path AckerDB will never serve.

| Route | Fate |
| --- | --- |
| `/api/call` | deleted (replaced by per-function paths) |
| `/api/sse` | deleted (replaced by `POST /_sse/open`) |
| `/ws` | → `/_ws` |
| `/api/sse/ack` | → `/_sse/ack` |
| — | `POST /_sse/open` (typed SSE transport) |
| `/api/_files/<route>/…` | → `/_files/uploads/:handle`, `/_files/grants/:handle` |
| — | new, opt-in: `GET /_openapi.json` |
| `/live`, `/ready`, `/status` | unchanged, and unmarked |

**The operational endpoints do not move and carry no marker.** `/live`,
`/ready`, and `/status` are the contract with the outside world — Kubernetes
probes, load-balancer health checks — and their names live in configuration
that is not ours to rename. The reserved-name list in
`packages/server/src/transport/http-surface.ts` is what stops an application
route from hijacking them, and it is load-bearing for exactly that reason.

`/_files/` is the one move visible in application code: a download link lands
in an `<img src>`, and shortening it is a direct gain. `/ws` → `/_ws` is
invisible to callers — the SDK builds it — but a WebSocket upgrade usually has
its own reverse-proxy rule (an nginx `location`, an Ingress path, an ALB
rule), so an existing deployment needs that one line updated.

The `CallRequest`/`CallResponse` envelope types in `@ackerdb/core` die with
the envelope routes, as does the client's `encodeCall`.

## Application addresses

Every application function has one canonical address:

```text
api.<module directories>.<export name>
```

The fixed `api` root identifies application-owned behavior. The remaining
segments come entirely from the function module and its export. For example,
`app/admin/users.ts` exporting `list` is addressed
`api.admin.users.list`. Code generation exports one `api` reference tree, jobs
record the same address, socket calls send it unchanged, and typed SSE calls
carry it in the `x-ackerdb-function` header. A public HTTP path is independent
metadata.

**An address never decides admission.** Every declaration still requires an
`access` policy, and may add a scope requirement. `access: "system"` admits
only the local system principal; a public or authenticated declaration is
admitted according to that policy regardless of its module name. Plain public
HTTP also remains opt-in: a function without `http` has no public per-function
URL. An SSE function without `http` is still reachable through `/_sse/open`.

The module path is therefore the canonical function namespace. Moving a
function from `app/users.ts` to `app/admin/users.ts` deliberately changes its
address from `api.users.<export>` to `api.admin.users.<export>` for generated
references, runtime dispatch, jobs, and typed SSE. Its explicit public HTTP path
changes only when the declaration changes.

**A file named `index.ts` takes its directory's name.**
`app/orders/index.ts` publishes `api.orders.*`, so a directory can hold a
module of its own name beside its siblings. Two files may not claim one name:
`app/orders.ts` beside `app/orders/index.ts` is a startup refusal
naming both, and so is an `app/index.ts` with no directory to be named
after.

The application manifest declares the schema and cross-cutting policy such as
scopes. Code generation emits the fixed root without importing function
modules, avoiding a cycle because those modules import the generated
constructors themselves.

## Per-function exposure

Nothing is exposed by default. A function opts into the HTTP surface in its
definition:

```ts
export const list = query({
  description: "List the newest messages in a channel.",
  http: { path: "/messages", openapi: true },
  args: { channel: v.string() },
  handler: async (ctx, args) => { ... },
});

export const purge = mutation({
  description: "Remove every message in a channel.",
  http: { path: "/internal/messages/purge", openapi: false },
  args: { channel: v.string() },
  handler: async (ctx, args) => { ... },
});
```

- `http?: { path: string; openapi: boolean }` — absence means no public route.
  The path is exact, static, and explicit; captures are rejected because
  function args come from the JSON body/query contract, not URL parameters.
  `openapi: false` keeps the route callable but omits it from the document.
  "In OpenAPI but not callable" remains unrepresentable.
- `description` (optional, all four kinds) feeds the OpenAPI operation
  description. `title` likewise (OpenAPI summary).
- These fields govern only the public HTTP/OpenAPI surface. Native transport
  reachability is unchanged; omitting `http` does not hide a function from its
  native transport, and access control remains auth + function policy on every
  transport.

## Mutations: idempotency and receipt

The WS protocol requires a `mutationRequestId` on every mutation. Over HTTP,
replay protection is opt-in per request, Stripe-style:

- `Idempotency-Key: <UUIDv7>` (optional request header). Absent: the mutation
  executes with no replay protection, like any REST POST. Present: the
  coordinator identity is the caller fingerprint as the session scope plus
  the key as the request id — same key + function + args replays the stored
  result; the same key with different args or function is a `conflict`.
  `issuedAt` derives from the key's embedded UUIDv7 timestamp; a key that is
  not a UUIDv7 is a `validation` error, and the existing retention window
  applies unchanged.
- The caller fingerprint is the runtime's existing caller fairness key: a
  user's durable Identity, a workload's issuer and subject, an anonymous
  caller's transport source. It is deliberately not a digest of the whole
  principal — that carries the credential instance (`tokenId`, `expiresAt`,
  claims), so a retry presenting a refreshed token would miss its own stored
  result and write twice, which is exactly what the key exists to prevent.
  It is also the record's `principalFingerprint`, so a key minted on one
  transport never replays on the other; it conflicts.

Because that protection is opt-in, a mutation that cannot answer must not
commit: the response body is encoded inside the transaction, as the session
path frames its result, so a return value that cannot cross the standard-JSON
boundary or exceeds the response bound rolls the write back. The caller's
natural retry of that failure finds no first write.

The mutation receipt rides response headers so the body stays the plain
return value:

| Header | Receipt field |
| --- | --- |
| `x-ackerdb-commit-version` | `commitVersion` |
| `x-ackerdb-durability` | `durability` |
| `x-ackerdb-replay` | `replay`, as `true`/`false` |
| `x-ackerdb-obligations` | `obligations`, comma-joined |

The receipt has no `mutationRequestId`: over HTTP the caller's own
`Idempotency-Key` is that id, and a mutation sent without one has no replay
identity to report. `obligations` is always empty on this surface — an HTTP
caller holds no subscriptions to converge — and an empty list is an empty
header value, which HTTP serialization drops, so the absent header is the empty
list. The four headers are named in `Access-Control-Expose-Headers` so a
browser caller can read them.

The receipt is state at response time. HTTP callers do not receive later
durability transitions for pending obligations (the WS client does); a
`?durability=` wait option is a possible follow-up, not part of this feature.
Application errors from idempotent mutations carry the receipt headers too,
mirroring `ApplicationErrorMessage.receipt`.

## Errors

- Declared application errors respond with their declared `Status` and the
  `ApplicationError` JSON body.
- Infrastructure and protocol outcomes map through the existing
  `outcomeHttpStatus` and answer with the bare `Outcome` object. No response on
  this surface carries a protocol frame — including the `503` an application
  path answers before the server is ready.
- Unknown paths, unexposed functions, and kind/method mismatches are `404`
  (unexposed is indistinguishable from nonexistent by design) or `405` with
  an `Allow` header where the path exists but the method is wrong. Both answer
  the same bare `Outcome` body every other failure here answers — `not_found`
  for the 404, and a built one for the 405, which no outcome code names — so a
  caller that decodes this surface never meets a body its decoder cannot read.

## Authentication

Unchanged from the existing HTTP routes: `Authorization: Bearer` resolved
through the credential verifier into an auth lease; anonymous principals
where the function's policy allows. Admission, fairness keys, and body limits
reuse the existing HTTP ingress machinery.

## OpenAPI

The generator lives in `@ackerdb/server` and walks the registry: one path item
at each declaration's explicit `http.path` when `http.openapi` is true.

- **Never on by default.** The default consumption path is a CLI export
  (`acker openapi <document> [app-dir]`, in the existing `@ackerdb/cli`),
  which codegens, discovers the configured definition modules, and writes the document. It
  needs no database, port, or credential authority. The runtime endpoint
  `GET /_openapi.json` exists only when the serve options carry
  `openapiEndpoint`, whose value is the document's `info` — the listener never
  sees an app directory, so it cannot derive the application's identity, and a
  bare `true` could not answer with the export's bytes. It serves a document
  assembled after synchronous definition registration and before
  `Runtime.start()` — the registry is immutable afterward, so the document is
  too — encoded exactly as the export writes it, so the served and
  the exported document are byte-identical. Absent, the path is a 404 like any
  other unclaimed route, and an undocumentable function fails registration
  rather than the first caller.
- OpenAPI 3.1. Schemas come from the shared contract→JSON Schema module
  (below) targeting draft 2020-12: `args` → request schema, `returns` →
  response schema (functions without `returns` document an untyped value —
  flagged `x-ackerdb-untyped`, not hidden). Declared errors become per-status
  responses with the `ApplicationError` body schema, several codes at one
  status becoming a `oneOf`; every operation also documents the bare `Outcome`
  as its `default` response. Mutation receipt headers and the
  `Idempotency-Key` parameter are documented on every mutation operation, on
  its application-error responses too. An SSE operation documents its
  `text/event-stream` response as the *frame envelope* it actually writes — a
  `oneOf` of `sse_chunk` (whose `value` is the `yields` schema), `sse_done`, and
  `sse_error` (whose `outcome` is the `Outcome` schema) — and states the
  acknowledgement the receiver owes, because a client that reads an event as a
  bare chunk misparses every one and stalls out after one event.
  `operationId` is derived from the address, never the URL; the top-level
  module — the segment after the fixed root — is the tag; bearer auth is
  the security scheme, declared document-wide as optional because the function's
  own policy — not the transport — decides whether a caller may be anonymous.
- A query has two operations for its two methods, and two operations cannot
  share an `operationId`: POST is the form every kind answers, so it owns the
  address, and the GET form is `<address>.get`. Two addresses can still collide
  on one id — a query at `api.notes.list` and a function at
  `api.notes.list.get` own different paths but the same `api.notes.list.get` —
  so the walk tracks emitted
  ids and refuses the document naming both addresses, the same way an
  undocumentable function fails registration and the CLI export.
- The document's `info` is the *application's* identity, not AckerDB's: the
  app directory's `package.json` name and version, or the directory's own name
  at `0.0.0` when it ships none. The methods and header names come from
  `transport/http-surface.ts`, the same module the listener serves from, so a
  documented method or header cannot drift from the served one.

### Shared schema module

`validation/json-schema.ts` owns every schema AckerDB publishes through
`validatorJsonSchema(validator, options)`. Registered `args` are ordinary object
validators, so OpenAPI needs no shape-specific adapter. See [Scopes](scopes.md)
for how a function's scopes sit alongside its access policy.

## Registration-time validation

- A `_`-prefixed module segment is refused during definition discovery. A raw
  or contract application route may not claim a built-in path or one under a
  `_`-marked namespace; route registration enforces that HTTP invariant.
- Two routes claiming one path are refused at load, whether they
  are two exposed functions, two raw routes, or one of each. A collision with a
  framework route is refused when the application batch enters the live
  registry, which happens before readiness.
- Two module files claiming one name are refused where the name is decided, in
  definition discovery, naming both files: `app/orders.ts` beside
  `app/orders/index.ts`, and an `app/index.ts` with no directory to
  be named after. The `index.ts` collapse is the only way two files reach one
  name, so this is one check rather than a rule per shape.
- A malformed `http` field (anything other than the documented shape) is a
  registration error.
- A field no declaration consumes is a registration error naming it, exactly as
  for an `http` route. An intersection parameter turns off TypeScript's
  excess-property check, so a misspelled key would otherwise be dropped in
  silence and read as an expectation nothing meets.

## Client impact

`@ackerdb/client` keeps the WebSocket for queries, mutations, and procedures.
`sse()` posts a raw standard-JSON args body to `/_sse/open` and carries the
generated function address in `x-ackerdb-function`; acks go to `/_sse/ack`.
It reads chunk values as standard JSON, never as wire escapes. The ack request
itself stays a Protocol-2 frame. Code generation therefore needs only the
canonical function address and the args/chunk types. It neither knows nor emits
the optional public HTTP path.

One consequence is open: a streamed chunk is typed by `yields` through
codegen, but the client holds no validators, so a chunk field declared
`v.bigint()` arrives as its decimal string while the generated type still says
`bigint`. Every chunk shape AckerDB streams today (text deltas, AI SDK UI
message chunks, JSON payloads) is unaffected. Closing it means teaching
codegen to type a streamed chunk by its standard-JSON form — a separate
change, tracked as a follow-up rather than smuggled into the transport.

## Packaging

Everything lands in `@ackerdb/server` (plus the CLI command in
`@ackerdb/cli`). No new publish unit, no new seam: the route surface shares
the listener, auth, and admission that `/api/call` used.

## Out of scope

- Client procedures over HTTP.
- Channels and subscriptions over HTTP (WS-owned).
- GET/`EventSource` SSE variant.
- Durability-wait option for mutations.
- Cache-Control policy for value responses (an SSE response's `no-cache,
  no-transform` is transport correctness, not policy), `/v1` path versioning,
  per-audience OpenAPI documents (per-function flags are the single source of
  truth).

## Implementation anchors

What exists and is reused unchanged: `executeQuery` (transport-free query
boundary), `runProcedure`/`runSse` (HTTP-native; they need the envelope parse
replaced with path+body, and `runProcedure` emits the plain value instead of a
`ProcedureOkMessage` frame), the coordinator's optional
`IdempotencyIdentity`, `outcomeHttpStatus`, the standard-schema JSON Schema
emitters, and the HTTP ingress (auth lease, admission, `parseHttpBody`, and
CORS) in `transport/server.ts`. New work: `runQuery`/`runMutation` HTTP
siblings of `runProcedure`, the `http` definition field and its registry
plumbing, receipt headers, the shared schema module extraction, the OpenAPI
walk, the CLI export, the `_` route renames, and deleting the envelope routes
plus their core types and tests.

The wire format and schema are implemented by each validator's own `decode`,
`encode`, and `toJsonSchema` methods. Composite validators invoke those same
methods on their children; no external compiler reinterprets validator kinds.
A public-route closure retains the address and function; the typed SSE route
resolves its header address through the Registry. Runtime uses the registered
validators directly for arguments, return values, SSE chunks, and declared
error bodies. OpenAPI
independently walks `registry.functions`, the sole addressable-function
collection, and uses only definitions whose HTTP declaration permits
documentation. The structural mapping for values no
validator describes is `toStandardJson` in `@ackerdb/core`, which the client
uses for the same surface's request side.
