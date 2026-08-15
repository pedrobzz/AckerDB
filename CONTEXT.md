# CONTEXT

Glossary of domain terms. Definitions only — no implementation details.

## Engineering philosophy

**Design wall** — A case where a specification, assumption, test, or
integration does not fit the current model.

**Accidental patch** — A special case, shim, parallel path, alternate channel,
compatibility layer, or test dodge added to avoid changing a wrong model.

**Simplest sufficient design** — The implementation with the fewest mechanisms
that still enforces the required invariant. AckerDB does not add machinery merely
to imitate another system or erase an acceptable backend difference.

**Commodity** — Generic, reusable substrate that systems of AckerDB's class
commonly need and that carries no unique product value: storage, transport,
signaling, scheduling, retries, auth protocols, serialization.

**Policy** — Product-specific behavior that makes AckerDB distinct: its rules,
invariants, supported features, public API, and interaction model.

**Converged surface** — One AckerDB definition serving what is normally several
systems, such as a single procedure observed reactively, exposed over HTTP,
offered as an MCP tool, and memoized as a durable step.

**Supervised fork** — A vendored or forked third-party implementation under
AckerDB ownership, pinned to an immutable revision and recording the upstream
revision it came from.

**Policy–commodity seam** — The narrow interface through which policy uses only
the capability commodity exposes, and behind which the commodity can be
replaced without policy surgery.

## Function outcomes

**Function result** — The typed outcome of a registered query, mutation, or
procedure call. Success is `Ok<T>` and an expected application failure is
`Err<E>`; handler authors may return a raw success value as `Ok` sugar.
_Avoid_: Transport response, thrown exception

**Query procedure** — A procedure observed as repeatable, query-shaped client
demand. Equal demand shares executions, while idempotence remains an
application-owned promise rather than a distinct enforced function kind.
_Avoid_: Reactive query, idempotent procedure

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
_Avoid_: Independent transaction, ordinary helper call

## Framework runtime

**Application manifest** — The application's single executable assembly point,
declaring its root schema. Operational settings remain outside the manifest.

**Job definition** — A declared kind of durable application work, combining
its handler with the policies governing its execution.
_Avoid_: Job, job handler

**Job** — One durable admission of a Job definition with canonical arguments,
scheduling intent, and dedupe identity. A Job may own multiple Job runs before
it reaches a terminal state.
_Avoid_: Job record, job row, Job run

**Job run** — One actual handler execution owned by a Job, from claim through
settlement. A dedupe hit creates no Job run because no handler executes.
_Avoid_: Job attempt, enqueue, dedupe hit

**Retrying Job** — A non-terminal Job whose latest Job run failed and whose
next Job run is durably scheduled by its retry policy.
_Avoid_: Failed Job, pending Job

**Failed Job** — A terminal Job whose latest Job run failed and whose retry
policy admitted no further run.
_Avoid_: Discarded Job, exhausted Job

**Manual retry** — An administrator's instruction to give a Failed Job another
Job run while preserving the Job's identity and run history.
_Avoid_: Run again, replay

**Run again** — An administrator's instruction to submit a terminal Job's
arguments through its Job definition again. The definition's ordinary dedupe
policy may resolve it to an existing Job and memoized outcome without creating
a Job run.
_Avoid_: Force run again, Manual retry

**Force run again** — An administrator's instruction to give a terminal Job
another Job run under the same identity and history, replacing any memoized
outcome with the new run's outcome.
_Avoid_: Duplicate Job, bypassed dedupe identity

**Repeat policy** — The rule on a Job definition that decides whether and when
another Job follows a terminal Job. It is not a separately owned schedule.
_Avoid_: Schedule, cron job

**Upcoming Job** — A future Job that already durably exists and is waiting for
its execution time. A projected calendar occurrence is not an Upcoming Job, and
its first Job run does not exist until the handler is claimed.
_Avoid_: Upcoming run, forecast Job, projected occurrence

**Invocation timestamp** — Unix time in milliseconds captured once when a
top-level function begins execution. Nested application functions and
transactions inherit the same value explicitly as `ctx.timestamp`.

**System execution root** — Trusted application work initiated directly by an
in-process host that explicitly holds the running application's system
capability. Each run begins with only the canonical system principal, may use
procedure capabilities and external I/O outside a transaction, and may open
short Result-aware transactions. It never inherits ambient caller authority or
pretends to be a request, session, or registered outer function.
_Avoid_: Local procedure call, background job, ambient system context

## Durable jobs

**Step** — One named, journaled unit of work inside a procedure-kind job
handler. A completed step's recorded result stands in for re-execution when
the handler replays, so a Job run executes only work the journal has not
recorded. The name carries the author's promise that the same name means the
same meaning.
_Avoid_: Sub-job, child job, workflow task

