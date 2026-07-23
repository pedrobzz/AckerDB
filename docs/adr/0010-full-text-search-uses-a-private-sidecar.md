# Full-text search uses a private sidecar

DBzz exposes full-text search only on explicitly opted-in application tables,
while the ordinary table remains the sole source of truth. Each declaration
creates one private single-column SQLite FTS5 external-content index for each
declared target, keyed by the table's primary key and maintained transactionally
by DBzz-generated SQLite triggers; applications never manage a second table.
Per-target indexes and value-sensitive update triggers avoid reindexing
unchanged searchable columns, accepting small per-index metadata overhead in
exchange for fast lexical retrieval without duplicating source text or
introducing an independently synchronized search datastore.

Literal query preparation stays inside SQLite's tokenizer contract:
`fts3tokenize(unicode61)` is byte-for-byte compatible with FTS5's default
`unicode61`. DBzz quotes each resulting token separately and relies on FTS5's
implicit `AND`; it neither implements a tokenizer nor turns a multi-token query
into a phrase. Zero-token input has no matches, and literal preparation is
bounded to 4,096 UTF-8 bytes and 256 searchable tokens. Retrieval reads only
the selected target sidecar, joins its `rowid` to the canonical application
primary key, and orders by that target's FTS5 `rank` with primary-key ties.

FTS5 reserves column names `rank` and `rowid` case-insensitively. V1 rejects
those names as full-text targets; supporting them through a per-target
projection view would add lifecycle machinery for a rare backend edge case
without improving the ordinary contract.

Reactive searches retain their ordinary predicate dependencies and add one
dependency for the selected target's complete FTS corpus. The corpus dependency
is necessary because default BM25 statistics are target-wide: an indexed-text
change outside a query's predicate population can still reorder eligible rows.
Keeping this dependency per target preserves correctness without invalidating
searches over unrelated full-text columns.
