# AI integration notes

What an application author must handle on *their* side when building an AI
chat on dbzz with the AI SDK. Everything here was learned building the demo's
Admin Chat (the reference implementation, under `demo/app/server`); none of it
is a dbzz defect — these are properties of the AI SDK, of model behavior, or
of sandboxed tool execution that any dbzz + AI SDK app will meet.

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
refuses to open older `.zdb` files (the error names both versions). The dev
workflow is wipe + reseed; there is no migration story before 1.0 by design.

## Model compatibility: nullable tool arguments

dbzz's optionality idiom for tool args is `dbz.nullable(...)`. Since 0.3.1 it
emits JSON Schema type arrays (`{"type": ["boolean", "null"]}`) rather than
`anyOf` unions, because models — verified with DeepSeek v4 flash — ignore
`anyOf` member types in tool schemas and send every scalar as a string. With
type arrays, no application-side coercion or `repairToolCall` is needed; tool
inputs validate as declared.

The same principle governs int64 ids. `dbz.bigint()` / `dbz.identity()` args
follow proto3's JSON mapping since 0.3.2: they *serialize* as canonical
decimal strings (wire-safe past 2^53), but *accept* either a JSON integer or
the decimal string. A model's natural completion for an id is the number `9`;
forcing it through a string type is what produced double-encoded garbage like
`"\"9\""` from small models. Numbers are accepted only within safe-integer
range — any JSON integer literal beyond 2^53−1 parses to a float that fails
`Number.isSafeInteger`, so silent precision loss cannot pass validation, and
large ids still travel as strings.

### Validation transcript

Recorded 2026-07-18 by the 0.3.1 release gate: a scripted live run of
`deepseek/deepseek-v4-flash` (via the Vercel AI gateway) through the demo's
real chat endpoint, with `repairToolCall` deleted and no coercion anywhere.
A second staff session held a live `dashboard.overview` subscription open for
the whole run. Every tool argument arrived typed; the subscription survived
the agent's commit with clean updates.

| Prompt (abridged) | Tool call | Input received |
|---|---|---|
| tables with `activeOnly` true | `get_tables` | `{"activeOnly": true}` |
| 5 menu items with `limit` 5 | `get_menu_items` | `{"limit": 5}` |
| 3 guests with `limit` 3 | `get_guests` | `{"limit": 3}` |
| advance oldest ORDERED item | `get_order_items` | `{"status": ["ORDERED"], "limit": 200}` |
| (same turn, the action) | `advance_kitchen_item` | `{"orderItemId": "14"}` → committed |

Outcome: zero `InvalidToolInputError`, zero masked stream errors, all four
streams finished cleanly; the live subscription recorded 2 updates and 0
errors across the action commit. The booleans and numbers above are real JSON
scalars, not strings — the type-array emission alone is sufficient for
DeepSeek; no application-side repair is needed.