**Step journal** — The durable record, owned by a Job, of each completed
step's identity and result. Replay reads the handler against it: a recorded
entry answers instead of executing, and a mismatch between journal and code
refuses with a typed outcome rather than guessing. It outlives one Job run —
a Manual retry resumes it and only a Force run again clears it — and it lives
and dies with its Job.
_Avoid_: Event history, workflow state, checkpoint

## File storage

**File** — Immutable AckerDB-owned stored bytes, their fixed framework metadata,
and their immutable optional owner, identified independently of the application
records that refer to them. Replacing the bytes creates a different File.
_Avoid_: Attachment, blob row

**File owner** — The durable user identity captured from the File upload
session's creator, or explicitly supplied by trusted server-side code. Ownership
is searchable File state but does not itself grant retrieval authority.
_Avoid_: Uploader metadata, File authorization

**Pending File** — A successfully stored File awaiting its first durable
application claim. A pending File expires if no application row claims it and
may be claimed explicitly when it is intentionally standalone.
_Avoid_: Temporary upload, orphaned File

**File upload session** — Short-lived, constrained authority to store at most
one File. Failed attempts may retry until one File is stored successfully or
the session expires.
_Avoid_: Upload URL, presigned upload

**File grant** — Independently revocable authority to retrieve one File under
declared access conditions. Revoking a grant does not delete the File.
_Avoid_: File URL, public file

**Bearer File grant** — A File grant for which possession of its unguessable
URL is the complete retrieval authority; no user principal is required.
_Avoid_: Public File grant

**Authenticated File grant** — A File grant that admits any request carrying a
valid AckerDB user principal without making an application-specific access
decision.
_Avoid_: Private File grant

**Validated File grant** — A File grant whose every retrieval must be admitted
by an application-owned read decision under the request's current principal and
the grant's typed authorization arguments.
_Avoid_: Private File, authenticated URL

**File reference** — An application-owned relation from an ordinary typed row
to a File, declared explicitly by that row's schema. It owns searchable business
metadata and application relationships instead of extending the File's
framework metadata.
_Avoid_: Custom file column, file metadata

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

## Application channels

**Application channel** — A typed bidirectional application communication
contract. A channel may opt into room partitioning; an unroomed channel has no
room membership concept.
_Avoid_: WebSocket, provider session

**Channel event** — A named typed message sent in one direction through an
application channel. React observers may handle channel events through a named
handler map or one discriminated-union handler without changing the event
contract.
_Avoid_: Raw WebSocket message, database event

**Channel send outcome** — The local result of offering one client event to the
current application-channel transport. Success does not claim that the server
received or processed the event; failure leaves no event queued for reconnect.
_Avoid_: Server acknowledgement, handler result

**Channel delivery audience** — The recipients selected by one server-side
channel operation. A handler may send to its current member, publish to every
member of its current channel or room including itself, or use an explicit
server-only operation to publish to another typed channel subscription.
Client events cannot name a delivery audience independently of the subscription
that carried them.
_Avoid_: Client-selected room, implicit sender exclusion

**Room** — An opt-in membership boundary within one application channel. Every
membership in a roomed channel names exactly one room; room identity and
membership never cross into another channel, and clients cannot join all rooms
through a wildcard.
_Avoid_: Channel, provider session

**Channel membership authorization** — The optional application decision made
before one client joins an application channel or room. It runs under the
current authenticated principal and may reject with a typed error or establish
typed ephemeral membership state for subsequent channel handlers. Authorization
is evaluated again after reconnect or authentication change; prior membership
state is never trusted across either boundary.
_Avoid_: Connection authentication, durable session

**Channel subscription** — One shared client-lifetime membership identified by
an application channel, canonical arguments, and its optional canonical room.
One or more local observers may retain it without creating additional server
subscriptions.
_Avoid_: Hook instance, WebSocket connection

**Channel observer** — One local consumer of a channel subscription, with its
own message and lifecycle handlers. Every matching delivery reaches each
observer once, independently of the other observers' behavior.
_Avoid_: Channel subscription, server subscriber

**Handler key** — An optional identity that coalesces one complete local `on`
handler namespace without comparing function identity. It never changes
network identity or ownership. Channel subscriptions may retain independent
keyed handler bundles. A missing or conflicting key is programmer misuse.
_Avoid_: Hook ID, idempotency key, subscription key

## External authentication

