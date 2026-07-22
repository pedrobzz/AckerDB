# Database predicates are independent of indexes

DBzz ordinary reads start from a table query, build typed SQL predicates, and
declare result ordering explicitly. Schema indexes are unnamed, structural
planner inputs; queries never select one, and writable tables select unique
upsert constraints through an exact key shape. This replaces named index
accessors and JavaScript row filters because storage tuning must not alter the
application query contract or force filtering and limiting into memory.

The change is deliberately breaking. `get(id)` remains the direct primary-key
operation, while `.query().where(...)` owns ordinary reads, explicit
`.orderBy(...).thenBy(...)` owns keyset order, and table-level `upsert` owns
unique lookup. Existing user-named physical indexes reconcile once into DBzz's
derived internal identities; no compatibility API or legacy-name mapping is
retained.
