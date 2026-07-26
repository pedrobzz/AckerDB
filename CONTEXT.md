# CONTEXT

Glossary of domain terms. Definitions only — no implementation details.

## Engineering philosophy

**Product performance** — Completing useful work quickly while remaining
predictable, economical, and safe at the intended load—not a narrow throughput
result that saturates a host.

**Default deployment envelope** — The default machine size AckerDB optimizes for:
4 vCPU / 4 GiB RAM.

**Design load** — Near-term sizing for the default deployment envelope: about
5,000 MAU with roughly 10% concurrently active (~500 connections with multiple
subscriptions).

**Minimal proportional cost** — CPU/RAM growth that stays in proportion to
connections, users, subscriptions, and updates, at the smallest practical
per-unit cost.

**Performance vector** — The dimensions used to judge a change: useful
latency/throughput, idle cost, memory ownership, scale shape, tail behavior,
startup/recovery, and durable correctness.

**Correctness** — Preservation of data and explicit uncertainty, a coherent
navigable design, and deliberate handling of severe credible edge cases.

**Design wall** — A case where a specification, assumption, test, or
integration does not fit the current model.

**Implementation safeguard** — Machinery the intended contract needs to
enforce an invariant (transaction, validation, bound, typed outcome, explicit
migration transform). Implementation, not a patch.

**Deferred-design workaround** — Narrow temporary behavior that exists only
because the known correct design is deferred.

**Accidental patch** — A special case, shim, parallel path, alternate channel,
compatibility layer, or test dodge added to avoid changing a wrong model.

**Severe credible edge case** — A low-frequency event whose realistic impact is
data loss, corruption, unbounded resource use, or a material customer failure.

**Net-effect judgment** — Scoring a decision against the simplest design that
still satisfies the required invariant, not against the decision's stated
purpose.

**Simplest sufficient design** — The implementation with the fewest mechanisms
that still enforces the required invariant. AckerDB does not add machinery merely
to imitate another system or erase an acceptable backend difference.

## Function outcomes

**Function result** — The typed outcome of a registered query, mutation, or
procedure call. Success is `Ok<T>` and an expected application failure is
`Err<E>`; handler authors may return a raw success value as `Ok` sugar.
_Avoid_: Transport response, thrown exception

**Application error** — An expected typed failure that application code
deliberately returns as `Err`. It is part of the function's result contract and
may be handled or mapped by its caller.
_Avoid_: Thrown error, framework failure

**Error mapping** — A function seam's deliberate replacement of selected
application-error variants with errors in its own vocabulary. Unmapped variants
remain part of the inferred result contract unchanged.
_Avoid_: Error swallowing, exhaustive redeclaration

**Unhandled failure** — An unexpected thrown defect or framework failure that
bypasses the application result contract. It poisons any ambient transaction
and is exposed outside the server only as a sanitized generic failure.
_Avoid_: Application error, returned `Err`

**Nested mutation scope** — The atomic child scope owned by every nested
registered application mutation. `Ok` merges its writes into the parent, `Err`
discards them, and an unhandled failure poisons the whole ambient transaction.
Plugin operations retain their separate pre-Result contract until that API is
changed explicitly.
_Avoid_: Independent transaction, ordinary helper call

## Framework runtime

**Plugin** — A reusable backend unit that owns isolated state and functions
and exposes a declared capability contract. A plugin never implicitly
extends its host's schema or gains access to host state.

**Application manifest** — The application's single executable assembly point,
declaring its root schema and named plugin instances. Operational settings
remain outside the manifest.
_Avoid_: Plugin registry, plugins file

**Plugin instance** — One configured occurrence of a plugin in an
application. Each instance has its own identity and isolated state, even when
several instances come from the same plugin definition. Every instance must
be named exactly once in the application manifest's `plugins` object;
dependency injection references that mount and never installs an instance.

**Plugin factory** — An ordinary typed TypeScript function that creates a
configured plugin instance. `definePlugin({ id, schema, create })`
returns this callable factory directly; the pure `create` callback receives
schema-bound function builders and returns the exported capabilities and any
lifecycle declaration. Plugin packages ship their source contract, not
plugin-specific generated bindings.

**Plugin definition identity** — The stable package-level name shared by
every instance and version of one plugin definition. It anchors the
definition's one static private schema identity. Factory options cannot select
or mutate a schema variant.

**Plugin mount** — A plugin instance's unique key in the application
manifest's `plugins` object. The mount names its server capability and
persistent private state, and becomes a direct property on every eligible
function context. It cannot collide with a built-in context field. In the alpha,
changing the key creates a fresh mount; removing the old mount requires an
explicit private-data drop.

