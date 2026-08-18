# Durable jobs

A **Job** is durable background work an application enqueues from its own
functions and AckerDB executes, retries, repeats, and retains. Every Job is a
row in the framework-owned `_ackerdb_jobs` table, and every actual handler
execution is a **Job run** in `_ackerdb_job_runs`. Both live inside the logical
schema: enqueues are transactional with the mutation that caused them, state
survives restarts, and both tables are reactive and queryable like any
application table.

The split is the whole model. A Job is one durable admission — canonical
arguments, scheduling intent, dedupe identity. A Job run is one claim through
one settlement, with its own timing, outcome, and error. A dedupe hit produces
no run at all, because no handler executes.

Jobs supersede scheduled tables (ADR-0018). A Job is one unit of work with an
envelope and a policy. No client can address a job — clients observe job state
only through functions the application authors.

## Declare a job

Jobs and functions live in the same configured definition roots. With the
default `definitions: ["./app"]`, `app/emails.ts` exporting `sendReceipt` is
the Job `emails.sendReceipt`. Additional roots or individual TypeScript files
can be listed in `definitions` in `.ackerdb.config.json`; all of them publish
into the same namespace.

```ts
// app/emails.ts
import { v } from "@ackerdb/server";
import { job } from "../_generated/server.ts";

export const sendReceipt = job({
  args: { orderId: v.bigint() },
  concurrency: 4,
  retry: { attempts: 5, backoff: "exponential" },
  handler: async (ctx, args) => {
    const order = await ctx.tx((tx) => tx.db.orders.get(args.orderId));
    if (!order.ok || order.data === null) return null;
    await deliverReceipt(order.data); // external work is allowed here
    return { deliveredAt: ctx.timestamp };
  },
});
```

### Execution modes

Each Job definition declares its execution mode; `"procedure"` is the default.

- **procedure-mode** — the handler may do external work and open explicit
  `ctx.tx(...)` transactions, exactly like a procedure, under the system
  principal with `ctx.runNumber` and an `abortSignal` that fires on cancel and
  shutdown. The envelope is claim → run → settle: the claim transaction creates
  the run under a lease, and the settle transaction re-validates the run and its
  lease before recording the outcome. Under retries this is at-least-once;
  idempotency is the handler's contract.
- **mutation-mode** (`mode: "mutation"`) — the handler is one writer
  transaction: claim, handler, and settle commit atomically, exactly-once. No
  external I/O. A failed handler rolls back whole — no partial write survives —
  and the failed run is recorded in the same transaction.

## Enqueue, await, transitions

`ctx.jobs` mirrors job addresses with the powers of the surrounding context:

| Context | Surface |
| --- | --- |
| queries | `query()` — the reactive builder over `_ackerdb_jobs`, scoped to the definition — and `runs(job)`, the builder over one Job's runs |
| mutations, transactions | `enqueue(args, opts?)`, `query()`, `runs(job)` |
| procedures, system runs, job handlers | `enqueue`, `run`, `wait`, `cancel`, `retry`, `runAgain`, `forceRunAgain`, `reschedule`, `delete` |

```ts
// In a mutation: transactional — the job exists iff this commit does.
await ctx.jobs.emails.sendReceipt.enqueue({ orderId }, { delayMs: 5_000 });

// In a procedure: enqueue and await the current run's settle.
const outcome = await ctx.jobs.emails.sendReceipt.run({ orderId });
if (!outcome.ok && outcome.nextRetryAt !== null) {
  // the job will retry; decide whether to keep waiting
  const next = await ctx.jobs.emails.sendReceipt.wait(handle);
}
```

Awaiting is deliberately absent from mutation contexts: a mutation holds the
serialized writer and cannot wait on work behind it. `run` and `wait` resolve
at the **current run's** settle — a failed run reports
`{ ok: false, state, error, nextRetryAt }`, where `nextRetryAt` is null when
the Job will not run again. Two awaiters of one Job observe one settle. Enqueue
options are `{ at }` or `{ delayMs }`.

Transitions are the sanctioned state-machine verbs, and they are the only way a
Job or its runs move:

| Verb | What it does |
| --- | --- |
| `cancel` | Settles a non-terminal Job. Before the claim it creates no run; while running it settles the current run as canceled and aborts the handler cooperatively (its late result is discarded on the stale lease). Ending one occurrence of a repeating job does not end the recurrence — the next occurrence is still minted. |
| `retry` | **Manual retry** — gives a *Failed* Job another run under the same identity, keeping its history and step journal. |
| `runAgain` | **Run again** — submits a terminal Job's arguments through ordinary enqueue. Dedupe may resolve it to the existing Job and its recorded outcome without executing anything. |
| `forceRunAgain` | **Force run again** — gives a terminal Job another run under the same identity, so the new outcome is the one future dedupe hits receive. It clears the step journal, because replaying a completed journal would do no work at all. |
| `reschedule` | Moves the next run's due time on a Job that has one. |
| `delete` | Removes the Job and every run it owns. The one destructive door. |

