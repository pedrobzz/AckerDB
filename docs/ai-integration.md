# MCP and AI integration

How an application declares one typed MCP tool surface and consumes it locally
with AI SDK. The demo's Admin Chat under `demo/app/server` is the reference
implementation. The model, streaming, and sandbox notes record application-side
integration constraints; the declaration and typing sections define AckerDB's
public API.

## Surface tool errors to the client

`toUIMessageStream` masks every stream error as the literal text
`"An error occurred."` unless you pass `onError`. During development this
hides tool failures completely — the model apologizes vaguely and you learn
nothing. Wire `onError` to return the real message. Do this only for trusted
transcripts (the demo's chat is staff-only); for end-user surfaces, map to a
safe message but *log* the real one.

## Always end the turn with text

A model can legitimately end its turn on a tool call, which leaves the chat
hanging with no assistant prose. Cap the loop with `stopWhen: stepCountIs(N)`
and use `prepareStep` to force `toolChoice: "none"` on the final step, so the
last step can only produce text. The demo uses `N = 16`.

## Sandboxed CLI tools: materialize eagerly

just-bash blocks `globalThis.performance.now` while `exec()` runs. AckerDB reads
are telemetry-timed, so *lazy* file providers that query the database from
inside the sandbox die mid-command (surfacing as `ENOENT`). Materialize every
workspace file eagerly — inside one `ctx.tx`, before constructing the sandbox
— so the sandbox only ever touches plain strings. This is also what makes the
workspace transactionally consistent: one snapshot, no torn reads.

## Dev database across engine-schema bumps

Pre-1.0, an AckerDB upgrade that bumps the storage engine's internal schema
refuses to open older `.ackerdb` files (the error names both versions). The dev
workflow is wipe + reseed; there is no migration story before 1.0 by design.

## An MCP tool is a registered function

`acker codegen` emits a schema-bound `mcp` builder typed by the app's scope
vocabulary. A tool is an
ordinary `query`, `mutation`, or `procedure` — it knows nothing about MCP:

```ts
import { v } from "@ackerdb/server";
import { query } from "../_generated/server";

export const getOrder = query({
  description: "Return one order by id.",   // required to be a tool
  access: "authenticated",
  args: {
    orderId: v.bigint().describe("The order id."),
  },
  returns: v.object({
    order: v.object({
      id: v.bigint(),
      status: v.string(),
    }).nullable(),
  }),
  handler: async (ctx, args) => {
    const order = await ctx.db.orders.get(args.orderId);
    return { order: order === null ? null : { id: order.id, status: order.status } };
  },
});
```

The scope vocabulary lives on the app manifest —
`defineApp({ schema, scopes: ["read"] as const })` — and the endpoint is the
curation surface: it assigns each wire name, the scopes that gate it, and the
hints a model reads. Credentials are ordinary identity credentials issued
through the app-wide `credentials` API (see `docs/scopes.md`).

```ts
import { mcp } from "../_generated/server";
import { api } from "../_generated/api";

export const admin = mcp({
  name: "admin",
  tools: {
    get_order: {
      fn: api.orders.getOrder,
      access: { anyOf: ["read"] },
      annotations: { readOnlyHint: true },
    },
  },
});
```

The record key is the MCP wire name and is always written by hand — a tool list
is a prompt, so its names and granularity are authored rather than derived. A
scope the provider never declared is a compile error, as is an `sseProcedure`
entry or a `private` endpoint that also claims a `path`.

The assembled `admin.tools` value is a readonly exact record with the same
declared keys; it has no catch-all string index.

Descriptions on the function and its `v.*.describe(...)` validators become MCP
tool and field documentation. `returns` drives the published `outputSchema`: an
object return crosses as `structuredContent` directly, and anything else is
wrapped under `value`, because the protocol requires an object there.

A tool that must answer content blocks rather than a value declares
`returns: mcpContent()`. It publishes no `outputSchema`, and `http: true` on it
is a registration error — an HTTP response has nowhere to put an image.

## Exact local AI tools

An exported endpoint exposes its declared tool names and validator-derived
input/output types through `aiTools`:

```ts
const tools = admin.aiTools(ctx, {
  scopes: ["read"],
  includeUnavailable: true,
});

const result = streamText({ model, messages, tools });
```

By default, unavailable tools are omitted and the inferred type is a readonly
partial record of the endpoint's exact keys, with no string index signature.
Pass `includeUnavailable: true` when a consumer such as AI SDK requires the
complete readonly tool record; every declared key is then required in the
type, but execution still enforces endpoint, principal, and scope authority.

Tool inputs and structured outputs retain their exact Standard JSON types — a
`v.bigint()` field is typed as its canonical decimal string, matching what
crosses. A tool declaring `mcpContent()` keeps the raw MCP content-result type.
The adapter runs through the active AckerDB procedure context and shared
dispatcher; it does not open an HTTP connection or weaken the caller's
authority.

A declared application error is **thrown** here rather than returned, so a
success keeps one exact structured type. Remote callers see the same
information as an `isError` result.

## Model compatibility: optional and nullable tool arguments

AckerDB keeps omission and null explicit in tool contracts. Use
`v.boolean().optional()` when a property may be omitted,
`v.boolean().nullable()` when it is required but may be `null`, and
`v.boolean().nullish()` when both forms are accepted. Optional properties are
omitted from JSON Schema's `required` list. Nullable properties emit type
arrays (`{"type": ["boolean", "null"]}`) rather than `anyOf` unions, because
models — verified with DeepSeek v4 flash — ignore `anyOf` member types in tool
schemas and send every scalar as a string. With these schemas, no
application-side coercion or `repairToolCall` is needed; tool inputs validate
as declared.

The same principle governs int64 ids. `v.bigint()` / `v.identity()` args
follow proto3's JSON mapping since 0.3.2: they *serialize* as canonical
decimal strings (wire-safe past 2^53), but *accept* either a JSON integer or
the decimal string. A model's natural completion for an id is the number `9`;
forcing it through a string type is what produced double-encoded garbage like
`"\"9\""` from small models. Numbers are accepted only within safe-integer
range — any JSON integer literal beyond 2^53−1 parses to a float that fails
`Number.isSafeInteger`, so silent precision loss cannot pass validation, and
large ids still travel as strings.

### Validation transcript

Recorded 2026-07-18 by the 0.3.2 release gate: a scripted live run of
`deepseek/deepseek-v4-flash` (via the Vercel AI gateway) through the demo's
real chat endpoint, with no repair or coercion anywhere. A second staff
session held a live `dashboard.overview` subscription open for the whole run.
Every tool argument arrived typed; the subscription survived the agent's
commit with clean updates.

| Prompt (abridged) | Tool call | Input received |
|---|---|---|
| tables with `activeOnly` true | `get_tables` | `{"activeOnly": true}` |
| items on order 6 (`orderId` filter) | `get_order_items` | `{"orderId": 6}` |
| 3 guests with `limit` 3 | `get_guests` | `{"limit": 3}` |
| advance oldest ORDERED item | `get_order_items` | `{"status": ["ORDERED"], "limit": 200}` |
| (same turn, the action) | `advance_kitchen_item` | `{"orderItemId": 14}` → committed |

Outcome: zero `InvalidToolInputError`, zero masked stream errors, all four
streams finished cleanly; the live subscription recorded 2 updates and 0
errors across the action commit. The booleans and numbers above are real JSON
scalars — nullable args arrive typed under the type-array emission, and the
bigint id filters arrive as plain JSON integers under the proto3-style
mapping. The schemas alone are sufficient for DeepSeek; no application-side
repair is needed.
