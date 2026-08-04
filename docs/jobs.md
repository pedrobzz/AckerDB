# Durable jobs

A Job is durable background work an application enqueues from its own
functions and AckerDB executes, retries, repeats, and retains. Every job is a
row in the framework-owned `_ackerdb_jobs` table, which lives inside the
logical schema: enqueues are transactional with the mutation that caused them,
state survives restarts, and job rows are reactive and queryable like any
application table.

Jobs supersede scheduled tables (ADR-0018). A Job is not a Service: a Service
is a long-lived external resource with its own lifecycle (ADR-0016); a Job is
one unit of work with an envelope and a policy. No client can address a job —
clients observe job state only through functions the application authors.

## Declare a job

Jobs live in `jobs/` beside `functions/` and `services/`, named the same way:
`jobs/emails.ts` exporting `sendReceipt` is the job `emails.sendReceipt`.
Configure a different directory with `jobs` in `.ackerdb.config.json`.

```ts
// jobs/emails.ts
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

### Execution kinds

Each definition declares its envelope; `"procedure"` is the default.

- **procedure-kind** — the handler may do external work and open explicit
  `ctx.tx(...)` transactions, exactly like a procedure, under the system
  principal with `ctx.attempt` and an `abortSignal` that fires on cancel and
  shutdown. The envelope is claim → run → settle: a claim transaction stamps a
  lease, the settle transaction re-validates state and lease before recording
  the outcome. Under retries this is at-least-once; idempotency is the
  handler's contract.
- **mutation-kind** (`kind: "mutation"`) — the handler is one writer
  transaction: claim, handler, and settle commit atomically, exactly-once. No
  external I/O. A failed handler rolls back whole — no partial write survives —
  and the failed attempt is then recorded in a fresh transaction.

## Enqueue, await, transitions

`ctx.jobs` mirrors job addresses with the powers of the surrounding context:

| Context | Surface |
| --- | --- |
| queries | `query()` — the reactive builder over `_ackerdb_jobs`, scoped to the definition |
| mutations, transactions | `enqueue(args, opts?)`, `query()` |
| procedures, system runs, services, job handlers | `enqueue`, `run`, `wait`, `cancel`, `retry`, `reschedule` |

```ts
// In a mutation: transactional — the job exists iff this commit does.
await ctx.jobs.emails.sendReceipt.enqueue({ orderId }, { delayMs: 5_000 });

