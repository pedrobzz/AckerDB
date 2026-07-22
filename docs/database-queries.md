# Database queries

DBZZ reads are planner-independent. Application code describes the rows it
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
application row, and DBZZ does not run it once per result in JavaScript.
Repeated `where` calls combine with `AND`.

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

## Deterministic order and pagination

Without an explicit order, rows use primary-key ascending order. With an
explicit order, DBZZ appends primary-key ascending as the final tie-breaker
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
tuple. Pass `nextCursor` back unchanged. DBZZ validates its arity, nullability,
and value types against the query order and rejects malformed cursors.

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
budget, DBZZ records a broader prefix or a table dependency. This can cause
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
