# Database queries

AckerDB reads are planner-independent. Application code describes the rows it
needs; SQLite chooses any declared index that helps. Adding, removing, or
reordering a storage index cannot change a query's result or its public API.

## Predicates and materialization

Use `get(id)` for one primary key and `query()` for every ordinary set read:

```ts
const active = await ctx.db.documents
  .query()
  .where((row) =>
    row.accountId.eq(accountId).and(
      row.status.in(["queued", "ready"]),
    )
  )
  .orderBy((row) => row.createdAt.desc())
  .thenBy((row) => row.title.asc())
  .take(50);
```

The callback builds a typed SQL expression once. It does not receive an
application row, and AckerDB does not run it once per result in JavaScript.
Repeated `where` calls combine with `AND`. The opaque expression may be
reused by other builders for the same table and engine, but not across tables
or engines.

Column references expose only meaningful operations:

- scalar equality: `eq`, `ne`, and `in`;
- ordered scalars: `lt`, `lte`, `gt`, `gte`, and `between`;
- nullable columns: `isNull` and `isNotNull`;
- expressions: `and`, `or`, and `not`;
- union discriminants: `is("variant")`, which narrows the row type positively.

Structured values and vectors do not pretend to have scalar SQL ordering.
Enum and union labels are also not orderable: their stored tags are stable
identities, not a logical declaration order. Booleans retain `false` then
`true` ordering.
All predicate values cross the column's validator and storage codec before
SQLite sees them.

Queries support `collect`, `take`, `first`, `unique`, `count`, `iter`, and
keyset `paginate`. `unique` returns `null` for no row and rejects more than one
row. Filtering, limiting, counting, and pagination stay in SQLite.

## Scalar aggregates

`sum`, `avg`, `min`, and `max` aggregate the filtered set inside SQLite —
no row crosses into JavaScript — and record the same reactive dependencies
as any other materializer, so a live aggregate recomputes only when a write
touches its predicate's index range:

```ts
const revenue = await ctx.db.orders
  .query()
  .where((row) => row.status.eq("paid"))
  .sum((row) => row.amount);
```

The callback selects one column, like `orderBy`. `sum` and `avg` accept
numeric columns (`int`, `float`, `bigint`); `min` and `max` accept every
ordered kind — the `lt`/`gt` set — and return the column's decoded value.
Declared ordering is ignored; aggregates are terminal over the whole
filtered set, so there is no "sum of the top N" — `take(N)` and reduce in
JavaScript for that.

Aggregates follow SQL NULL semantics: NULL values do not contribute. An
empty (or all-NULL) set yields the sum identity — `0`, or `0n` for bigint
columns — while `avg`, `min`, and `max` yield `null`, and `avg` is always a
float. Sums never lose precision silently: an `int` sum whose exact value
exceeds `Number.MAX_SAFE_INTEGER` throws and names the bigint-column fix,
and a `bigint` sum past SQLite's 64-bit integer range surfaces its overflow
as an error.

## Deterministic order and pagination

Without an explicit order, rows use primary-key ascending order. With an
explicit order, AckerDB appends primary-key ascending as the final tie-breaker
unless the query explicitly orders the primary key itself:

```ts
const page = await ctx.db.documents
  .query()
  .where((row) => row.accountId.eq(accountId))
  .orderBy((row) => row.updatedAt.desc())
  .paginate({ cursor, pageSize: 25 });

// page.items
// page.nextCursor: string | null
```

`orderBy` starts the lexicographic order and `thenBy` extends it. Directions
may be mixed. SQLite null ordering is part of the contract: null precedes a
non-null value ascending and follows it descending.

Pagination cursors are opaque, versioned encodings of the complete ordering
tuple. Pass `nextCursor` back unchanged. AckerDB validates its arity, nullability,
and value types against the query order and rejects malformed cursors.

A page size normally arrives from a caller, so both of a page's bounds are the
server's:

- `pageSize` may not exceed `MAX_PAGE_SIZE` (256) rows. A larger one is
  rejected rather than clamped, because silently returning a different page
  than the one asked for is worse than saying no.
- A page's rows may not exceed `MAX_PAGE_BYTES` (512 KiB), charged against each
  cell's wire cost. This bound takes rows away, never fields: the page stops at
  the last row that fits and its `nextCursor` resumes at the row that did not,
  so a table with a few oversized rows costs a page its tail instead of costing
  the whole delivery. A page always carries at least one row, so a single row
  above the entire budget still advances the cursor. The charge is an
  approximation — measuring exactly would mean encoding every row twice — so it
  is a budget rather than a delivery guarantee; the transport's frame limit
  stays the authority on what fits in one message, as it is for every other
  materializer.