// In a procedure: enqueue and await the current attempt's settle.
const outcome = await ctx.jobs.emails.sendReceipt.run({ orderId });
if (!outcome.ok && outcome.nextRetryAt !== null) {
  // the job will retry; decide whether to keep waiting
  const next = await ctx.jobs.emails.sendReceipt.wait(handle);
}
```

Awaiting is deliberately absent from mutation contexts: a mutation holds the
serialized writer and cannot wait on work behind it. `run` and `wait` resolve
at the **current attempt's** settle — a failed attempt reports
`{ ok: false, state, error, nextRetryAt }`, where `nextRetryAt` is null when
the job will not retry. Two awaiters of one row observe one settle. Enqueue
options are `{ at }` or `{ delayMs }`.

Transitions are the sanctioned state-machine verbs: `cancel` settles a pending
row immediately and aborts a running handler cooperatively (its late result is
discarded on the stale lease); `retry` re-runs a settled row now, keeping its
identity and attempt history; `reschedule` moves a pending row's due time.

## Retry and recurrence

Both are one concept: *the next run time, or null to stop*, consulted at
settle.

```ts
retry: (attempt, error) => attempt < 5 && isTransient(error) ? attempt * 1_000 : null,
repeat: { cron: "0 12 * * *", tz: "America/Sao_Paulo" },
```

- `retry(attempt, error)` returns the delay in milliseconds before the next
  attempt, or null to discard. `{ attempts, backoff: "exponential" | "fixed",
  delayMs }` is sugar. The default is **no retries**: the first failed attempt
  discards the job.
- `repeat(lastScheduledAt, now)` returns the next occurrence's timestamp, or
  null to end the recurrence. `{ cron, tz }` (five-field cron, IANA timezone)
  and `{ everyMs }` are sugar. The framework mints the next occurrence at
  settle **regardless of the run's outcome**, as a fresh row — a handler bug
  cannot kill a recurrence. Occurrences are materialized as durable rows, so a
  missed occurrence (server down at the moment) runs once, late, at startup;
  the sugar coalesces longer outages to one occurrence. A repeating job with
  no args mints its first occurrence at startup.

## Deduplication and memoization

Dedup is opt-in and keyed on the canonical encoding of the validated args.

```ts
dedupe: "inflight"                      // collapse while pending or running
dedupe: { completed: 60_000 }           // ...and memoize success for a minute
dedupe: { completed: "forever" }        // compute exactly once per input, ever
dedupe: { completed: 3_600_000, discarded: 0 }  // failures never block a fresh call
```

While a row for the same (job, args) is pending or running, enqueue resolves
to it — two calls, one execution, one outcome for every awaiter. A `completed`
or `discarded` window extends this past settle: calls inside the window return
the recorded outcome without running. Deleting the row (ordinary CRUD) clears
the memo.

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

Keys gate *simultaneous execution* in due order. A job waiting out a retry
backoff holds no slot — other jobs of its key run during the gap. A strict
happens-after-success chain is application logic: enqueue step B from step A's
settle, or re-validate state at the start of every handler.

The runner as a whole is bounded by the `jobs` limits: `maxRunning` handlers
across all definitions, `claimBatchSize` rows per wake, and `leaseMs` — how
long a claimed attempt owns its row before crash recovery re-runs it through
the retry policy.

## The jobs table

`_ackerdb_jobs` is a real table: query it, subscribe to it, patch and delete
rows through any server function — a live job dashboard is one subscription.
Column ownership is split exactly at the state machine:

- **Open**: `runAt`, `key`, and `argsJson` may be patched (a patched
  `argsJson` recomputes the dedup hash), and rows may be deleted. Deleting or
  editing a running row does not stop its handler; the settle self-discards on
  the stale lease.
- **Guarded**: `name`, `state`, `attempt`, `attemptsJson`, `outputJson`, the
  lease columns, and timestamps belong to the runner; a CRUD write naming one
  is refused. State moves through the `ctx.jobs` transitions.
- **Inserts** go through `enqueue`, the one door that computes identity and
  dedup.

Each row carries its full attempt history in `attemptsJson`: per attempt, the
start and settle times, outcome, truncated error, and duration. Terminal rows
are reaped after the definition's `retention` (default 7 days, `"forever"` to
keep), extended automatically by any longer dedup window.

Clients never see `_ackerdb_jobs` implicitly. Expose exactly what they need
through your own queries with explicit `access` — fail-closed, like every
table.

## Operations

Job state transitions emit telemetry events (`job_claimed`, `job_settled`,
`job_retried`, `job_discarded`, `job_canceled`) under the `job` operation, and
the runner reports `jobs.running`, `jobs.due_backlog`, and
`jobs.oldest_due_age_ms` gauges — the last is the one that catches a starved
runner; `/status` reports `declaredJobs` and `jobsArmed`. The
runner wakes on the commits that touch the jobs table and on a timer armed to
the next due row — a quiet application spends nothing.

Crash behavior: attempts are recovered through leases. If the process dies
mid-attempt, the row's lease expires and recovery re-runs it under the retry
policy — work is delayed, never lost.

## Recipes

### External effects: claim → effect → settle, reconcile — don't assume

A procedure-kind job is at-least-once under retries, so an external effect
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
    // Re-validate on entry: the world may have changed between attempts.
    const order = await ctx.tx((tx) => tx.db.orders.get(args.orderId));
    if (!order.ok || order.data?.status !== "payable") return null;

    // The idempotency key is the job identity: a crashed attempt that
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
answer "did request X happen?", keep the row retrying (return a delay) or
settle into a state a human reconciles — a discarded charge that actually
landed is an incident.

### Fan-in: run a join step after N children finish

Transactional enqueue makes the classic counter pattern crash-proof — the
decrement and the join-enqueue commit atomically with each child's own writes:

```ts
export const processChunk = job({
  kind: "mutation",
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