**Plugin dependency** — An explicit reference to another plugin
instance's declared capabilities. The reference grants no access to the
dependency's private state or implementation, does not create another mount,
and is valid only when the referenced instance is mounted explicitly. A
definition declares each dependency under a local slot name; that slot becomes
a direct field on the plugin function context and is not re-exported.

**Capability contract** — The typed operations and execution kinds a plugin
dependency requires. Dependency injection targets this contract rather than a
specific plugin definition identity. The contract owns the consumer's exposed
call shape and compatibility metadata. Provider wiring compares canonical input
and result semantics, not the provider's normalized handler input; the selected
provider still owns runtime argument validation and normalization before its
handler runs.

**Plugin capability** — A plugin's declared server-only interface for
its host and dependent plugins. A mount named `cache` is used as `ctx.cache`,
not `ctx.plugins.cache`. Mounting a capability never creates a
client-callable endpoint; the application must expose any client operation
through its own function.

**Exported plugin function** — A plugin-owned query, mutation, or
procedure returned under `exports` by its plugin factory. The runtime binds
it under the plugin's mount name while preserving its execution kind and
isolation.

**Plugin call** — Invocation of an exported plugin function through a mounted
or injected capability. Queries and mutations use the caller's database context
without adding a Result boundary or child savepoint. A procedure call starts an
independent operation when no transaction exists.

**Internal plugin function** — A plugin-owned function omitted from its
factory's returned `exports`. Only the plugin itself may invoke it.

**Plugin authority** — Identity or claims explicitly passed to a plugin
function by its caller. A plugin never inherits the application's
authentication context implicitly.

**Invocation timestamp** — Unix time in milliseconds captured once when a
top-level function begins execution. Nested application functions, plugin
functions, and transactions inherit the same value explicitly as
`ctx.timestamp`.

**Plugin schema reset** — The v0.6.0 alpha recovery for an unsafe private
schema change. After explicit operator consent, AckerDB deletes only that mounted
plugin's private data and recreates its current schema. Safe changes
reconcile without data loss; plugins have no migration API or history in
this alpha. Development may request consent interactively; non-interactive
startup refuses until `acker plugin reset <mount>` is run explicitly.

**Plugin lifecycle** — The AckerDB-managed startup and shutdown boundary for a
plugin's external resources. Plugin construction is side-effect free;
resources start only after dependencies and private schemas are ready and stop
in reverse dependency order.

**Transactional capability** — A plugin capability whose work participates
in the caller's database transaction. It may be available to queries and
mutations, with each function receiving only the operations its execution kind
permits.

**External capability** — A plugin capability that crosses the AckerDB process
boundary to another service. It is available only to procedures and never from
inside a database transaction.

**Cache** — Disposable key/value acceleration whose contents are never a
source of truth. Clearing every entry may reduce performance but cannot change
an application's correct result or behavior.
_Avoid_: Durable store, key/value database

**Cache expiration** — The point after which an entry is a cache miss,
regardless of whether its stored bytes have been reclaimed. Physical deletion
is bounded cache maintenance, not scheduled application work. `set` replaces
the previous deadline. For the built-in store, a positive safe-integer duration
produces `ctx.timestamp + expiresInMs` and is compared with the frozen
invocation timestamp. External stores receive the duration and use their native
clock. Omitting the duration means no deadline in either case.

**Invalid cache expiration** — An `expiresInMs` that is zero, negative,
fractional, non-finite, unsafe as an integer, or would produce an unsafe
built-in deadline. It throws `InvalidCacheExpirationError` before the Cache
store is called.

**Cache capacity** — The finite logical-byte and entry-count budget owned by a
built-in cache instance. It defaults to 64 MiB total, 1 MiB per normalized key
plus encoded payload, and 10,000 entries. All limits are configurable but never
unlimited. Every entry remains evictable under capacity pressure, including
entries without an expiration deadline. The budget is shared across all
namespaces in that instance.

**Cache entry too large** — A `set` whose normalized key and encoded payload
exceed the instance's per-entry limit. It throws `CacheEntryTooLargeError`;
`set` returns `false` only when its atomic `if` condition is not satisfied.

**Cache eviction** — Capacity reclamation that removes expired entries first
and then entries in oldest-write order. Reads never update eviction metadata.