## Retry and recurrence

Both are one concept: *the next run time, or null to stop*, consulted at
settle.

```ts
retry: (runNumber, error) => runNumber < 5 && isTransient(error) ? runNumber * 1_000 : null,
repeat: { cron: "0 12 * * *", tz: "America/Sao_Paulo" },
```

- `retry(runNumber, error)` returns the delay in milliseconds before the next
  run, or null to fail the Job. `{ attempts, backoff: "exponential" | "fixed",
  delayMs }` is sugar. The default is **no retries**: the first failed run
  fails the Job. Between runs the Job is *retrying* — non-terminal, with its
  next run durably scheduled.
- `repeat(lastScheduledAt, now)` returns the next occurrence's timestamp, or
  null to end the recurrence. `{ cron, tz }` (five-field cron, IANA timezone)
  and `{ everyMs }` are sugar. The framework mints the next occurrence at
  settle **regardless of the run's outcome**, as a fresh Job linked to the one
  that settled — a handler bug cannot kill a recurrence. It is computed from
  the Job's admitted occurrence, not from its last retry, so retries never drag
  a schedule forward. Occurrences are materialized as durable Jobs, so a missed
  occurrence (server down at the moment) runs once, late, at startup; the sugar
  coalesces longer outages to one occurrence. A repeating job with no args
  mints its first occurrence at startup.

## Durable steps

Steps give a procedure-mode Job memory across runs (ADR-0022). Each completed
step's identity and result are recorded in the Job's step journal — the journal
belongs to the Job because it outlives one run; a resumed run replays the
handler, recorded steps answer instead of executing, and the first unrecorded
step executes. Using `ctx.step` is the
opt-in — a handler with no steps is untouched, and mutation-mode Jobs exclude
it by construction: their single writer transaction *is* one atomic step.

```ts
export const renewSubscription = job({
  args: { subscriptionId: v.bigint() },
  retry: { attempts: 5, backoff: "exponential" },
  handler: async (ctx, args) => {
    const sub = await ctx.step.run(api.subscriptions.get, { id: args.subscriptionId });
    if (!sub.ok || sub.data === null) return null;

    // A registered procedure as a step — reused by the dunning flow too.
    const payment = await ctx.step.run(api.billing.payInvoice, { invoiceId: sub.data.invoiceId });
    if (!payment.ok) return { failed: payment.error };

    await ctx.step.sleep("settlement-window", 60_000);

    // Inline steps capture scope instead of taking args; the name is the identity.
    const receipt = await ctx.step.procedure("send-receipt", async () =>
      await email.send(sub.data.email, renderReceipt(payment.data)));
    await ctx.step.mutation("record", async (tx) => {
      await tx.db.subscriptions.patch(args.subscriptionId, { renewedAt: ctx.timestamp });
    });
    return { receiptId: receipt.id };
  },
});
```

- `step.run(ref, args, { name? })` invokes a registered query, mutation, or
  procedure from the generated `api` tree and records its typed Result. Jobs
  execute as the system principal, but the callee still enforces its own
  `access` and scope requirements. Kind comes from the reference; the journal
  identity defaults to the callee's address (`name` disambiguates two calls to
  one ref). A query or mutation callee commits atomically with its journal
  entry in one writer transaction — exactly-once; a procedure callee is
  at-least-once, journaled on completion. A returned `Err` is a recorded value
  handed back to the handler; only a throw fails the run.
- `step.query(name, fn)` / `step.mutation(name, fn)` / `step.procedure(name, fn)`
  are inline steps: the closure's return value is the journaled result and
  must be wire-representable. Inline mutations get the same atomic
  journal-plus-writes commit.
- `step.sleep(name, durationMs)` suspends in **one writer transaction**:
  journal entry, pending Job, wake time, and lease release commit together, and
  the run itself **stays open** — the claim that wakes it resumes the same run
  rather than opening another, so sleeping is not failing, the retry budget
  stays untouched, and no crash window exists between "recorded" and
  "suspended". Awaiters resolve with `{ ok: false, state: "pending",
  nextRetryAt }` at the suspend. The thrown signal only unwinds the handler;
  code that catches it is a stale run with cancel's semantics — transactional
  steps refuse outright, a procedure closure may still run but can never
  record, and the late settle is discarded. On replay a recorded sleep is
  satisfied by being claimed at all: the Job's due time is the single
  authority, so `reschedule` genuinely moves the wake in either direction.

