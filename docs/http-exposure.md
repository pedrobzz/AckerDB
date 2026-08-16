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
[HTTP routes](http-routes.md). Both sides are the same `Http` value in the same
registry — see [ADR-0033](adr/0033-one-http-route-model-and-one-registry.md);
what differs is that this side derives its path from an address and is served
through its contract.

## Motivation

Every registered function is callable today, but only through Protocol-2: the
WebSocket session for queries and mutations, and the envelope routes
`POST /api/call` / `POST /api/sse` for procedures. External services and
non-JS consumers need a normal HTTP surface with per-function paths, plain
JSON in and out, and a machine-readable schema. The runtime already has every
piece this needs: an HTTP listener with auth, admission, and body limits; a
transport-free query boundary (`executeQuery`); an HTTP-native procedure path
(`runProcedure`); and `v` validators that emit JSON Schema.

## The surface

An exposed function at address `api.messages.list` is served at
`/api/messages/list`: the URL is the address, segment for segment, and the
address begins with the fixed application root `api` — see
[Application addresses](#application-addresses). The wire format is plain JSON
— no protocol envelope. `ref` lives in the path, correlation is the HTTP
response itself, and the protocol version is the package version (no `/v1`
segment; the surface versions with the lockstep release, breaks are explicit).

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
- Callers send no request id. The listener numbers path-addressed calls from
  its own monotonic sequence; the id never reaches the response.
- A value response emits no `Cache-Control`; caching policy belongs to the
  operator. An SSE response is not policy — it sets
  `Cache-Control: no-cache, no-transform` (and `X-Accel-Buffering: no`), because
  a buffered or transformed stream is not a stream. Both carry
  `Vary: Authorization`: one URL answers different bearer credentials with
  different bodies, and the GET query form is the cacheable one.
- CORS allows the methods the listener serves: `GET, POST, OPTIONS` for the
  exposed function surface, plus `PUT, PATCH, DELETE` for raw HTTP handler
  routes. It accepts `Idempotency-Key` beside `Content-Type` and
  `Authorization`, and exposes the receipt and SSE stream headers so a browser
  caller can read the values documented below.

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

The codec is compiled from the contract once per exposed function, at
registration:

- A contract AckerDB cannot carry across a JSON boundary (`v.primaryKey()`,
  `v.scheduleAt()`, `v.tag()`) is a **registration error** naming the function
  and the part of the contract that cannot cross, never a failure at call time.
- A value with no validator to describe it — `returns` omitted, or an
  application error whose code the function does not declare — crosses through
  the same structural mapping. Declaring a validator changes what a caller is
  *promised*, never what one receives.
- A validator AckerDB did not build (a hand-written `Validator`, as AI chunk
  streams use) crosses structurally too, and its own `check` remains the single
  word on what is valid. No JSON Schema can describe such a kind, so an
  operation carrying one fails the *document* — at export or activation, per
  the OpenAPI rules below — not the call.

### SSE

The SSE response carries the existing stream contract unchanged:
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

**The framework's own routes live at the root, behind the `_` marker.** `/api/`
belongs to application addresses, so a protocol endpoint nested under it would
be squatting in application-owned space — there was never a principle
separating `/ws` at the root from `/api/_files` below it, only history. `_`
belongs to AckerDB at the HTTP root, and directly under `/api/`, so a future
built-in route can never collide with an *exposed function's* derived path.

**Only exposed functions derive their path from an address.** A raw
[HTTP route](http-routes.md) states its URL explicitly and may claim anything
outside the reserved set — the root included — because an external provider
frequently dictates it. That is why the second segment is reserved beneath
`/api/` and nowhere else: `/webhooks/_raw` is a provider's name for a path
AckerDB will never serve.

| Route | Fate |
| --- | --- |
| `/api/call` | deleted (replaced by per-function paths) |
| `/api/sse` | deleted (replaced by per-function paths) |
| `/ws` | → `/_ws` |
| `/api/sse/ack` | → `/_sse/ack` |
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
`functions/admin/users.ts` exporting `list` is addressed
`api.admin.users.list`. Code generation exports one `api` reference tree, jobs
record the same address, socket calls send it unchanged, and an HTTP-exposed
function answers at `/api/admin/users/list`.

**An address never decides admission.** Every declaration still requires an
`access` policy, and may add a scope requirement. `access: "system"` admits
only the local system principal; a public or authenticated declaration is
admitted according to that policy regardless of its module name. Plain HTTP
also remains opt-in: a function without `http` has no URL.

The module path is therefore the only application namespace. A function moved
from `functions/users.ts` to `functions/admin/users.ts` deliberately changes
from `api.users.<export>` to `api.admin.users.<export>` on every surface.

**A file named `index.ts` takes its directory's name.**
`functions/orders/index.ts` publishes `api.orders.*`, so a directory can hold a
module of its own name beside its siblings. Two files may not claim one name:
`functions/orders.ts` beside `functions/orders/index.ts` is a startup refusal
naming both, and so is a `functions/index.ts` with no directory to be named
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
  http: true,                    // exposed, in OpenAPI
  args: { channel: v.string() },
  handler: async (ctx, args) => { ... },
});