**Cache maintenance** — Bounded physical reclamation performed by the built-in
store on its write path. Cache reads never delete, update metadata, start a
timer, or perform a background sweep; external stores own their physical TTL
and eviction machinery.

**Cache API** — AckerDB's small TypeScript-native interface for key/value cache
operations, expiration, and conditional writes. Its semantics are familiar to
Redis users, but it is not a Redis command or protocol compatibility surface.
It is not a query capability: AckerDB queries read the source database directly.
_Avoid_: Redis client, Redis-compatible API

**Cache store** — The backend-independent storage contract required by a cache
plugin instance. The built-in store uses plugin-owned AckerDB storage;
external stores cross the procedure-only capability boundary. A custom store is
defined by `defineCacheStore({ keyPrefix, open })`; `open` returns only `get`,
atomic conditional `set`, `delete`, and an optional `close`.

**Cache-store adapter** — A bridge from an external cache service or client to
the Cache store contract. It owns vendor serialization and semantics without
exposing the vendor client through AckerDB. Every external adapter requires an
explicit application-and-environment key prefix; Cache appends its encoding
version, plugin mount, namespace, key type, and key. AckerDB owns the adapter's
resource lifecycle.

**Cache package** — The lockstep `@ackerdb/cache` package. Its root exports the
Cache plugin and store-authoring contract; `@ackerdb/cache/redis` and
`@ackerdb/cache/upstash` expose first-party adapters without creating separate
packages or vendor-specific context APIs.

**Cache namespace** — A named key partition declared by a cache plugin
instance with one value contract. It is only a typed validation and key-prefix
facade: it adds no capacity, eviction, lifecycle, or storage boundary. A stored
value that no longer satisfies the contract is a cache miss and may remain
physically stored until ordinary eviction.

**Cache key** — A string, finite number, or bigint normalized to its textual
representation with an internal type tag within one cache namespace. Strings,
numbers, and bigints with the same visible text remain distinct; numeric `0`
and `-0` intentionally share a key. Compound identity is an explicit string
composed by the caller.

**Cache payload** — A cache value encoded exactly once with the AckerDB wire
format before it reaches a Cache store. Stores treat the encoded string as
opaque and return it unchanged for decoding.

**Cache miss** — The absence of a usable cache entry, represented by
`undefined`. `null` remains a valid cache value, including for negative caching.

**Cache presence** — A non-expired encoded entry exists at the normalized store
key. Atomic `set` conditions test presence before decoding or namespace
validation, so a malformed or namespace-invalid entry may be present while
`get` reports a cache miss. An unconditional `set` replaces it.

**Cache deletion** — One store operation that physically removes the encoded
key without decoding its payload. It returns whether the entry was live at the
invocation timestamp: malformed and namespace-invalid live entries return
`true`, while an expired row is reclaimed but returns `false`.

**Cache store failure** — A storage, transport, timeout, authentication, or
connection failure reported as `CacheStoreError` with its original cause. It is
never converted into a miss or conditional result; callers choose explicitly
whether to catch it and fail open.

**Execution root** — The execution context a runtime subsystem owns and runs
its work under when that work is performed on its own behalf rather than a
caller's — e.g. the reactive system re-evaluating subscriptions for
subscribers. Work a caller triggers never carries the caller's context into
another subsystem's execution root; anything that must cross a scheduling
boundary crosses explicitly.

**Subscriber-facing work** — Runtime work that executes application code on
behalf of a subscriber (re-running a subscribed query, matching an event
listener). Always runs under the reactive system's execution root, under the
subscriber's own principal — never under the identity or context of whoever
triggered it.

## Validation

**Constraint** — A declarative rule that narrows the values admitted by a
validator without changing the value's TypeScript type. A stored constraint is
part of the declared schema and must hold for every stored row; a function-input
constraint applies only when that function is invoked.

**Nullable** — A value may be `null`. A nullable function input is still
required to be present; a nullable stored field is present in every row and
uses `null`, never absence, to represent no value.

**Optional** — A function input may be absent, in which case the handler sees
`undefined`; when present, the value itself may not be `null` unless its inner
validator admits `null`. Stored fields are never optional.

**Nullish** — A function input may be absent or explicitly `null`; absence
remains `undefined` while an explicit `null` remains `null`. Stored fields are
never nullish.

## Query model

**Table query** — The planner-independent ordinary read started by
`.query()`. It composes database predicates and explicit ordering before a
materializer; `get(id)` remains the direct primary-key read.
_Avoid_: Scan, index accessor

