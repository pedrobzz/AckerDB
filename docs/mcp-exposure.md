# MCP exposure

Status: implemented. This document is the contract for exposing
registered queries, mutations, and procedures as MCP tools. Authentication
and scopes are not MCP-local: endpoints authenticate ordinary identity
credentials and tool requirements draw from the application scope vocabulary
— see `docs/scopes.md`. Divergences discovered during implementation must
update this document.

## Motivation

`docs/http-exposure.md` lists *"tool-from-function MCP derivation (own feature;
auth-bridge design)"* under **Out of scope**. This is that feature.

After #134 the two external surfaces already share everything that is hard.
They compile the same codec (`compileStandardJsonCodec`) and publish schemas
from the same emitter (`validation/json-schema.ts`, extracted out of the MCP
path precisely so both could read it). An HTTP-exposed query and an MCP tool
put byte-identical standard JSON on the wire.

What they do not share is how you declare one. HTTP exposure is a flag on a
function. MCP exposure is a rewrite: `mcpTool` blueprints with their own
context type, their own transaction contract, their own access model, no
error declarations, and no way to reach a function you already wrote. A read
that already exists as a `query` — validated, policied, tested, live over the
WebSocket — cannot be handed to a model without being written a second time.

This collapses that. A tool becomes a registered function named in an
endpoint's `tools` record.

## The surface

An MCP tool is a registered `query`, `mutation`, or `procedure` listed in an
endpoint's `tools` record. The record key is the tool's protocol name.

| Kind | As a tool | Notes |
| --- | --- | --- |
| query | one-shot read in a read transaction, `ctx.db` reader | not subscribed; MCP has no reactive form |
| mutation | write transaction, full commit path | the receipt is dropped, see below |
| procedure | no ambient transaction, `ctx.tx(...)` | the shape every tool has today |
| sse | **not a tool** | compile error; MCP has no streaming tool result |

A function may instead declare `returns: mcpContent()`, which contracts MCP
content blocks — text, image, audio, resource links, embedded resources —
rather than a JSON value. Content is wider than any JSON contract, so such a
function publishes no `outputSchema`, answers no `structuredContent`, and
`http: true` on it is a registration error: an HTTP caller has nowhere to put an
image. It is an ordinary function in every other way; only its return contract
differs.

