# Validators

AckerDB has one validator DSL: `v` from `@ackerdb/server`. The same validator value
drives TypeScript inference, runtime checks, stored schema snapshots, and the
Standard JSON Schema published for the exposed HTTP surface.

Every validator owns four contract operations:

- `parse(value, path?)` validates and normalizes a native runtime value.
- `decode(value, path?)` converts Standard JSON into that native value.
- `encode(value, path?)` validates the native value and converts it to Standard
  JSON.
- `toJsonSchema(options?)` describes that validator's own JSON representation;
  objects, arrays, unions, and modifiers compose their child validators through
  the same method.

For example, `v.bigint().parse(7n)` returns `7n`,
`v.bigint().decode("7")` returns `7n`, and `v.bigint().encode(7n)` returns
`"7"`. Composite validators apply those operations through their children.

## Numeric types

Choose the JavaScript type and SQLite storage class deliberately:

| Validator | TypeScript value | Accepted value | SQLite storage |
| --- | --- | --- | --- |
| `v.int()` | `number` | Safe integer | `INTEGER` |
| `v.float()` | `number` | Finite number | `REAL` |
| `v.bigint()` | `bigint` | Signed 64-bit integer | `INTEGER` |
| `v.vector(d)` | `readonly number[]` | Exactly `d` finite Float32 coordinates | `BLOB` |

There is no `v.number()`. Use `v.int()` for ordinary counters, timestamps, and
other safe-integer values; `v.float()` when fractions are meaningful; and
`v.bigint()` when the JavaScript value must remain a lossless 64-bit integer.
Use `v.vector(d)` for fixed-dimensional dense values such as externally
generated embeddings. Its Float32 normalization, direct-column storage rules,
and exact-search API are documented in [Vectors and exact similarity
search](vector-search.md).

## File identities

`v.file()` validates a branded `FileId`; `v.fileGrant()` validates the distinct
`FileGrantId` returned when a download URL is created. Both cross standard JSON
as decimal strings and may be stored as direct required or nullable columns.
Only `v.file()` participates in automatic pending-File claiming; storing a
Grant identity is ordinary application data. See [Files](files.md) for their
lifecycle and access roles.

## Constraints and descriptions

Constraints compose before one terminal presence modifier:

```ts
import { defineTable, v } from "@ackerdb/server";

export const products = defineTable({
  id: v.primaryKey(),
  slug: v
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9]+$/)
    .describe("Stable lowercase product slug."),
  price: v.float().min(0),
  stock: v.int().min(0),
  externalId: v.bigint(),
  note: v.string().max(500).nullable().describe("Optional staff note."),
});
```

- `min` and `max` constrain Unicode code-point length on strings, item count on
  arrays, and value on `int`, `float`, and `bigint`.
- String and array bounds must be non-negative safe integers. Numeric bounds
  must be finite numbers; bigint bounds must be signed 64-bit `bigint` values.
- `regex` accepts one flagless `RegExp` on strings. Its source is stored in the
  schema descriptor and compiled once for validation.
- `describe` attaches documentation without changing schema identity. Published
  input and output schemas carry these descriptions.

Validators do not accept arbitrary refinement callbacks. Constraints are
declarative and serializable so runtime checks, generated schemas, stored
snapshots, and migrations all enforce the same contract.

## Presence in stored data and function arguments

Use chained modifiers; the wrapper form does not exist:

| Validator | Function argument | Stored table/event column |
| --- | --- | --- |
| `v.string().nullable()` | Required key; value may be `string` or `null` | Nullable column |
| `v.string().optional()` | Key may be absent or `undefined`; `null` is rejected | Rejected |
| `v.string().nullish()` | Key may be absent, `undefined`, or `null` | Rejected |

`optional()` and `nullish()` are rejected recursively in table and event row
schemas because `undefined` is not stored state. Use `nullable()` when a stored
value may be absent. On insert or replace, an omitted nullable column is stored
as `null`; required columns must be present. On patch, an absent key or an
explicit `undefined` leaves the column untouched, while an explicit `null`
updates a nullable column to `NULL`.

Function argument objects preserve the distinction:

```ts
import { v } from "@ackerdb/server";
import { mutation } from "./_generated/server";

export const updateProfile = mutation({
  access: "authenticated",
  args: {
    displayName: v.string().min(1).max(100).optional(),
    bio: v.string().max(500).nullish(),
    avatarUrl: v.string().nullable(),
  },
  handler: async (_ctx, args) => {
    // displayName: omitted/undefined means no requested change
    // bio: null clears it; omitted/undefined means no requested change
    // avatarUrl: callers must send a string or null
  },
});
```

Apply `min`, `max`, or `regex` before `nullable`, `optional`, or `nullish`.
Presence modifiers are terminal; use `nullish()` directly instead of combining
`nullable()` and `optional()`.

## Presence in published JSON Schema contracts

AckerDB keeps omission and null explicit in the JSON Schema it publishes. Use
`v.boolean().optional()` when a property may be omitted,
`v.boolean().nullable()` when it is required but may be `null`, and
`v.boolean().nullish()` when both forms are accepted. Optional properties are
omitted from JSON Schema's `required` list. Nullable properties emit type
arrays (`{"type": ["boolean", "null"]}`) rather than `anyOf` unions, because a
consumer that ignores `anyOf` member types degrades every scalar to a string.
With these schemas, no caller-side coercion or repair is needed; arguments
validate as declared.

## Discriminated unions

Use a discriminated union of object validators. Every member must own a unique
string `v.literal` at the discriminator field:

```ts
const message = v.discriminatedUnion("type", [
  v.object({ type: v.literal("text"), text: v.string() }),
  v.object({ type: v.literal("deleted") }),
], "Message");
```

The optional third argument only names the generated TypeScript alias. When it
is omitted, codegen derives the alias from the column address; for example,
`messages.payload` becomes `MessagesPayload`. It does not affect schema,
storage, migrations, or database identity.

The runtime selects the member from the literal and validates the object once.
A stored union remains one complete Standard JSON object in a `TEXT` column.
`row.message.is("text")` compares its discriminator through SQLite
`json_extract`; declaring an index for the column creates an expression index
over that same discriminator expression and narrows the resulting value to the
matching object member.

The same principle governs int64 ids. `v.bigint()` / `v.identity()` args follow
proto3's JSON mapping since 0.3.2: they *serialize* as canonical decimal
strings (wire-safe past 2^53), but *accept* either a JSON integer or the
decimal string. A caller's natural spelling for an id is the number `9`;
forcing it through a string type is what produced double-encoded values like
`"\"9\""`. Numbers are accepted only within safe-integer range — any JSON
integer literal beyond 2^53−1 parses to a float that fails
`Number.isSafeInteger`, so silent precision loss cannot pass validation, and
large ids still travel as strings.

## Stored constraints and migrations

Table constraints run on every insert, replace, and changed patch value. A
constraint loosening applies as a shape-safe schema change. A tightening is
optimistic: AckerDB scans the affected stored columns in bounded pages inside the
writer transaction. Clean data adopts the new constraint without a migration;
violations refuse with an exact row count and write nothing.

For a refusal, generate a normal forward migration and repair, map, or delete
the invalid rows in that table's transform. Every transformed and emitted row
is checked against the target validator before the migration and its history
record commit atomically. See [Migrations](migrations.md) for the complete
workflow.