**The name is a contract: same name, same meaning.** Renaming a step means
"run it again for in-flight runs" — safe only for idempotent steps. A
breaking change versions the job, not the step: declare the new shape as a
new definition beside the old one, drain old runs (observable through the
reactive rows), then delete the old definition. Step refusals settle the run
as failed with a typed error and **without consulting the retry policy** —
retrying into unchanged code cannot fix code: a duplicate name in one run, a
kind change under a name, a changed args hash under a `step.run` name, an
unreadable journal (fail closed — the bytes stay on the row as evidence,
never replayed as if empty), and a journal past its finite bounds (1,000
steps / 1 MiB — record smaller results or use child jobs). The args-hash
check doubles as the determinism tripwire: replayed args derive entirely
from journaled state, so a difference proves code drift or nondeterminism
outside steps. A non-empty journal also binds the row to its original
arguments: patching `argsJson` refuses, because old step results under new
args would be a run that never existed — delete the Job and enqueue fresh.

The `retry` verb **resumes** from the journal — that is its only meaning.
`forceRunAgain` is the opposite: it clears the journal, because forcing a
completed Job to run again against its own recorded results would execute
nothing. A poisoned journal's remedy is deleting the Job and enqueueing fresh;
the journal lives and dies with its Job, through deletion and retention alike.
In a step-using handler, everything effectful belongs inside a step — including
child-job enqueues, which wrapped in a `step.mutation` commit transactionally
with their journal entry.

## Deduplication and memoization

Dedupe is opt-in and keyed on the canonical encoding of the validated args.

```ts
dedupe: "inflight"                            // collapse while the Job is live
dedupe: { completed: 60_000 }                 // ...and memoize success for a minute
dedupe: { completed: "forever" }              // compute exactly once per input, ever
dedupe: { completed: 3_600_000, failed: 0 }   // failures never block a fresh call
```

While a Job for the same (job, args) is live — pending, running, or retrying —
enqueue resolves to it: two calls, one execution, one outcome for every
awaiter. A `completed` or `failed` window extends this past settle: calls
inside the window return the outcome recorded on the Job's latest run without
executing anything. **A dedupe hit stores nothing** — no Job row, no run row,
no touched timestamp, not even a primary key it then gives back — because no
handler ran. It still takes the writer turn that makes checking and inserting
one atomic step, so the engine's global commit counter advances exactly as it
would for any transaction that turns out to write nothing.
`forceRunAgain` replaces the outcome a hit receives; `delete` removes it.

## Concurrency

`concurrency` caps simultaneous runs of one definition; `1` is a lock. With a
`key`, the cap applies per `(job, key)` — one cart processes strictly
sequentially while a million carts run in parallel:

```ts
export const processCart = job({
  args: { cartId: v.bigint(), step: v.string() },
  key: (args) => args.cartId,
  concurrency: 1,
  handler: async (ctx, args) => { /* ... */ },
});
```

Keys gate *simultaneous execution* in due order. A Job waiting out a retry
backoff, or suspended in `step.sleep`, holds no slot — other Jobs of its key
run during the gap. A strict
happens-after-success chain is application logic: enqueue step B from step A's
settle, or re-validate state at the start of every handler.

The runner as a whole is bounded by the `jobs` limits: `maxRunning` handlers
across all definitions, `claimBatchSize` Jobs per wake, and `leaseMs` — how
long a claimed run owns its Job before crash recovery settles it through the
retry policy.

## The jobs tables

Both are real tables: query them, subscribe to them — a live job dashboard is
one subscription.

`_ackerdb_jobs` holds the Job: identity (`name`, `argsJson`, `argsHash`,
`key`), scheduling intent (`scheduledAt`, the admitted occurrence, and
`nextRunAt`, when the next run is due), provenance (`trigger`, `parentJobId`),
`state` (`pending | running | retrying | completed | failed | canceled`),
`runCount`, the step journal, and `deleteAfter`. Column ownership is split
exactly at the state machine:

- **Open**: `nextRunAt`, `key`, and `argsJson` may be patched (a patched
  `argsJson` recomputes the dedupe hash). Editing a running Job does not stop
  its handler; the settle self-discards on the stale lease.
- **Guarded**: everything else belongs to the runner; a CRUD write naming one
  is refused. State moves through the `ctx.jobs` transitions.
