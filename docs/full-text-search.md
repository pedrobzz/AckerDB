# Full-text search

> Status: V1 implementation contract. Typo tolerance is not part of V1.

AckerDB will provide bounded lexical retrieval over explicitly selected string
columns while the application table remains the sole source of truth. Vector
and full-text retrieval stay independent; applications may execute both and
perform their own rank fusion.

## Default policy

V1 uses SQLite FTS5's defaults unless this document names a deliberate AckerDB
deviation. AckerDB does not replace FTS5's ranking, tokenization details, index
detail, merge policy, or corpus statistics with parallel machinery. The
deliberate differences are the typed literal-query API, explicit per-column
external-content indexes, bounded materialization, deterministic primary-key
ties, bounded literal preparation, and AckerDB-owned lifecycle and
synchronization.

## V1 contract

```ts
const documents = defineTable({
  id: v.primaryKey(),
  accountId: v.bigint(),
  body: v.string(),
  embedding: v.vector(1536).nullable(),
}).fullText(["body"]);

const matches = await ctx.db.documents
  .fullText("body", query)
  .where((row) => row.accountId.eq(accountId))
  .take(10);
```

- A table opts in by explicitly declaring its full-text columns.
- Each declared target column owns one private single-column FTS5 index. A
  declaration such as `.fullText(["title", "body"])` therefore creates two
  private indexes, allowing a write to reindex only the searchable columns it
  changed.
- Each `fullText(column, query)` call targets exactly one declared string
  column and treats `query` as literal text, not backend query syntax.
- FTS5 reserves `rank` and `rowid` case-insensitively; V1 rejects those names
  as full-text targets instead of adding a projection view and another catalog
  object for an ultra-specific case. They remain valid ordinary AckerDB column
  names.
- AckerDB asks SQLite's `fts3tokenize(unicode61)` table to tokenize the literal
  input. SQLite specifies that this tokenizer is byte-for-byte compatible with
  FTS5's `unicode61`, so AckerDB does not maintain or approximate token boundaries
  in JavaScript. Each resulting token becomes one quoted FTS5 phrase and the
  phrases compose through FTS5's implicit `AND`. Literal text therefore never
  becomes an operator, multi-token input is not changed into an exact phrase,
  and input that produces zero tokens returns no matches.
- Literal preparation accepts at most 4,096 UTF-8 bytes and 256 searchable
  tokens. These finite denial-of-service bounds are AckerDB API limits, not
  tokenizer or ranking changes.
- V1 uses FTS5's default `unicode61` tokenizer for every full-text index and
  exposes no tokenizer, stemming, prefix-index, or language-analysis
  configuration.
- Database predicates restrict the rows eligible to be returned before
  ordering and limiting. They do not create a filtered relevance corpus:
  FTS5's default BM25 statistics cover every row in that target-column index.
- A search reads only the selected target's sidecar, restricts canonical rows
  by joining the sidecar `rowid` to the application primary key, and orders by
  that sidecar's default FTS5 `rank` followed by application primary key
  ascending. Results expose rows directly; private `rank` and `rowid` values
  are not part of the public result. `.take(k)` and `.first()` are the only
  materializers.
- `fullText` and `nearest` remain independent primitives. Row identity and
  result position are sufficient for application-owned reciprocal-rank fusion.

FTS5 remains the text-access path. Arbitrary database predicates compose for
eligibility and authorization, but V1 does not promise that they reduce the
work required to find text matches; SQLite's query planner decides the join
order. AckerDB does not duplicate filter columns into FTS or build filter-local
indexes or BM25 statistics.

Full-text subscriptions record the ordinary bounded predicate dependencies
plus one dependency for the selected target column's complete FTS corpus.
Predicate dependencies keep eligibility and returned-row changes reactive.
The corpus dependency is also required because FTS5's default BM25 statistics
cover that complete target index: an indexed-text change outside the predicate
population can still change the rank of eligible rows. A commit that changes a
target sidecar invalidates that target's corpus dependency, but not the corpus
dependency of another full-text column. V1 adds no tokenizer-coupled
term-dependency system.

