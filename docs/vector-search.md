# Vectors and exact similarity search

DBZZ stores and searches vectors; it does not generate embeddings. Generate an
embedding with the AI SDK or another model library, then write it through the
same insert, patch, replace, and read APIs as any other column.

## Declare and store vectors

`v.vector(dimensions)` is a dense, fixed-dimensional Float32 value:

```ts
const documents = defineTable({
  id: v.primaryKey(),
  accountId: v.bigint(),
  status: v.string(),
  title: v.string(),
  embedding: v.vector(1536).nullable(),
}).index(["accountId", "status"]);
```

The public value is a `readonly number[]`. DBZZ requires exactly the declared
number of finite coordinates, rejects Float32 overflow, rounds every accepted
coordinate once with Float32 semantics, and canonicalizes negative zero. The
stored representation is a headerless little-endian Float32 BLOB of exactly
`dimensions * 4` bytes. Reads return a fresh plain array.

Vectors may be nested in function argument and result validators because their
wire value is a fixed-length JSON number array. A persisted vector must be a
direct table column, optionally nullable; nesting it inside a persisted array,
object, or union is rejected. Ordinary indexes cannot contain vector columns.

Generate embeddings outside a database transaction. A procedure can perform
the model call first and persist the result in a short explicit transaction:

```ts
const { embedding } = await embed({ model, value: text });

await ctx.tx((tx) =>
  tx.db.documents.patch(documentId, { embedding })
);
```

## Exact nearest search

Nearest search composes with the same typed SQL predicates as an ordinary
query:

```ts
const matches = await ctx.db.documents
  .nearest("embedding", queryVector, { metric: "cosine" })
  .where((row) =>
    row.accountId.eq(accountId).and(row.status.eq("published"))
  )
  .take(10);

for (const { row, distance } of matches) {
  console.log(row.title, distance);
}
```

Every metric is oriented lower-is-nearer:

| Metric | Distance |
| --- | --- |
| `cosine` | `1 - cosineSimilarity(query, stored)` |
| `l2` | Euclidean distance |
| `dot` | negative dot product |

`.first()` returns the first match or `null` and is equivalent to `.take(1)`.
Nearest queries intentionally have no unbounded collect, iteration, count,
pagination, uniqueness, or ordering API. `take(k)` requires a positive safe
integer. DBZZ has no vector-specific hard maximum, so callers own the CPU,
temporary heap, decoded-row, and response cost of a large `k`.

Null stored vectors are excluded for every metric. A zero stored vector is
valid for L2 and dot search and excluded from cosine search. A zero cosine
query is invalid. Equal distances are deterministic: the primary key ascending
breaks ties.

SQLite applies every `where` predicate and can use ordinary or composite
indexes before any distance work. DBZZ then streams only primary keys and
vector blobs through NumKong's native scalar kernels, retains a worst-first
heap bounded by `k`, and materializes only the winners from the same SQLite
snapshot. For `n` predicate-eligible vectors of dimension `d`, distance work is
linear in `n * d`, ranking memory is `O(k)`, and winner materialization is
bounded by `k`.

Nearest subscriptions depend on the predicate-eligible candidate population,
not only the current winners. An insert or update to an unreturned row can
therefore replace a winner without leaving the subscription stale.

DBZZ does not expose approximate search, vector indexes, quantization, stored
norms, or background index-build workers. Exact search is the deliberately
simple and safe first-class contract; ordinary metadata indexes are the way to
reduce its candidate population.

## Backfill and schema evolution

Add a nullable vector column to an existing table, fetch rows missing an
embedding in bounded pages, generate embeddings outside transactions, and
patch each bounded batch in a short transaction. Keep retries and model rate
limits in application workflow code.

Adding a nullable vector column is shape-safe. Adding a required vector column,
tightening nullable to required, or changing vector dimensions/type is
shape-unsafe and uses a normal forward migration. Migrations must not call an
embedding model: backfill first, verify completeness, then tighten the schema.
