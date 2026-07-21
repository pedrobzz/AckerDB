# MCP and AI integration

How an application declares one typed MCP tool surface and consumes it locally
with AI SDK. The demo's Admin Chat under `demo/app/server` is the reference
implementation. The model, streaming, and sandbox notes record application-side
integration constraints; the declaration and typing sections define DBZZ's
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

just-bash blocks `globalThis.performance.now` while `exec()` runs. dbzz reads
are telemetry-timed, so *lazy* file providers that query the database from
inside the sandbox die mid-command (surfacing as `ENOENT`). Materialize every
workspace file eagerly — inside one `ctx.tx`, before constructing the sandbox
— so the sandbox only ever touches plain strings. This is also what makes the
workspace transactionally consistent: one snapshot, no torn reads.

## Dev database across engine-schema bumps

Pre-1.0, a dbzz upgrade that bumps the storage engine's internal schema
refuses to open older `.dbzz` files (the error names both versions). The dev
workflow is wipe + reseed; there is no migration story before 1.0 by design.

## Declare MCP tools at the endpoint

`dbzz codegen` emits schema-bound `mcpTool` and `createMcp` builders. A tool
module exports an inert blueprint with no wire name and no endpoint import:

```ts
import { v } from "@dbzz/server";
import { mcpTool } from "../_generated/server";

export const getOrder = mcpTool({
  description: "Return one order by id.",
  access: { anyOf: ["read"] },
  args: {
    orderId: v.bigint().describe("The order id."),
  },
  output: v.object({
    order: v.object({
      id: v.bigint(),
      status: v.string(),
    }).nullable(),
  }),
  handler: (ctx, args) =>
    ctx.tx(async (tx) => {
      const order = await tx.db.orders.get(args.orderId);
      return {
        order: order === null ? null : { id: order.id, status: order.status },
      };
    }),
});
```

The endpoint owns registration and assigns each protocol name through its
`tools` record:

```ts
import { createMcp } from "../_generated/server";
import { getOrder } from "./tools/getOrder.ts";

export const admin = createMcp({
  name: "admin",
  scopes: ["read"] as const,
  tools: {
    get_order: getOrder,
  },
});
```

The record key is the MCP wire name. `mcpTool` has no `name` field, and an MCP
declaration has no `.tool(...)` registration method. Exporting a blueprint by
itself does not register it; the runtime registry walks the exported endpoint
declaration and its assembled `tools`. The same inert blueprint may be reused
by another endpoint, while the generated types verify its database schema and
required access scopes against every endpoint that includes it.

The assembled `admin.tools` value is a readonly exact record with the same
declared keys and registered handler types; it has no catch-all string index.

Descriptions on a tool and its `v.*.describe(...)` validators become MCP tool
and field documentation. Validator input and structured output types also
drive the protocol JSON schemas, so handlers, MCP clients, and local AI tools
share one contract.

This is a deliberate pre-1.0 source break. Convert old endpoint `.tool(...)`
calls into `mcpTool(...)` blueprints, remove each definition's `name`, assemble
them under `createMcp({ tools: { wire_name: blueprint } })`, and run
`dbzz codegen`. There is no legacy registration shim.

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

Tool inputs and structured outputs retain their exact Standard JSON types.
Tools without a declared output keep the raw MCP content-result type. The
adapter runs through the active DBZZ procedure context and shared dispatcher;
it does not open an HTTP connection or weaken the caller's authority.

## Model compatibility: optional and nullable tool arguments

DBzz keeps omission and null explicit in tool contracts. Use
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