**Exact issuer** — An OIDC provider's registry key: the byte-exact string a
verified token's `iss` claim must equal. AckerDB validates that it is a
well-formed URL on a permitted scheme but never normalizes or rewrites it;
there is exactly one correct value per provider — whatever that provider
actually mints.
_Avoid_: Canonical issuer, normalized issuer, issuer URL matching

**Unchecked enforcement** — A provider configuration's explicit declaration,
per verification dimension, that a check is deliberately not performed. An
enforcement dimension is always either fully specified or visibly declared
unchecked; it is never silently absent by default. Claim projection follows
the same rule: a selection or the explicit none, never a silent empty.
_Avoid_: Optional audience, implicit default, lenient mode

**Provider preset** — A named identity provider's published token shape,
resolved into exact configuration at startup. A preset fills in only the
fields whose values follow from what the provider mints, refuses the ones
only the application can supply, and its resolution is always inspectable.
It compresses exact configuration; it never replaces or weakens it.
_Avoid_: Auth integration package, discovery-trusted config

**Private plaintext boundary** — The rule deciding where an identity
provider may be reached without TLS: loopback hosts by default, where
plaintext cannot cross a network at all; private-network addresses only
under an explicit per-provider declaration, because private ranges are
attackable networks; public hosts never, in any mode.
_Avoid_: Dev-mode HTTP, trusted LAN default, TLS exemption

**Credential source** — The application-owned callback that produces the
client's current explicit credential on demand, including the explicit
anonymous credential for signed-out state. The client owns when to ask:
at construction, ahead of disclosed credential expiry, and after a
principal rejection. Configured instead of, never alongside, a fixed
credential.
_Avoid_: Token callback, auth provider hook, implicit anonymous fallback

**Credential TTL disclosure** — The server's statement, on every accepted
credential presentation, of how long that credential remains valid, as a
relative duration. It exists so the client can refresh proactively without
assuming any credential format; anonymous principals have none.
_Avoid_: Token expiry parsing, client-side JWT decoding

**Awaiting principal change** — The state of client demand whose
subscription the server rejected with an authentication or authorization
outcome while the demand itself persists. Such demand is re-presented
exactly when the connection's accepted principal changes, and never on a
timer.
_Avoid_: Subscription retry loop, skip gating, dead subscription

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

**Serializable filter expression** — A caller-supplied database predicate in
closed wire form: comparison and membership clauses over declared filterable
fields, composed by nested `all` and `any` groups. The server validates it and
compiles it into ordinary predicate expression nodes, so it selects rows
through the same path a `.where` callback does and never names an index.
Validation failures are application errors carrying one issue per offending
node, located by path from the expression root.
_Avoid_: Query DSL, filter language, client-side filtering

**Filterable field** — A column a table declares as accepting serializable
filter clauses. The declaration is a boundary, not a convenience: an undeclared
column is unknown to filtering even when queries return it, because a filter
reveals whether rows exist without returning them.
_Avoid_: Implicit column exposure, filter allowlist bypass

**Query page** — One slice of a table query's declared order, bounded by both a
requested row count and the framework's page byte budget, plus the opaque
cursor that resumes after its last row. The byte budget removes rows, never
fields, and always admits the first row, so a page may be shorter than
requested and only its cursor states whether more rows exist.
_Avoid_: Offset page, truncated row

**Live page window** — The client's flattened view of consecutive query pages,
each held as its own live subscription so a write inside the window re-delivers
the page it touched. When a delivery moves a page's cursor, every page behind it
is released and the window shortens to its proven prefix rather than showing an
overlap, then grows back to the depth its consumer asked for as each new
boundary proves. Each page is individually consistent and the
window is consistent across pages only eventually: one commit changing two
pages sends two deliveries, and a row crossing a boundary between them can
briefly repeat or disappear until the predecessor's own delivery lands.
_Avoid_: Infinite scroll cache, accumulated snapshot, atomic window

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

## Administration

**Admin API** — The built-in administration surface every application carries:
framework-declared functions that observe the application and administer it.
It is the server side of administration, named for what it does rather than for
any client that consumes it.
_Avoid_: Client-specific surface, system UDFs, dashboard API

**Framework-declared function** — A function AckerDB declares on every
application's behalf, contributed to the registry beside the application's own
rather than injected into them. It is an ordinary registered function in every
other respect: one address, one route, one access policy, one scope
requirement, dispatched through the one funnel. Only a framework-declared
function may require an admin scope.
_Avoid_: Built-in function, system UDF, internal endpoint

**Admin configuration** — The one object holding everything administrative,
because an operator reasons about administration as one thing rather than as a
setting beside each subsystem it touches. It is where the surface is
configured, never where authority is decided — that is the grant a credential
holds.
_Avoid_: Client config, dashboard settings