**Database predicate** — A typed condition evaluated by the database before
rows are ranked, limited, or materialized. An arbitrary application callback
is post-processing, not a database predicate.
_Avoid_: Filter

**Predicate expression** — The SQL expression produced by `.where((row) =>
...)`. Each field of `row` is a typed column reference with SQL comparison and
null operators; predicate results compose with `and`, `or`, and `not`.
Repeated `.where(...)` calls compose with `and`. The callback constructs an
expression and never receives or executes against a materialized application
row.
_Avoid_: JavaScript predicate, row callback

**Query order** — The lexicographic order declared with `.orderBy(...)` and
`.thenBy(...)`. Without one, rows order by primary key ascending; otherwise the
primary key is an implicit ascending final tie-breaker unless explicitly
ordered by the caller. Nulls precede values ascending and follow them
descending. Enum and union tags are stable storage identities rather than
logical sort positions, so enum and union columns are not query-order fields.
_Avoid_: Index order

**Transparent index** — An exact-result storage optimization selected by the
database planner. Public schema declarations identify indexes by their ordered
columns and configuration rather than a user-chosen name; AckerDB derives the
physical identifier. Composite indexes and multiple indexes per table remain
supported. Application queries never name an index, and adding, changing, or
removing one never changes exact results or the storage structure's
performance characteristics compared with an equivalent named index.
_Avoid_: Index accessor, named query

**Structural upsert key** — The exact field set of one declared non-null unique
index, passed to a writable table's `upsert`. Property order is irrelevant;
missing, additional, nullable, or ambiguous key fields are invalid. A
union-valued key lookup compares both its discriminant and payload; because the
declared SQLite index enforces the stronger discriminant uniqueness, the same
tag with a different payload conflicts instead of updating the wrong row.
_Avoid_: Named unique-index accessor

**Ranked retrieval mode** — The caller-selected basis for matching and ordering
rows. One AckerDB ranked retrieval uses either full-text search or exact similarity
search; it never combines or falls back between them.
_Avoid_: Unified search

**Top-k bound** — A positive maximum number of matches a ranked retrieval may
return. Full-text and exact similarity searches require one and expose no
unbounded collection, iteration, count, or pagination operation; CPU, memory,
decoded rows, and transport cost grow with the caller's chosen bound.

**Rank fusion** — Application-owned combination of independently executed,
bounded ranked retrievals by row identity and result position. AckerDB supplies
the retrievals but never chooses candidate depths, fusion rules, weights, or
fallback behavior.
_Avoid_: AckerDB hybrid search

## Full-text search

**Full-text search** — A ranked retrieval over explicitly indexed text within
the rows admitted by its database predicates. Predicates determine which rows
may be returned; they do not redefine the full-text relevance model or its
target-column-wide corpus statistics.

**Literal full-text query** — Text whose characters always represent searchable
content, never operators or backend query syntax. SQLite's byte-compatible
`fts3tokenize(unicode61)` tokenizer supplies the FTS5 tokens; AckerDB quotes each
token as its own phrase and composes them with implicit `AND`. Input that
produces no tokens produces no matches. Callers do not escape or assemble an
expression.
_Avoid_: Raw FTS query, MATCH expression

**Full-text index** — A table's explicit declaration of the string columns
whose text participates in full-text retrieval. A table without one does not
support full-text search merely because it contains string columns.
_Avoid_: Automatic string indexing

**Full-text target column** — The single column selected explicitly by a
full-text search from its table's full-text index. Other indexed columns do not
participate in that retrieval, and an undeclared string column is never a valid
target.
_Avoid_: Search index name

**Full-text corpus dependency** — The reactive dependency for one selected
full-text target's complete FTS corpus. It complements ordinary predicate
dependencies because an indexed-text change outside the eligible population
can still change that population's ordering through target-wide BM25
statistics. Corpus dependencies are per target column, not per table.

**Full-text result** — A table row returned directly in relevance order, with
the application primary key ascending as the deterministic tie-breaker. The
selected sidecar's `rank` orders matches and its `rowid` restricts them to the
canonical application row, but AckerDB exposes neither private value. Application
row identity and result position are sufficient for application-owned rank
fusion.
_Avoid_: BM25 score, relevance score

**Typo-tolerant query expansion** — An opt-in literal full-text query that
preserves each caller token and may add at most one vocabulary-backed
alternative for a token absent from the selected target column. An alternative
never replaces the caller's text.
_Avoid_: Autocorrect, query replacement

## Vector search