- **Inserts** go through `enqueue`, the one door that computes identity and
  dedupe; **deletes** go through `delete`, the one door that also removes the
  Job's runs. A Job deleted any other way would leave history parented to
  nothing.

`_ackerdb_job_runs` holds one row per handler execution: `jobId` and a 1-based
`number` unique within the Job, `trigger` (`initial | automatic_retry |
manual_retry | force`), `scheduledAt` / `startedAt` / `settledAt`, `state`
(`running | completed | failed | canceled`), `outputJson`, `errorCode`,
`errorText`, its lease, and `deleteAfter`. Runs are **read-only** to
applications — they are the runner's record of what actually ran.

The Job stores no pointer into its runs. `runCount` is both how many runs exist
and the latest run's `number`, so the Job's authoritative outcome is
`(id, runCount)` and the current run is that same row while the Job is running.
A reference that cannot drift out of the Job is a reference that cannot corrupt.

Retention stamps `deleteAfter` at settle: a terminal Job and the run its
outcome is read from expire together after the definition's `retention`
(default 7 days, `"forever"` to keep), extended automatically by any longer
dedupe window. Settled runs of a Job that is still alive expire on the plain
`retention`, so a long retry chain cannot grow history without bound. A Job's
latest run is never swept as history — it is the run its outcome is read from,
and it leaves with its Job. Deleting a Job deletes its runs.

The sweep is a wake reason of its own, at most once a minute: the runner arms
for the earliest `deleteAfter` exactly as it arms for the earliest due Job, so
retention is a promise an idle application keeps too. It costs nothing when
there is nothing to collect — a database with no stamps schedules no sweep —
and a sweep that fills its page comes back for the rest instead of parking.

Clients never see either table implicitly. Expose exactly what they need
through your own queries with explicit `access` — fail-closed, like every
table.

## Operations

`/status` reports `declaredJobs` and `jobsArmed`. The
runner wakes on the commits that touch the jobs tables and on a timer armed to
the next due Job — a quiet application spends nothing.

Crash behavior: runs are recovered through leases. If the process dies
mid-run, the run's lease expires and recovery settles it through the retry
policy, which schedules the next run — work is delayed, never lost.

### Databases written before the split

`0.16.0` shipped one `_ackerdb_jobs` table carrying its own attempt history.
There is no upgrade path onto the Job / Job run pair: a later change promoted
the Identity and Credential tables into the managed schema under the physical
names the internal ones already held, so the engine schema version is a floor
and a database written before it is refused at open. Start such a deployment on
a fresh database.

## Recipes

### External effects: claim → effect → settle, reconcile — don't assume

A procedure-mode Job is at-least-once under retries, so an external effect
needs two things from the handler: an idempotency key derived from the job's
identity, and recovery that *asks* the provider what happened instead of
assuming.

```ts
export const charge = job({
  args: { orderId: v.bigint() },
  key: (args) => args.orderId,
  concurrency: 1,
  retry: { attempts: 5, backoff: "exponential" },
  handler: async (ctx, args) => {
    // Re-validate on entry: the world may have changed between runs.
    const order = await ctx.tx((tx) => tx.db.orders.get(args.orderId));
    if (!order.ok || order.data?.status !== "payable") return null;

    // The idempotency key is the job identity: a crashed run that
    // already reached the provider dedupes instead of double-charging.
    const key = `job:${args.orderId}`;
    const existing = await psp.findByIdempotencyKey(key);
    const outcome = existing ?? await psp.charge(order.data.amountCents, { idempotencyKey: key });

    await ctx.tx((tx) => tx.db.orders.patch(args.orderId, {
      status: outcome.ok ? "charged" : "payable",
    }));
    return outcome;
  },
});
```

Never mark an ambiguous external outcome as failed: if the provider cannot
answer "did request X happen?", keep the Job retrying (return a delay) or
settle into a state a human reconciles — a failed charge that actually landed
is an incident.

### Fan-in: run a join step after N children finish

Transactional enqueue makes the classic counter pattern crash-proof — the
decrement and the join-enqueue commit atomically with each child's own writes:

```ts
export const processChunk = job({
  mode: "mutation",
  args: { batchId: v.bigint(), chunk: v.int() },
  handler: async (tx, args) => {
    // ...process the chunk...
    const batch = (await tx.db.batches.get(args.batchId))!;
    const remaining = batch.remaining - 1;
    await tx.db.batches.patch(args.batchId, { remaining });
    if (remaining === 0) {
      await tx.jobs.batches.merge.enqueue({ batchId: args.batchId });
    }
  },
});
```

Whichever child reaches zero enqueues the join exactly once; a crashed child
re-runs through its lease, and its decrement either committed or did not —
never half.
