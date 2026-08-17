# HTTP routes

Status: implemented. This document is the contract for `http`, the one way to
put anything on AckerDB's HTTP surface that is not a contract function: the
deliberately contract-less boundary for webhooks whose authentication is an
HMAC over the exact wire bytes, OAuth redirect callbacks, challenge echoes —
any endpoint whose request and response shapes, and whose URL, are dictated by
an external party rather than by the application's own contract.

An `http` route is served raw; a function with `http: true` is served through
its contract (see [HTTP exposure](http-exposure.md)). Those are the two ways
onto the HTTP surface, and each is complete for its side: pressure to add
validators here belongs on an exposed procedure, and pressure to add raw-body
access there belongs here.

## One model, one table

There is exactly one HTTP route model, and the framework uses it too. `/live`,
`/ready`, `/status`, the File byte routes, the WebSocket door, the SSE receiver
credit, the OpenAPI document, every exposed function, and every route below are
the same value — an explicit path and a method-keyed map of handlers — living
in one registry. The listener's `fetch` is one permanent function that asks
that registry for a route; it never branches on what kind of route it found.

That split is the point:

- **The registry owns generic HTTP.** Matching a path, preferring the more
  specific pattern, extracting and decoding captures, selecting a method,
  answering `405` with a complete `Allow`, and answering an unmatched path.
  Matching is `rou3`, a radix router; AckerDB owns the published grammar and
  translates it once at insertion (see [ADR-0033](adr/0033-one-http-route-model-and-one-registry.md)).
- **Handlers own AckerDB policy.** Reachability, admission, authentication,
  validation, codecs, idempotency, body limits, response shaping. A route being
  registered and a route being reachable are different questions.

## Declaring a route

```ts
// functions/hooks.ts
import { http } from "../_generated/server.ts";

export const stripe = http("/hooks/stripe", {
  POST: async (ctx, request) => {
    const payload = new Uint8Array(await request.arrayBuffer());
    if (!verifySignature(request.headers.get("stripe-signature"), payload)) {
      return new Response(null, { status: 401 });
    }
    const event = JSON.parse(new TextDecoder().decode(payload));
    await ctx.tx((tx) => tx.db.events.insert({ type: event.type }));
    return Response.json({ received: true });
  },
});
```

- **The path is explicit.** A webhook URL is a thing pasted into a provider's
  dashboard, and the provider frequently dictates its shape; a path derived
  from a module and export name cannot answer that. The export's address
  (`api.hooks.stripe`) still names the export — for duplicate-export refusals
  and for the loader's diagnostics — but it no longer decides the URL.
- **Methods are keys, not a list.** A route serving `GET` and `POST` names both
  and writes no `request.method` switch. When two methods share an
  implementation deliberately, assign the same handler value to both keys.
  Separate `Http` values may contribute disjoint methods to the same pattern;
  claiming an owned path-and-method pair is a registration error.
- `http` returns the opaque executable `Http` value the registry consumes.
  Application code declares only the path and handlers; routing machinery is
  not part of its interface.
- Validation is userland: any `v` validator's own `check` runs by hand inside
  the handler, and the response to invalid input is the handler's decision —
  Stripe's "answer 200 for unrecognized events" is expressible here and
  nowhere else.

## The path language

Three forms, and only three, because these are the three a literal path types
completely:

| Form | Example | What the handler sees |
| --- | --- | --- |
| static segment | `/hooks/stripe` | no parameters at all |
| named parameter | `/users/:id` | `ctx.params.id: string` |
| terminal wildcard | `/assets/*` | `ctx.params["*"]: string` |

```ts
export const asset = http("/orgs/:org/assets/*", {
  GET: (ctx) => fetchAsset(ctx.params.org, ctx.params["*"]),
});
```

- **The path types its captures.** `ctx.params` is derived from the literal
  path and filled by the router at runtime. A static route
  exposes no parameter keys, which makes a misspelled `ctx.params.userId` a
  compile error rather than `undefined`.
- **The type rejects a non-absolute literal; runtime validates the complete
  grammar.** Empty segments, misplaced wildcards, duplicate or malformed
  parameter names, and matcher syntax are registration errors.
- **Static text is static.** A segment may not carry `: * ( ) { } \ ? #`. The
  first two are AckerDB's own syntax; the rest are syntax to the matcher
  underneath, so a segment carrying one would quietly become a pattern in a
  language AckerDB does not publish rather than the literal text it looks like.
  A parameter name is letters, digits, `_`, and `-`, for the same reason: that
  is exactly what the matcher treats as a plain named parameter.
- **Two routes claiming the same URLs are refused**, whether or not they are
  spelled alike: `/users/:id` and `/users/:slug` match the same requests, and
  the parameter name is the author's vocabulary rather than the URL's.
- **Precedence is the established one**: an exact path outranks a named
  parameter, and a named parameter outranks the terminal wildcard. Matching is
  case-sensitive. A trailing slash matches the route without it.
- **Captures arrive decoded**, so a runtime value matches the `string` the path
  declared: `/users/a%20b` gives `ctx.params.id === "a b"`. A path whose escape
  cannot be decoded is a `malformed` outcome, not a missing route.
- The terminal `*` requires at least one segment: `/assets/*` serves everything
  below `/assets`, and `/assets` itself is a different route to claim.
- Not supported, deliberately: optional parameters, regular-expression
  parameters, two parameters in one segment, host constraints. No coercion
  either — every capture is a `string`.

Three edges are known and deliberately left alone, because a guard for any of
them would cost more than it is worth:

- A parameter matches an empty segment. `/users//x` matches `/users/:id/x`
  with `ctx.params.id === ""`; a handler that cares checks for it.