**Vector** — A fixed-dimensional dense numeric value that AckerDB can store,
validate, manipulate, and compare. A vector may represent an embedding, but is
not inherently model-generated.
_Avoid_: Embedding, when the value's model origin is irrelevant

**Vector column** — A schema field declared with `v.vector(dimensions)` and
stored as a dense Float32 vector of exactly that dimensionality. It composes
with the same nullability modifiers and ordinary insert, update, replace, and
read operations as other stored fields.
_Avoid_: Embedding column

**Vector value boundary** — Inserts, updates, and similarity query vectors
accept a `readonly number[]` of exactly the declared dimensionality. AckerDB
rejects non-finite coordinates and values that overflow Float32, rounds every
accepted coordinate to Float32 once at the boundary, canonicalizes negative
zero to zero, and returns stored vectors as ordinary readonly number arrays
containing those Float32 values.

**Embedding** — A vector generated outside AckerDB by an AI SDK or another model
library. AckerDB stores and manipulates embeddings but never generates them.
_Avoid_: AckerDB-generated embedding, derived embedding column

**Embedding backfill** — An application-owned batch workflow that generates
missing embeddings outside database transactions and persists them through
ordinary AckerDB mutations. Existing tables normally add a nullable vector column,
backfill it in bounded batches, and optionally tighten nullability afterward;
migrations never call an embedding model.

**Distance metric** — A rule that assigns a distance to two vectors of equal
dimensionality for ranking. Every AckerDB metric is oriented so a lower distance
means a nearer match: cosine is one minus cosine similarity, L2 is Euclidean
distance, and dot is the negative dot product.
_Avoid_: Similarity score

**Similarity match** — A schema row selected by a similarity search together
with its exact distance from the query vector.

**Similarity-eligible vector** — A stored vector for which the selected metric
is defined. Null vectors are ineligible for every similarity search. A zero
vector remains valid stored data and is eligible for L2 and dot searches, but
is ineligible for cosine search. A cosine search rejects a zero query vector
rather than inventing a distance.

**Similarity dependency** — The reactive read dependency of a similarity
search. It covers the predicate-eligible candidate population and relevant
vector-column state, not only the current top-k rows, because a write to an
unreturned row can change the result. Ordinary predicate indexes narrow the
dependency when possible without weakening invalidation correctness.

**Exact similarity search** — The true nearest rows under a chosen distance
metric among all rows satisfying a database predicate. Predicate filtering
occurs before distance calculation, ranking, and limiting. Ordinary indexes may
narrow the eligible population, but distance work remains linear in the number
of eligible vectors, retained ranking state is bounded by the caller's top-k,
and results remain exact. Results order by distance ascending and then by
primary key ascending, making equal-distance matches deterministic; `.first()`
is equivalent to the first element of `.take(1)` or null.

## Schema migrations

**Reconcile** — The startup pass that compares the application's declared
schema against what the database last stored and applies the difference.
Applies shape-safe changes on its own; refuses shape-unsafe ones until a
migration answers for them.

**Shape-safe change** — A schema change that cannot lose or invalidate
existing data no matter what that data is — judged by the shape of the change
alone, always presuming rows exist. Applies automatically, identically in dev
and prod, with no migration file.

**Shape-unsafe change** — A schema change that poses a per-row question:
existing rows could be lost or would need transformation to satisfy the new
schema. Always requires a migration answering that question, even when the
actual table happens to be empty.

**Optimistic change** — A schema change that transforms no rows but tightens a
cross-row constraint (e.g. a unique index over existing data). It is attempted
as if safe: either it holds, or it is refused cleanly with nothing touched.
A refusal is resolved by a migration with a volunteered transform.

**Migration** — A versioned TypeScript file that declares only what a schema
diff cannot infer or must not assume: which drops-plus-adds are really
renames, how existing rows become valid rows of the new schema, and an
explicit acknowledgment for every drop that destroys data. Never a source of
structural truth — structure always comes from the schema declaration.

**Row transform** — A migration's per-table function answering "what does this
old row become in the new database?" Its answer may be a row in the same
table, nothing (the row is dropped), and/or rows emitted into other tables.
Transforms see only the frozen before-state and never observe each other's
output.

**Emit** — A row a transform produces into a table other than its own, derived
from the old row in hand. The mechanism for restructures that move data
between tables (e.g. a 1-1 foreign key becoming an N-N junction table).

**Volunteered transform** — A row transform supplied for a table the reconcile
did not refuse, used to backfill data an automatic change would have left
empty. Refused tables must have a transform; any table may.