**Reserved marker** — The leading `_` that marks a name as the framework's own,
across every namespace an application shares with it: API paths, HTTP roots, and
scopes. An application may never declare a name carrying it, so the two
vocabularies cannot collide. Framework *tables* are the one exception: they
carry the older `_ackerdb_` prefix (`_ackerdb_jobs`, `_ackerdb_credentials`,
`_ackerdb_meta`, …), which is in released 0.16.0 data and cannot be unified
without rewriting every existing database.
_Avoid_: Private prefix, system namespace, underscore convention

**Scope** — One named unit of authority in the single authorization vocabulary,
opaque to the framework. A scope is the currency of both halves of that
vocabulary: an application's own names, and the framework's `_`-marked ones.
_Avoid_: Permission, role, claim

**Scope vocabulary** — The complete set of scopes that exist: the application's,
declared once in the manifest, plus the framework's, which AckerDB pre-declares.
Nothing outside it can be granted or required, so every check is a membership
test against a known set rather than string comparison against a guess.
_Avoid_: Permission list, ACL

**Scope grant** — What an Identity holds, written as patterns and resolved by
expansion against the vocabulary known at the moment of the check. A grant may
therefore cover a scope that did not exist when it was issued, and one covering
nothing that exists grants nothing.
_Avoid_: Permission set, role assignment

**Scope requirement** — What a function or tool entry demands of its caller,
always concrete: `anyOf` passes on one held scope, `allOf` on every one. A
requirement never carries a wildcard — it names exactly what it needs, so it can
be read and audited without knowing the vocabulary.
_Avoid_: Guard, permission check

**Identity credential** — An opaque bearer credential that *is* an Identity:
issuing one mints an Identity, so its holder is a first-class user at every
choke point rather than a second kind of caller. Its secret is shown once, at
issuance, and only its digest is stored.
_Avoid_: API token, service account, machine user

**Child credential** — An identity credential issued by another Identity, whose
authority is bounded by its issuer's at both ends: a scope the issuer does not
hold cannot be delegated, and the child's live authority is intersected with its
issuer's current grant on every use. A parent losing a scope narrows every
descendant immediately, with no revocation sweep.
_Avoid_: Sub-token, delegated key

**API path** — The named group a function is published in, and the first
segment of its function address. It decides the generated binding and the HTTP
root together, because both are read off that one address. It is a namespacing
choice and never an access rule: who may call a function is decided by its
access policy alone. No group's name may carry the reserved marker: the
framework's protocol endpoints live at the reserved root, outside every group,
and its administration functions live in the shared `admin` group, whose members
are distinguished by the scopes they require rather than by any marking on the
path. `api` and `admin` are the two groups every application publishes, so a
manifest lists neither.
_Avoid_: Internal flag, private function, route prefix

**Function address** — The one dotted name every registered function answers
to, in process and over every transport: its API path, then the directory
segments of the module declaring it, then the export name. The HTTP route is
that address segment for segment. A file named `index.ts` contributes its
directory's name rather than its own, so a directory may hold a module of its
own name beside its siblings.
_Avoid_: Function name, ref string, route

**Admin scope** — A scope in the framework's own reserved vocabulary, naming one
verb on one administrative domain, written `_admin:<domain>:<verb>`. AckerDB
defines the whole vocabulary and an application never declares one.
_Avoid_: Client scope, system permission

**Scope wildcard** — A pattern in a grant that stands for every scope it
matches, resolved against the vocabulary known at the moment of the check. The
pattern `*` deliberately excludes everything carrying the reserved marker, so
the two vocabularies are only ever granted on purpose — an administrative
identity holds both `*` and `_*`.
_Avoid_: Role, superuser flag, permission group

**Admin Credential** — The opaque credential that authenticates an
administrative identity, distinct from any application user and from the system
principal. Its authority is nothing more than the grant it holds: the patterns
covering both the application vocabulary and the framework's reserved one. It is
a root credential — one with no parent — because nothing may narrow
administrative authority at use; a child holding the same patterns is a delegate,
not a master. An application manages a single master Admin Credential by default,
though the model admits more.
_Avoid_: admin token, API key, master key

**Credential rotation** — Replacing an Admin Credential with a newly issued one
and revoking what it replaced, as a single change. The credential's Identity
changes with it, because a credential is an Identity: rotation issues, it does
not re-key.
_Avoid_: key rotation, re-issue, refresh

**Agent Credential** — A credential issued for one external agent host, holding
a chosen subset of an Admin Credential's authority. It is an ordinary child
credential: an agent is a first-class identity, and its grant never exceeds its
parent's, at issuance or afterwards.
_Avoid_: MCP token, API key, service account

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