- Exactly one trailing slash is stripped, so `/live/` reaches `/live` but
  `/live//` does not.
- A wildcard capture is decoded as one string, so a `%2F` inside it is
  indistinguishable from a separator.

## Where a route may live

An explicit path may claim any URL AckerDB has not reserved. Reserved is:

- the built-in paths (`/live`, `/ready`, `/status`, `/_ws`, `/_sse/ack`,
  `/_files/…`, `/_openapi.json`);
- any path whose first segment carries the `_` marker;
- any path under `/api/` whose second segment carries it, so a future built-in
  route can never collide with an exposed function's derived path.

Everything else is the application's, including the root and including `/api/`
itself — a raw route may sit beside exposed functions if that is the URL a
provider wants. Two routes claiming one path is a load-time refusal naming
both, whether they are two raw routes, a raw route and an exposed function, or
an application route and a framework one.

The reservation is checked against the literal pattern. A route declared
`/:anything` therefore loads, and answers paths no built-in claims; the static
built-ins still win, because static outranks a parameter.

## Separately declared handlers

Inline handlers need no annotation. A handler declared apart from its route
takes one of the method aliases, which are exactly the canonical
`HttpHandler<Method, Path>` under shorter names:

```ts
import { http, type HttpHandlerGET } from "../_generated/server.ts";

const show: HttpHandlerGET<"/users/:id"> = (ctx) => Response.json({ id: ctx.params.id });

export const user = http("/users/:id", { GET: show });
```

`HttpHandlerGET`, `HttpHandlerHEAD`, `HttpHandlerPOST`, `HttpHandlerPUT`,
`HttpHandlerPATCH`, `HttpHandlerDELETE`, and `HttpHandlerOPTIONS` add nothing
of their own. Each narrows `request.method` to its own method, so
method-dependent code needs no assertion, and each takes only the literal path:
the generated module binds the application's `Schema` into the factory, the
`Http` type, the canonical generic, every alias, and the context.

## The symmetry rule

The framework touches neither the request nor a handler-authored response.

- **In**: no `v` validation, no args decode, no credential resolution. The
  handler receives a `Request` whose body bytes are exactly the wire bytes
  (`text()` / `arrayBuffer()` reproduce them for signature verification) and
  whose headers cross whole — `Authorization` included, whatever its scheme.
  Providers that send Basic auth or their own bearer tokens are never rejected
  by the framework; verification is the handler's job, and "no verification"
  is a choice the handler makes, not a default the framework hides.
- **Out**: the handler's `Response` leaves byte-for-byte. No CORS stamp, no
  `Cache-Control`, no `Vary`, no header injection of any kind. A handler that
  wants preflight declares an `OPTIONS` handler and answers it itself; a route
  that declares none answers `405` for `OPTIONS` like any other undeclared
  method. The response body may stream.

What the framework keeps is survival, not semantics: admission control and
`maxRequestBytes` run before the handler (the body is buffered, so an
over-limit or slow-loris body answers without the handler existing), and every
framework-authored response speaks the bare `Outcome` the rest of the surface
speaks — admission shed, over-limit, `405` with `Allow` for an undeclared
method, `503` before readiness and while draining, `404` for a path no route
claims, and the sanitized `internal` `500` for an uncaught throw, whose cause
never reaches the wire. A handler that returns anything that is not a
`Response` is the same defect, answered identically.

## The handler context

A strict subset of the procedure context, built by the same machinery and
typed from the generated module (`HttpHandlerCtx<Path>`):

| Field | What it is |
| --- | --- |
| `params` | The route's captures, typed from its literal path. |
| `timestamp` | The runtime's read timestamp. |
| `abortSignal` | Fires when the caller disconnects or the Runtime shuts down. |
| `tx` | A transaction with application authority. |

The auth members (`auth`, `linkAccount`, `unlinkAccount`) are deliberately
absent: raw routes resolve no credential, so they could only ever carry a
hardcoded anonymous. `tx` holds application authority because the handler is
application-owned code at the boundary. An authenticated caller speaking
AckerDB's own bearer scheme belongs on a contract function, which is the
surface built for that; if a later feature adds opt-in framework auth here,
`auth` has an obvious place to return to.

The original `Request` stays the whole Fetch surface: URL, query string,
headers, body, signal. `params` is on the context rather than on a framework
`Request` subtype, so nothing about the request object is AckerDB's.

## Reachability

- The kind exists only at the HTTP boundary. It has no Protocol-2 form, no
  client reference (generated APIs erase the export), and no OpenAPI
  operation — ever, not as an option.
- Application routes enter the live table through synchronous `add` calls
  during activation, followed by the readiness transition; no request can run
  between those operations. Before that, and while draining, they answer
  the established unavailable outcome rather than a 404: unreachable and
  absent are different statements. `/live` and `/ready` are registered before
  the port is bound and answer throughout Boot.
- The listener numbers raw-route requests from the same monotonic sequence as
  contract calls; the id never reaches the response. Cancellation is the
  request abort, surfaced as `ctx.abortSignal`.
- `Runtime.runHttpRoute` is the direct entry point — an `Http` value and a
  buffered `Request` in, the handler's `Response` out — which is also how a
  route is tested without a live listener.

## Out of scope

- Request-body streaming to the handler (the body is buffered; the byte bound
  is what makes that safe).
- Per-route request-size overrides; the global `maxRequestBytes` applies.
- Opt-in framework auth and any `access` policy field.
- Framework-provided signature-verification helpers.
- Query-string typing or body-schema inference; this surface types path
  parameters and methods.
- Application access to the live registry, route removal, and hot reload.
