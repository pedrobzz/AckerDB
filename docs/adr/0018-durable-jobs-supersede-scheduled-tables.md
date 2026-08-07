# Durable jobs supersede scheduled tables

> The storage half of this decision is refined by
> [ADR-0023](0023-a-job-and-its-runs-are-separate-rows.md): the single
> `_ackerdb_jobs` table below is now a Job row plus one `_ackerdb_job_runs` row
> per handler execution. Everything else here stands — including the promise
> that an admitted job is durable, which is why that change transforms the old
> table instead of dropping it.

Applications need durable background work: send the receipt after the
purchase commits, charge with retries, rebuild a projection nightly, never
process two operations for one cart at once. Scheduled tables — the previous
answer — ran only mutations, had no retry policy, no deduplication, no way to
await an outcome, and one availability defect: a persistently failing due row
was retried on a flat one-second interval forever, and because the scheduler
executed the globally minimum due row first and aborted its batch on the first
failure, one poisoned row head-of-line blocked every row due after it.

The alternative — an external queue — requires operating a Redis beside the
one-process/one-file deployment and reintroduces the dual-write problem: a
mutation that commits while its enqueue fails, or the reverse. The standard
industry fix is a transactional outbox table inside the database, which is
half of a job system built by hand.

We therefore make jobs a framework primitive and make the outbox *be* the
queue. One framework-owned table, `_ackerdb_jobs`, joins the **logical
schema** at the Engine seam: storage, shape-classified migrations,
reactivity, backups, and CRUD treat it exactly like an application table
(adding it to an existing database is one additive shape-safe migration), yet
it is injected by the Engine, so it exists in every application and can never
collide — application table names must start with a letter. Enqueue is a row
insert in the caller's own transaction: the job exists if and only if the
mutation committed.

Jobs are declared in a `jobs/` directory, discovered and named like functions
and services, for ADR-0016's reasons: typed authority without a manifest
cycle, and no handler imports in schema tooling. Each definition declares its
envelope. A mutation-kind job collapses claim, handler, and settle into one
writer transaction — exactly-once, no external I/O, the old scheduled-table
guarantee kept. A procedure-kind job (the default) is claimed under a lease,
runs as a system operation with external work allowed, and settles in a
transaction that re-validates state and lease — at-least-once under retries,
with a stale lease discarding the late result rather than double-settling.
Crashed attempts are recovered when their lease expires, through the same
retry policy as any failure; a poisoned job discards and can never block
other due work.

Retry and recurrence are one concept: a function returning the next run time
or null, consulted at settle. Declarative forms — attempts with backoff, cron
with an IANA timezone, fixed intervals — are sugar over it. The framework
mints the next occurrence of a repeating job at settle regardless of the
run's outcome, as a fresh durable row, so recurrence cannot die from a
handler bug and a missed occurrence fires once, late, at startup.
Deduplication is opt-in, keyed on the canonical args encoding, collapsing
live duplicates and optionally memoizing settled outcomes per state, up to
forever. Concurrency caps apply per definition, or per derived key —
per-entity serialization without an actor model; a job in retry backoff
holds no slot.

The public scheduled-table surface — `.scheduled(...)` and `v.scheduleAt()`
in application schemas — is removed, not deprecated: two overlapping
primitives would make every future scheduling decision ambiguous. The
scheduler's machinery (due-row scan, timer arming, commit-triggered re-arm)
survives as the runner's engine. Column ownership of `_ackerdb_jobs` is split
exactly at the state machine: scheduling intent (`runAt`, `key`, `argsJson`)
is open CRUD, the state machine is guarded and moved only through sanctioned
transitions, and inserts go through enqueue — enforced in the jobs table's
access layer, not as a general column-policy concept. Awaiting a job resolves
at the current attempt's settle with the ordinary typed outcome plus
`nextRetryAt`, and is absent from mutation contexts by construction — a
mutation holds the serialized writer and must not wait behind it.

What jobs deliberately do not do: run handlers in worker threads or
subprocesses, rate-limit by time window, express declarative DAGs, order
strictly across retry backoffs, or distribute across machines. A Service
owning an external queue remains the escape hatch for workloads outside the
single-node envelope.
