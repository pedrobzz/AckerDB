# Raw HTTP handlers

Status: implemented. This document is the contract for `httpHandler`, the
deliberate contract-less boundary of the HTTP surface: webhooks whose
authentication is an HMAC over the exact wire bytes, OAuth redirect callbacks,
challenge echoes — any endpoint whose request and response shapes are dictated
by an external party rather than by the application's own contract.

An `httpHandler` is served raw; a function with `http: true` is served through
its contract (see [HTTP exposure](http-exposure.md)). Those are the two ways
onto the HTTP surface, and each is complete for its side: pressure to add
validators here belongs on an exposed procedure, and pressure to add raw-body
access there belongs here.

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
  wants preflight declares `OPTIONS` in its `methods` and answers it itself.
  The response body may stream.

What the framework keeps is survival, not semantics: admission control and
`maxRequestBytes` run before the handler (the body is buffered, so an
over-limit or slow-loris body answers without the handler existing), and every
framework-authored response speaks the bare `Outcome` the rest of the surface
speaks — admission shed, over-limit, `405` with `Allow` for an undeclared
method, `503` before readiness, and the sanitized `internal` `500` for an
uncaught throw, whose cause never reaches the wire. A
handler that returns anything that is not a `Response` is the same defect,
answered identically.

## Declaring a handler

```ts
// functions/hooks.ts
import { httpHandler } from "../_generated/server.ts";

export const stripe = httpHandler({
  methods: ["POST"],
  handler: async (ctx, request) => {
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

- The route is address-derived like every other function: the address is
  `<apiPath>.<module path>.<export name>` and the URL is that address, segment
  for segment — `hooks.stripe` is addressed `api.hooks.stripe` and serves
  `/api/hooks/stripe`, and `apiPath: "internal"` addresses it
  `internal.hooks.stripe` at `/internal/hooks/stripe`. There is no router and no path field; a
  webhook URL is a thing pasted into a provider's dashboard, and the reserved
  `_` marker plus the path-collision checks apply at registration exactly as
  they do for exposed functions.
- `methods` is an explicit non-empty list drawn from GET, HEAD, POST, PUT,
  PATCH, DELETE, OPTIONS — no wildcard. An empty list, an unknown method, a
  repeated method, or a non-function handler is a registration error naming
  the export, whether the definition came through the builder or an untyped
  module. The definition carries exactly `apiPath`, `methods`, and `handler`:
  there is no `args`, `returns`, `description`, or `access`, because nothing
  consumes them — no validators, no OpenAPI operation, no policy.
- Validation is userland: any `v` validator's own `check` runs by hand inside
  the handler, and the response to invalid input is the handler's decision —
  Stripe's "answer 200 for unrecognized events" is expressible here and
  nowhere else.

## The handler context

A strict subset of the procedure context, built by the same machinery and
typed from the generated module (`HttpHandlerCtx`):

| Field | What it is |
| --- | --- |
| `timestamp` | The runtime's read timestamp. |
| `abortSignal` | Fires when the caller disconnects or the Runtime shuts down. |
| `tx` | A transaction with application authority. |

The auth members (`auth`, `linkAccount`, `unlinkAccount`) are deliberately
absent: raw routes resolve no credential, so they could only ever carry a
hardcoded anonymous. `tx` holds application authority because the handler is
application-owned code at the boundary. An authenticated caller speaking
AckerDB's own bearer scheme belongs
on a contract function, which is the surface built for that; if a later
feature adds opt-in framework auth here, `auth` has an obvious place to
return to.

## Reachability

- The kind exists only at the HTTP boundary. It has no Protocol-2 form, no
  client reference (generated APIs erase the export), and no OpenAPI
  operation — ever, not as an option.
- The listener numbers raw-route requests from the same monotonic sequence as
  path-addressed calls; the id never reaches the response. Cancellation is the
  request abort, surfaced as
  `ctx.abortSignal`.
- `Runtime.runHttpHandler` is the direct entry point — a buffered `Request`
  in, the handler's `Response` out — which is also how a handler is tested
  without a live listener.

## Out of scope

- Request-body streaming to the handler (the body is buffered; the byte bound
  is what makes that safe).
- Per-handler request-size overrides; the global `maxRequestBytes` applies.
- Opt-in framework auth and any `access` policy field.
- Framework-provided signature-verification helpers.
- A router or path configuration surface; addresses stay derived.