export const purge = mutation({
  description: "Remove every message in a channel.",
  http: { openapi: false },      // exposed, hidden from OpenAPI
  args: { channel: v.string() },
  handler: async (ctx, args) => { ... },
});
```

- `http?: boolean | { openapi: boolean }` — absent or `false` means not
  reachable over HTTP and absent from OpenAPI. `true` is shorthand for
  `{ openapi: true }`. Because `openapi` only exists inside an exposed
  function's config, "in OpenAPI but not callable" is unrepresentable at the
  type level; registration validates the same shape for untyped callers.
- `description` (optional, all four kinds) feeds the OpenAPI operation
  description. `title` likewise (OpenAPI summary).
- The flags govern only this surface. WebSocket reachability is unchanged
  and unconditional; hiding a function from HTTP does not hide it from
  Protocol-2, and access control remains auth + function policy on both
  transports.

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

The generator lives in `@ackerdb/server` and walks the registry: one
operation per exposed function with `openapi` not disabled.

- **Never on by default.** The default consumption path is a CLI export
  (`acker openapi <document> [app-dir]`, in the existing `@ackerdb/cli`),
  which codegens, loads the function modules, and writes the document. It
  needs no database, port, or credential authority. The runtime endpoint
  `GET /_openapi.json` exists only when the serve options carry
  `openapiEndpoint`, whose value is the document's `info` — the listener never
  sees an app directory, so it cannot derive the application's identity, and a
  bare `true` could not answer with the export's bytes. It serves a document
  assembled once at activation — the registry is immutable after load, so the
  document is too — encoded exactly as the export writes it, so the served and
  the exported document are byte-identical. Absent, the path is a 404 like any
  other unclaimed route, and an undocumentable function fails the activation
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
  `operationId` is the address; the top-level module — the segment after the
  fixed root — is the tag; bearer auth is
  the security scheme, declared document-wide as optional because the function's
  own policy — not the transport — decides whether a caller may be anonymous.
- A query has two operations for its two methods, and two operations cannot
  share an `operationId`: POST is the form every kind answers, so it owns the
  address, and the GET form is `<address>.get`. Two addresses can still collide
  on one id — a query at `api.notes.list` and a function at
  `api.notes.list.get` own different paths but the same `api.notes.list.get` —
  so the walk tracks emitted
  ids and refuses the document naming both addresses, the same way an
  undocumentable function fails activation and the CLI export.
- The document's `info` is the *application's* identity, not AckerDB's: the
  app directory's `package.json` name and version, or the directory's own name
  at `0.0.0` when it ships none. The methods and header names come from
  `transport/http-surface.ts`, the same module the listener serves from, so a
  documented method or header cannot drift from the served one.

### Shared schema module

`validation/json-schema.ts` owns every schema AckerDB publishes:
`argsJsonSchema(args)` for an `ObjectShape` and
`validatorJsonSchema(validator, options)` for a `returns` or `yields`. The
OpenAPI generator is its only consumer, and the standard-JSON codec keeps only
decode/encode. See [Scopes](scopes.md) for how a function's scopes sit
alongside its access policy.

## Registration-time validation

- A `_`-prefixed module segment is refused for *every* function, exposed or
  not: the CLI manifest loader rejects a function-module path segment that is
  not a plain identifier, so an app loaded the normal way never reaches the
  registry at all. The registry's own check — an application route may not
  claim a built-in path or one under a `_`-marked namespace — is the narrower
  second net, for a `Registry` constructed directly from modules, and it
  covers derived and explicit paths alike.
- Two routes claiming one path are refused at load naming both, whether they
  are two exposed functions, two raw routes, or one of each. A collision with a
  framework route is refused when the application batch enters the live
  registry, which happens before readiness.
- Two module files claiming one name are refused where the name is decided, in
  the CLI manifest loader, naming both files: `functions/orders.ts` beside
  `functions/orders/index.ts`, and a `functions/index.ts` with no directory to
  be named after. The `index.ts` collapse is the only way two files reach one
  name, so this is one check rather than a rule per shape.
- An HTTP-exposed function whose contract cannot cross the standard-JSON
  boundary is a registration error (see *Wire format*).
- A malformed `http` field (anything other than the documented shape) is a
  registration error.
- A field no declaration consumes is a registration error naming it, exactly as
  for an `http` route. An intersection parameter turns off TypeScript's
  excess-property check, so a misspelled key would otherwise be dropped in
  silence and read as an expectation nothing meets.
- An exposed function's kind is narrowed to the four this surface serves at
  registration, and an exposure no method serves is a registration error like
  every other malformed one. The narrowed kind is what the listener and the
  OpenAPI walk both read, so an unservable exposure can never reach a caller as
  a generic 404 while being silently dropped from the document.

## Client impact

`@ackerdb/client` keeps the WebSocket for queries, mutations, and procedures
— this surface targets external callers, and moving client transport is a
separate discussion. The client changes are the URL renames — `sse()` calls
the per-function path with a raw args body, and acks go to `/_sse/ack` —
plus the wire format that path speaks: `sse()` encodes its args as standard
JSON (`toStandardJson` in `@ackerdb/core`) and reads chunk values as standard
JSON, never as wire escapes. The ack request itself stays a Protocol-2 frame.
Because that path is the exposed one, an `sseProcedure` the client streams
must carry `http`.

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

Dispatch itself is no longer this surface's concern. An exposed function is
compiled at activation into one canonical `Http` value — the derived path, the
methods its kind answers plus the framework CORS preflight, and one closure
per method carrying everything `call` does — and added to the same
`HttpRegistry` every other route lives in
(`transport/routing/`, and `AckerDBServer.exposedRoute`). The method table it
compiles from is `EXPOSED_HTTP_METHODS`, which is also what the OpenAPI walk
reads, so the served methods and the documented ones cannot drift.

The wire format reuses `compileStandardJsonCodec`
(`validation/standard-schema.ts`) — there is no second codec. `transport/http-codec.ts` compiles one per exposed
function and the registry hangs it on `ExposedFunction`; the listener decodes
args through it and the Runtime encodes the return value, every sse chunk, and
a declared error body through it. The structural mapping for values no
validator describes is `toStandardJson` in `@ackerdb/core`, which the client
uses for the same surface's request side.
