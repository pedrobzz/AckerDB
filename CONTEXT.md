# CONTEXT

Glossary of domain terms. Definitions only — no implementation details.

## Engineering philosophy

**Product performance** — Completing useful work quickly while remaining
predictable, economical, and safe at the intended load—not a narrow throughput
result that saturates a host.

**Default deployment envelope** — The default machine size DBzz optimizes for:
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

## Framework runtime

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

**Consent** — The developer's explicit yes to generating a migration for the
change ledger they were shown. Consent is fingerprinted against the exact
ledger displayed; if the schema moves before the yes lands, the stale consent
is refused and the question is asked again over the fresh ledger. No migration
file exists before consent.

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