A mutation's commit receipt has no channel here and is discarded rather than
smuggled into `_meta`. This is not a loss: an MCP caller holds no
subscriptions, so it owes no convergence obligation — the same reasoning
`runtime.ts` already records for HTTP callers ("An HTTP caller holds no
subscriptions, so it owes no convergence obligation"). A tool that needs a
commit version should return it.

Reachability is unchanged on every other transport. Naming a function as a
tool does not alter its WebSocket or HTTP behaviour, and access control
remains auth plus function policy everywhere.

## Authentication and scopes

There is no MCP-local auth system. An MCP endpoint authenticates ordinary
identity credentials (`ackerdb_credential.<id>.<secret>` bearers issued
through the app-wide `credentials` / `systemCredentials` API), and every tool
entry's scope requirement draws from the one application vocabulary declared
in `defineApp({ scopes })` — see `docs/scopes.md` for the vocabulary, the
grant model, the child-credential subset invariant, and live invalidation.

Consequences for this surface:

- A credential is not endpoint-bound: any endpoint accepts any valid
  credential, and tool `access` requirements are the separation. Scopes are
  checked against the caller Identity's effective grant.
- Credentials are first-class Identities: the same bearer also authenticates
  the WebSocket client API and exposed HTTP functions, as an ordinary `user`
  principal carrying the credential's own child Identity.
- `limits.credentials.maxPerIdentity` bounds credentials per issuing Identity.

## Declaring an endpoint

```ts
// mcp/admin.ts
import { mcp } from "../_generated/server";
import { api } from "../_generated/api";

export const admin = mcp({
  name: "admin",
  tools: {
    get_order: {
      fn: api.orders.get,
      access: { anyOf: ["read"] },
      annotations: { readOnlyHint: true },
    },
    purge_orders: {
      fn: api.orders.purge,
      access: { allOf: ["write"] },
      annotations: { destructiveHint: true },
      private: true,
    },
  },
});
```

The function itself is untouched and knows nothing about MCP:

```ts
// functions/orders.ts
export const get = query({
  description: "Return one order by id.",   // required to be a tool
  http: true,
  args: { orderId: v.bigint() },
  returns: v.object({ id: v.bigint(), status: orderStatus }),
  access: "authenticated",
  handler: (ctx, args) => ctx.db.orders.get(args.orderId),
});
```

### Entry fields

| Field | Default | Meaning |
| --- | --- | --- |
| `fn` | — | the registered query, mutation, or procedure |
| `access` | `"authenticated"` | `"public"`, `"authenticated"`, `{ anyOf }`, `{ allOf }` |
| `annotations` | — | `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` |
| `private` | `false` | in-app callers only, see below |

`description` and `title` come from the function; there is no per-entry
override. Everything else lives on the entry because the endpoint is the
curation surface: a function stays MCP-unaware, and a plain query becomes a
tool without its own file being edited.

Two costs are accepted deliberately:

- The same function on two endpoints repeats its `access` and `annotations`.
- **There is no name derivation.** The record key is always written by hand.
  A tool list is a prompt — its names, granularity, and length are authored
  for a model's decision quality, not generated from module paths. A surface
  that fills itself in is the failure mode this design is avoiding, not a
  convenience it is missing.

### Access

The entry's `access` and the function's own `accessPolicy` (including its own
`scopes` requirement, if any) both run; both must pass. Note that
`"authenticated"` on the function is satisfied by *any* valid credential —
the entry's `access` is where per-tool separation happens.

`access` defaults to `"authenticated"`, so a forgotten entry is reachable by
any token but never anonymously. `"public"` exists and must be written
explicitly; it is the one value that opens a tool to unauthenticated callers,
and it should read as a decision, not as an omission.

A function whose `accessPolicy` is `"system"` is a **registration error** in a
tools record. It would execute as the MCP principal and fail its own policy on
every call — a guaranteed-broken tool. `private` is how an internal-only tool
is expressed now, and it does not require elevating anyone's authority.

## Private endpoints and private tools

Two levels, both meaning "reachable in-app, never over the wire":

```ts
export const agentTools = mcp({
  name: "agent",
  private: true,          // claims no path, never served
  tools: { ... },
});
```

- **Endpoint-level** `private: true` claims no path and is never served. It is
  reachable only through `aiTools`. Declaring `path` alongside it is a compile
  error, so "private but somehow addressable" is unrepresentable at the type
  level — the same technique #134 used to make "documented but not callable"
  unrepresentable.
- **Tool-level** `private: true` hides one tool on an otherwise served
  endpoint.

Enforcement is at `authorizeMcpTool`, the single choke point for `tools/call`
("resolve one callable tool without trusting discovery or revealing
inaccessible names"). Filtering `toolsFor` alone would hide a tool from
`tools/list` while leaving it callable by name, which is security theatre.

The local/remote discriminator is the explicit local grant an `aiTools`
delegation passes into `authorizeMcpTool`: absent means "this call came from
outside the app".

`aiTools` includes private tools; serving them is its entire purpose. It stays
on the endpoint, since it is typed by the tool set.

## Wire format

Identical to the HTTP surface: standard JSON compiled per function by
`compileStandardJsonCodec`, with schemas from `validation/json-schema.ts`. The
validator mapping (`v.bigint()`, `v.identity()`, `v.file()`, and
`v.fileGrant()` as canonical decimal strings, `v.bytes()` as padded base64,
nothing escaped) is specified in
`docs/http-exposure.md` under *Wire format* and is not restated here. A
contract that cannot cross that boundary is a registration error, as it is
there.

Arguments become the tool's `inputSchema` from the function's `args`.

### Output

`returns` is **required** for a function used as a tool. A tool with no
`outputSchema` gives a model nothing to reason about, which is the same class
of defect as a missing description. `mcpContent()` satisfies it by declaring the
other contract.

| `returns` | `structuredContent` | published `outputSchema` |
| --- | --- | --- |
| an object validator | that object, raw | the object's schema |
| anything else | `{ "value": <encoded> }` | `{"type":"object","properties":{"value":…},"required":["value"]}` |

The wrap is forced by the protocol: `Tool.outputSchema` must be
`{"type": "object"}` and `structuredContent` must be an object. The `content`
block array is a different field and is not a place to put a typed value. The
key is `value` to match `ExposedHttpCodec.encodeValue` and `sse_chunk`'s
`value`.

A consequence worth stating plainly: the same function on both surfaces
answers HTTP with the raw value and MCP with the wrapped one. Two response
shapes, one contract, both published.

### Errors

A **declared application error** becomes a normal tool result:

```json
{
  "isError": true,
  "content": [{
    "type": "text",
    "text": "{\"code\":\"order_not_found\",\"body\":{\"orderId\":\"91\"}}"
  }]
}
```

The model reads it and can recover — retry with another id, or ask the user.
It deliberately does not use `structuredContent`: an error body will not match
the tool's declared `outputSchema`. It deliberately is not a JSON-RPC error
either, because hosts treat those as a broken tool and usually abort the turn,
which is the wrong outcome for an expected business result. The declaration's
HTTP `status` is unused on this surface.

**Protocol-level failures** — `malformed`, `validation`, `unauthenticated`,
`unauthorized`, `not_found` — remain JSON-RPC errors under the existing
`mcpErrorResponse` mapping, unchanged.

## Registration-time validation

Compile errors, in preference order:

- a scope name not declared by the application vocabulary;
- an `sseProcedure` as an entry's `fn`;
- `path` on an endpoint declared `private: true`;
- a missing `access` is *not* an error — it defaults to `"authenticated"`.

Registration errors, which also cover untyped callers constructing a
`Registry` directly:

- a tool function that does not declare `description`;
- a tool function that does not declare `returns`;
- a tool function whose `accessPolicy` is `"system"`;
- a tool function whose contract cannot cross the standard-JSON boundary;
- a record key that fails the tool-name pattern or the 63-byte limit;
- duplicate tool names within an endpoint, and duplicate endpoint names or
  paths (both already checked);
- an endpoint path colliding with a built-in route, the reserved `_` root, or an
  exposed function path (already checked).

## Client impact

A tool is now a registered function, so it has an address and appears on the
generated `api` object. `accessPolicy` still governs whether a client may call
it; membership in a tools record is not itself a client-visible property and
does not filter codegen. A function may legitimately be a client query, an
HTTP route, and a tool at once — that reuse is the point.

A tools record may name a function from any API path (ADR-0023) — a tool entry
groups nothing and grants nothing. The endpoint is its own declaration with its
own authentication, and the named function keeps answering wherever its own
group and its own `access` say it does.

## Breaking changes

No compatibility shim, in either direction.

- `mcpTool`, `McpToolBlueprint`, `McpToolCtx`, the blueprint `WeakMap`, and the
  endpoint scope descriptor are deleted. Every existing tool is rewritten as a
  `query`, `mutation`, or `procedure` declaring `description` and `returns`.
- `createMcp` becomes `mcp`; the scope vocabulary lives in
  `defineApp({ scopes })`.
- Token administration is the app-wide `credentials` / `systemCredentials`
  API; there is no per-provider surface.
- `McpToolCtx.tx` returning a raw `Awaited<R>` disappears with it; a tool now
  gets its kind's own context, so `ctx.tx` follows `ProcedureCtx`'s
  `FunctionResult<R>` contract like everything else.
- A tool returning MCP content blocks declares `returns: mcpContent()`; the
  content shapes themselves are unchanged.
- The demo pins a published `@ackerdb/server`, so its nine tools convert with
  whichever change repins it — exactly as #134 left its own demo half.

## Out of scope

- Streaming tools. MCP progress notifications are not implemented, so
  `sseProcedure` has no analog.
- Name derivation and bulk exposure forms.
- MCP resources and prompts.
- Codegen access filtering (pre-existing, unrelated).

## Implementation anchors

Reused unchanged: `compileStandardJsonCodec`, `validation/json-schema.ts`,
`authorizeMcpTool` as the single `tools/call` choke point (its explicit local
grant is the local/remote discriminator), `isMcpToolAuthorized`, the
credential vault's declarative internal objects, and the invocation path's
existing access enforcement — a tool runs through `invokeFunction` like every
other call, so argument validation, policy, and function-level scope
requirements cannot be skipped.

New work: `mcpContent()`
and the codec branch that skips the structured path for it; a tool dispatch that
runs in its own invocation root, so a canceled transaction inside a tool cannot
poison the caller; the tools-record
entry type, whose `Scope` parameter codegen binds to `AppScope<App>` so an
undeclared scope name is a compile error; the output codec's
object-passthrough/wrap branch; the `isError` mapping for declared
application errors; `private` filtering in `authorizeMcpTool` and `toolsFor`;
endpoint-level `private` in the registry's path claiming; and the codegen
emitter for `mcp`.

Deleted: `mcpTool` and its blueprint machinery, `McpToolCtx`, the per-endpoint
scope descriptor, and the tests that pin them.