AckerDB owns the private FTS5 external-content sidecars, each keyed by the
application row's primary key. The application table remains canonical;
generated private SQLite triggers keep every sidecar synchronized in the same
transaction as the application write. Insert and delete triggers maintain each
declared target; an update trigger runs only when that target's stored value
actually changes. Applications never query, migrate, or repair the private
objects themselves, and AckerDB mutation paths do not duplicate trigger-owned
synchronization.

Adding or changing a full-text declaration on a populated table is a blocking
schema reconciliation. AckerDB backfills and integrity-checks the complete private
index before the server becomes ready; it never serves partial search results.
Failure preserves the canonical application table and reports the unfinished
migration explicitly. Removing the declaration drops only its private FTS
objects.

AckerDB checks for both FTS5 and the `fts3tokenize(unicode61)` SQL interface only
when the application schema declares a full-text target. A runtime missing
either capability fails explicitly; schemas without FTS do not initialize
tokenizer machinery. An FTS-enabled Engine owns one private in-memory SQLite
connection for literal tokenization, so read-side query preparation never
borrows an application reader or contends on the serialized application writer
connection. Ranked SQL still executes against the caller's application
connection as one uncached statement that is finalized after the bounded
result is read.

## Future typo tolerance — explicitly not V1

A later version may add:

```ts
ctx.db.documents.fullText("body", query, { typoTolerant: true });
```

The option must require no application-managed dictionary, synchronization
job, or repair operation. V1 will not reserve or accept a no-op option.

The future design must preserve these boundaries:

- **One expansion, never replacement:** retain every original query token. An
  out-of-vocabulary token may add at most one accepted correction, OR-expanded
  with the original, so a stale vocabulary or imperfect correction cannot
  erase the caller's literal lookup or multiply FTS posting-list work.
- **Canonical vocabulary:** derive terms and their document/occurrence counts
  from the FTS5 index's column-scoped vocabulary. Do not separately tokenize
  application rows or create a second source of truth.
- **Upstream correction engine:** use SQLite's official `spellfix1` extension
  and its indexed vocabulary, edit-distance, frequency-aware ranking, and
  bounded candidate search. AckerDB must not replace this with a home-grown
  spelling algorithm unless evidence later proves a product requirement that
  `spellfix1` cannot meet.
- **AckerDB-owned installation:** ship pinned, prebuilt `spellfix1` artifacts for
  every supported OS and CPU and load the matching artifact internally. Do not
  require an application to install Homebrew, a compiler, SQLite headers, or an
  extension path. On macOS this also requires AckerDB to select a compatible
  loadable SQLite library before opening any database, because Bun's default
  Apple SQLite build disables extension loading.
- **Derived correction index:** maintain a private `spellfix1` vocabulary for
  each full-text target column, using FTS document frequency as the correction
  rank. It is disposable and rebuildable from the canonical FTS5 vocabulary.
- **Cheap query preparation:** exact vocabulary membership and bounded
  `spellfix1` candidate lookup must not scan the vocabulary. Token count, token
  length, edit distance, and correction candidates all need finite limits.
  Normal query construction should remain materially cheaper than executing
  FTS.
- **Event-driven refresh:** an indexed-text commit marks the accelerator dirty.
  A coalesced one-shot deadline refreshes after a bounded delay, while a
  bounded dirty-commit count forces an earlier refresh. There is no idle poller
  or per-write full-vocabulary rebuild. Refresh reconciles `spellfix1` from
  `fts5vocab` inside one writer transaction, so readers observe either the
  preceding vocabulary or the completed replacement.
- **Column scope:** vocabulary and candidate frequency belong to the selected
  full-text target column. A term present only in another indexed column is not
  evidence for correcting this query.
- **Quality, not correctness:** the accelerator is derived and may lag the
  canonical FTS index. Staleness must never bypass database predicates, expose
  unauthorized rows, corrupt stored state, or make index repair depend on the
  accelerator.
- **Finite ownership:** memory, refresh CPU, snapshot age, and refresh failure
  need observable bounds and typed outcomes. Missing, incompatible, or
  unloadable native artifacts must fail as an explicit capability/startup
  outcome, never silently disable requested typo tolerance.

Still to resolve before implementing typo tolerance:

- candidate acceptance and ambiguity thresholds;
- language and script boundaries;
- exact memory and refresh budgets;
- behavior while the accelerator is unavailable or over budget.