A shorter page is therefore normal, and `nextCursor` — never `items.length` —
is what says whether more rows exist. On the client,
[`usePaginatedQuery`](client-react.md#reactive-cursor-pagination) keeps a
window of these pages live.

## Serializable filters

A `.where` callback is code, so it cannot cross a wire. When the rows a caller
wants are chosen by the caller — a console, a saved view, a filter bar whose
state lives in the URL — it sends a **filter expression** instead: a closed
JSON vocabulary that the server validates and compiles into exactly the
predicates a callback would have produced.

A table declares the columns it accepts filters on, in the same shape a
declared index uses:

```ts
import { filterableFields } from "@ackerdb/server";
import { schema } from "./schema";

export const logFilters = filterableFields(schema.tables.logs, [
  "level",
  "fn",
  "durationMs",
  "requestId",
]);
```

The declaration is the boundary. A filter is an oracle — it reveals whether
rows exist without returning them — so a column that is not declared is
unknown to filtering even when the query returns it. Declaring an unknown or
uncomparable column throws at startup; it is the developer's mistake, not a
caller's.

Validation returns its failures as data, so a query hands them straight back
as an ordinary application error and a client renders them inline:

```ts
export const list = query({
  args: { filter: v.any(), cursor: v.string().nullable(), pageSize: v.int() },
  handler: async (ctx, args) => {
    const filter = logFilters.validate(args.filter);
    if (!filter.ok) return filter;

    return await ctx.db.logs
      .query()
      .where(filter.data)
      .orderBy((row) => row.id.desc())
      .paginate({ cursor: args.cursor, pageSize: args.pageSize });
  },
});
```

The error is `filter.invalid` (400) carrying `issues`, one per offending node:
`{ path: "$.all[1].value", message: "..." }`. The path locates the node from
the expression root so a filter bar can attach each message to the control
that produced it. See [Typed function results](function-results.md) for the
Result contract this uses.

An expression is either a clause or a group:

```ts
{ field: "level", op: "eq", value: "error" }
{ field: "level", op: "anyOf", values: ["warn", "error"] }
{ all: [
    { field: "fn", op: "eq", value: "orders.create" },
    { any: [
        { field: "durationMs", op: "gt", value: 500 },
        { field: "level", op: "eq", value: "error" },
      ] },
  ] }
```

- Comparison clauses are `eq`, `neq`, `gt`, `gte`, `lt`, `lte`. The ordered
  four are accepted only by ordered column kinds — the same `lt`/`gt` set the
  callback form exposes.
- Membership clauses are `anyOf` and `noneOf`. `null` is not a member value.
- `eq`/`neq` against `null` are presence tests on a nullable column. Following
  SQL, `noneOf` excludes NULL rows; add `{ field, op: "eq", value: null }`
  under an `any` group to keep them.
- Groups are `all` (AND) and `any` (OR). **OR is in the contract from the
  first version** — the predicate layer already composes AND, OR, and NOT, so
  the serializable form mirrors it rather than describing something weaker.
  An empty `all` matches every row and an empty `any` matches none, which is
  also how `noneOf []` and `anyOf []` behave.
- Bounds are `MAX_FILTER_DEPTH` (8) nested groups, `MAX_FILTER_NODES` (128)
  clauses and groups, and `MAX_FILTER_VALUES` (1024) comparison values and
  membership members across the whole expression — each of those becomes one
  SQL parameter, so the bound is what keeps a filter clear of SQLite's variable
  limit. Exceeding any of them is an issue, not a throw.

There is no index selection and no way to name one: indexes stay transparent
and planner-owned (ADR-0008). Every value crosses its column's validator and
storage codec before SQLite sees it, exactly as a callback's values do, and a
validated filter is an ordinary predicate afterwards — it composes with more
`.where` calls, ordering, aggregates, pagination, and reactive dependency
recording. A filter is bound to the table that validated it; passing it to
another table's query is a programmer error and throws.

## Transparent indexes

Declare indexes structurally, without public names:

```ts
const documents = defineTable({
  id: v.primaryKey(),
  accountId: v.bigint(),
  status: v.string(),
  createdAt: v.int(),
})
  .index(["accountId"])
  .index(["accountId", "status", "createdAt"])
  .index(["status"], { algorithm: "direct" });
```

Composite, reversed, prefix-related, and multiple distinct indexes are all
supported. Repeating or conflicting over the same ordered columns is rejected.
The current `direct` algorithm has the same SQLite b-tree performance shape as
the default; it remains structural configuration rather than a query entry
point.

Reactive reads conservatively derive declared equality prefixes from the
predicate expression. If a safe prefix cannot be proven within the dependency
budget, AckerDB records a broader prefix or a table dependency. This can cause
extra recomputation but never a stale subscription.

## Structural upsert

A writable table selects a unique constraint by the exact fields in its key:

```ts
const id = await ctx.db.users.upsert(
  { email },
  (existing) => ({
    displayName: existing?.displayName ?? requestedName,
    updatedAt: Date.now(),
  }),
);
```

The key field set must exactly match one declared non-null unique index;
property order does not matter. Key fields cannot be changed by the values or
callback. Nullable unique indexes are not valid upsert targets, and a conflict
with another unique constraint remains an error. Union keys compare both tag
and payload; a same-tag/different-payload key conflicts with the stronger
tag-only storage constraint rather than updating a different logical value.
