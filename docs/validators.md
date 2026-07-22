# Validators

DBZZ has one validator DSL: `v` from `@dbzz/server`. The same validator value
drives TypeScript inference, runtime checks, stored schema snapshots, and the
Standard JSON Schema exposed by MCP tools.

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

## Constraints and descriptions

Constraints compose before one terminal presence modifier:

```ts
import { defineTable, v } from "@dbzz/server";

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
- `describe` attaches documentation without changing schema identity. MCP input
  and output schemas use these descriptions.

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
import { v } from "@dbzz/server";
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

## Stored constraints and migrations

Table constraints run on every insert, replace, and changed patch value. A
constraint loosening applies as a shape-safe schema change. A tightening is
optimistic: DBZZ scans the affected stored columns in bounded pages inside the
writer transaction. Clean data adopts the new constraint without a migration;
violations refuse with an exact row count and write nothing.

For a refusal, generate a normal forward migration and repair, map, or delete
the invalid rows in that table's transform. Every transformed and emitted row
is checked against the target validator before the migration and its history
record commit atomically. See [Migrations](migrations.md) for the complete
workflow.