**Drop acknowledgment** — A migration's required, explicit answer for a
dropped table or column holding data: either the data goes nowhere, or a
salvage transform carries it into surviving tables first. Nothing is dropped
silently; the acknowledgment is visible in the migration itself.

**Salvage transform** — A row transform for a dropped table. It produces no
same-table rows (the table is going away); it exists only to emit surviving
data into other tables before the drop.

**Before-state** — The read-only, frozen image of the database as it was
before the migration, visible to every transform for cross-table lookups.

**Rename declaration** — A migration's statement that a dropped and an added
name (table, column, or enum variant) are the same thing renamed, so its data
and identity carry over instead of being dropped and recreated.

**Pre-snapshot** — The recorded image of the schema as it stood when a
migration was generated. It types the migration's before-state, and stays
sound for every database the migration can legally meet, because the only
permitted divergence is safe drift.

**Target snapshot** — The full declared schema at the moment a migration was
generated: the state the migration is contracted to reach. The meta sidecar's
load-time integrity check recomputes a fingerprint from it; the applied
immutability identity covers it alongside the number, name, pre, and file bytes.

**Safe drift** — The accumulation of shape-safe changes applied automatically
between migrations. Safe drift only widens what a database can hold (an
absent nullable column reads as null, an absent table as empty), which is why
a migration's recorded types survive it.

**Migration history** — The database's append-only record of which migrations
have run, each stamped with its identity (a hash over number, name, pre, target,
and file bytes). It must always be a prefix of the application's migration chain;
an applied migration is immutable, and any edit to one — its pre, target, or
transform code — shifts the identity and is refused, never silently ignored.

**Change ledger** — The grouped report of every schema change between what the
database stored and what the application declares: the changes that need a
migration (each with its per-row question) and the shape-safe changes that
ride along automatically. Displayed, never persisted; shown wherever consent
is asked and whenever a migration is generated.

**Consent** — The developer's explicit yes at a dev-loop gate: generating a
migration for the change ledger they were shown, or applying pending
migrations. Consent is always pinned to exactly what was shown — a generation
yes carries the displayed ledger's fingerprint and refuses stale, an apply yes
is asked against the pending chain's identity. No migration file exists and no
migration runs in interactive dev before the matching consent.

**Declined** — The dev-loop state after the developer answers "not yet" to a
migration question: the server stays down, nothing is written or persisted,
and the state releases when the ledger changes — a rescued schema starts the
server silently, a different ledger asks again, and generation stays available
on demand.

## Demo app (Savoria restaurant)

**Admin MCP** — The demo backend's single MCP endpoint. Isolated and staff-only:
it exposes the restaurant's business data and exactly two staff actions. Both
the in-app Admin Chat and external agent hosts (Codex, Claude Code) consume the
*same* Admin MCP with the same capability surface; what a caller may do is
decided by the authority attached to its credential, never by which consumer it
is. A future guest/mobile MCP would be a separate named endpoint, not an
extension of this one.

**Admin Chat** — The staff-facing conversational assistant embedded in the
Admin Panel. Answers open-ended questions about the live business (occupancy,
kitchen queue, revenue, waiting times) and can perform the two staff actions.
All of its data access goes through the Admin MCP's tools — it has no private
side-channel to the database.

**Action tool** — One of exactly two mutating tools on the Admin MCP: advance a
kitchen item's status, and cancel an open order. Every other tool is read-only.

**Entity query tool** — A typed read-only tool exposing one entity collection
through simple query-shaped arguments (filters, limits) — e.g. dishes, tables,
orders. Deliberately basic: it answers direct lookups, never analytics. Exists
so a small model can answer simple questions without composing pipelines.

**Bash workspace** — The Admin MCP's open-ended read tool: a sandboxed shell
whose files are the restaurant's live data rendered as JSONL, materialized
fresh at call time and discarded afterwards (never stored, therefore never
stale). Exists so a capable model can answer arbitrary analytical questions
the entity query tools never anticipated.

**Owner token** — An identity-bound bearer credential a staff member issues to
let an external agent host call the Admin MCP. Its scopes decide read-only vs
read+mutate. The secret is revealed exactly once at issuance.

**`read` / `operate`** — The Admin MCP's only two scopes. `read` grants every
read-only tool (entity query tools and the bash workspace); `operate` grants
the two action tools. The in-app Admin Chat always holds both; an owner token
holds whatever was chosen at issuance.

**Agents page** — The Admin Panel section where staff connect external agents:
it shows the Admin MCP's endpoint and install configuration and manages owner
tokens (issue, scope, revoke).
