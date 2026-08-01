# MCP exposure

Status: specified, not implemented. This document is the contract for exposing
registered queries, mutations, and procedures as MCP tools, and for the auth
provider that owns the scope vocabulary and the tokens which carry it.
Implementation issues reference this document; divergences discovered during
implementation must update it.

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

A mutation's commit receipt has no channel here and is discarded rather than
smuggled into `_meta`. This is not a loss: an MCP caller holds no
subscriptions, so it owes no convergence obligation — the same reasoning
`runtime.ts` already records for HTTP callers ("An HTTP caller holds no
subscriptions, so it owes no convergence obligation"). A tool that needs a
commit version should return it.

Reachability is unchanged on every other transport. Naming a function as a
tool does not alter its WebSocket or HTTP behaviour, and access control
remains auth plus function policy everywhere.

## The auth provider

Scopes and tokens live on a standalone declaration, not on the endpoint:

```ts
// mcp/auth.ts — a leaf module. Nothing here imports an endpoint.
import { mcpAuth } from "../_generated/server";

export const adminAuth = mcpAuth({
  scopes: ["read", "write"] as const,
});
```

The extraction is structural, not cosmetic. An endpoint imports its tools; a
tool must name a scope; scopes used to live on the endpoint. That is a cycle,
and a cycle is why scope names could only ever be checked at runtime. A leaf
module both sides import breaks it, and breaking it is what makes a mis-typed
scope a compile error.

The provider owns token issuance and verification — `adminAuth.tokens` and
`adminAuth.systemTokens`, moved off the endpoint. A token is therefore bound
to the **provider**, not to one endpoint: two endpoints sharing a provider
accept the same credentials, and scopes are the only thing separating them.

- The stored `mcp` column holds the provider name, and `McpPrincipal.mcp`
  becomes the provider. The declarative internal-objects list is otherwise
  unchanged; pre-1.0 the workflow is wipe and reseed, so there is no
  migration step.
- `authorizeMcpTool`'s `principal.mcp === mcp` endpoint-isolation check
  dissolves into the scope check. **Two endpoints on one provider must be
  same-trust.** An endpoint with materially different authority takes its own
  provider.
- `maxTokensPerIdentity` becomes a per-provider limit rather than a
  per-endpoint one.

## Declaring an endpoint

```ts
// mcp/admin.ts
import { mcp } from "../_generated/server";
import { api } from "../_generated/api";
import { adminAuth } from "./auth.ts";

export const admin = mcp({
  name: "admin",
  auth: adminAuth,
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

The entry's `access` and the function's own `accessPolicy` both run; both must
pass. Note that `"authenticated"` on the function is satisfied by *any* valid
token on the provider — the entry's `access` is where real separation happens.

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
  auth: adminAuth,
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

The local/remote discriminator already exists: `mcpLocalGrant` returns
`undefined` when there is no ambient local authority, which is exactly "this
call came from outside the app".

One edge must be handled explicitly. `mcpLocalGrant` returns `EMPTY_SCOPES` —
not `undefined` — when a local authority exists but belongs to a *different*
principal or endpoint. That case must be treated as remote. Otherwise endpoint
A's AI context could reach endpoint B's private tool whenever that tool's
`access` is `"public"` or `"authenticated"` and the scope check therefore does
not save it.

`aiTools` includes private tools; serving them is its entire purpose. It stays
on the endpoint, since it is typed by the tool set. Only `tokens` and
`systemTokens` move to the provider.

## Wire format

Identical to the HTTP surface: standard JSON compiled per function by
`compileStandardJsonCodec`, with schemas from `validation/json-schema.ts`. The
validator mapping (`v.bigint()` and `v.identity()` as canonical decimal
strings, `v.bytes()` as padded base64, nothing escaped) is specified in
`docs/http-exposure.md` under *Wire format* and is not restated here. A
contract that cannot cross that boundary is a registration error, as it is
there.

Arguments become the tool's `inputSchema` from the function's `args`.

### Output

`returns` is **required** for a function used as a tool. A tool with no
`outputSchema` gives a model nothing to reason about, which is the same class
of defect as a missing description.

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

- a scope name not declared by the endpoint's provider;
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
- an endpoint path colliding with a built-in route, the `/api/_` prefix, or an
  exposed function path (already checked).

## Client impact

A tool is now a registered function, so it has an address and appears on the
generated `api` object. `accessPolicy` still governs whether a client may call
it; membership in a tools record is not itself a client-visible property and
does not filter codegen. A function may legitimately be a client query, an
HTTP route, and a tool at once — that reuse is the point.

Unrelated and pre-existing: `codegen.ts` performs no access filtering at all,
so `accessPolicy: "system"` functions are already emitted to the client type
surface today. Tracked separately; this change neither causes nor fixes it.

## Breaking changes

No compatibility shim, in either direction.

- `mcpTool`, `McpToolBlueprint`, `McpToolCtx`, the blueprint `WeakMap`, and the
  endpoint scope descriptor are deleted. Every existing tool is rewritten as a
  `query`, `mutation`, or `procedure` declaring `description` and `returns`.
- `createMcp` becomes `mcp`; `scopes` moves from the endpoint to `mcpAuth`.
- `endpoint.tokens` / `endpoint.systemTokens` become
  `provider.tokens` / `provider.systemTokens`.
- `McpToolCtx.tx` returning a raw `Awaited<R>` disappears with it; a tool now
  gets its kind's own context, so `ctx.tx` follows `ProcedureCtx`'s
  `FunctionResult<R>` contract like everything else.
- A tool returning MCP content blocks has no path until the follow-up below.
  The demo's nine tools all declare `output` today, so nothing in-repo is
  blocked by this.

## Out of scope

- **Content-block tools** — a function whose declared return is MCP content
  (image, audio, resource link, embedded resource). Tracked as a follow-up;
  when it lands it should be a variant of `procedure`, distinguished only by
  its return contract, not a parallel declaration kind.
- Streaming tools. MCP progress notifications are not implemented, so
  `sseProcedure` has no analog.
- Name derivation and bulk exposure forms.
- MCP resources and prompts.
- Codegen access filtering (pre-existing, unrelated).

## Implementation anchors

Reused unchanged: `compileStandardJsonCodec`, `validation/json-schema.ts`,
`authorizeMcpTool` as the single `tools/call` choke point, `mcpLocalGrant` as
the local/remote discriminator, `isMcpToolAuthorized`, the token vault's
declarative internal objects, and the invocation path's existing access
enforcement — a tool runs through `invokeFunction` like every other call, so
argument validation and policy cannot be skipped.

New work: the `mcpAuth` declaration and its token operations; the tools-record
entry type, including the conditional requirement that makes an undeclared
scope name a compile error (the technique `McpTokenCreateInput` already uses
for its own `scopes` field); the output codec's object-passthrough/wrap
branch; the `isError` mapping for declared application errors; `private`
filtering in `authorizeMcpTool` and `toolsFor`; endpoint-level `private` in
the registry's path claiming; and the codegen emitters for `mcp` and
`mcpAuth`.

Deleted: `mcpTool` and its blueprint machinery, `McpToolCtx`, the per-endpoint
scope descriptor, and the tests that pin them.
