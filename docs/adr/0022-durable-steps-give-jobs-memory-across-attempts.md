# Durable steps give jobs memory across attempts

A job attempt is all-or-nothing: a retry re-runs the handler from the top.
That is the right contract for one unit of work and the wrong one for a
multi-step flow — charge the card, record the order, send the receipt — where
a crash after the second step must not repeat the first two. The industry
calls the missing piece durable execution, and ships it as a separate
workflow system: Convex's workflow component journals steps and fails on any
code drift; Inngest memoizes by step name and tolerates drift silently;
Vercel pins every run to the immutable deployment that started it; Temporal
versions handlers explicitly. A separate system is the part we refuse:
everything a workflow runtime needs — durable run identity, retries, leases,
crash recovery, cancellation, scheduling, per-key concurrency, dedup,
transactional starts, reactive observability — is already the `_ackerdb_jobs`
row and its state machine. A parallel workflow entity would rebuild all of
it and then drift from it.

The decision: jobs gain a step journal, and "workflow" never becomes a
runtime noun. `ctx.step` exists on procedure-kind job handlers — using it is
the opt-in; a handler with no steps is untouched, and mutation-kind jobs
exclude it by construction, since their single writer transaction would roll
journal writes back with everything else (a mutation-kind job *is* one
atomic step). Steps are journal entries, not child job rows; child jobs
remain the tool for parallel fan-out with independent policies.

`step.run(ref, args)` is the journaled variant of the server-side
composition that already exists — including registered procedures, which
function-results already defines as directly callable nested invocations
from procedure-shaped contexts; a job handler is one. Mutation steps commit
their journal entry atomically with their writes in the single writer —
exactly-once, the same collapse the claim/settle path already uses. Inline
`step.query`/`step.mutation`/`step.procedure` take a required name and a
closure; the verb states the kind exactly when no reference carries it.
Journaled results must be wire-representable, and a returned `Err` is a
recorded value, not a failure — only throws fail the attempt.

Step identity is the name, and the name is a contract: same name, same
meaning. Renaming a step means "run it again for in-flight runs" — safe only
for idempotent steps; breaking changes version the workflow (a `v2`
definition beside the old one, drained observably through the reactive job
rows), never the step. Strictness is applied exactly where it is free of
false positives: a duplicate name in one run, a kind change under a name, or
a changed args hash under a `step.run` name settles the run as discarded
with a typed mismatch error — the retry policy is never consulted, because
retrying into unchanged code cannot fix code — and the args-hash check
doubles as the determinism tripwire, since replayed args derive entirely
from journaled state and can differ only through drift or nondeterminism.

Resume is the only meaning of retry. The operator verb replays the journal;
a poisoned journal's remedy is deleting the row and enqueueing fresh through
the doors that already exist. `step.sleep(name, ms)` settles the attempt
back to pending with a future due time and no attempt increment — sleeping
is not failing — reusing the runner's scheduling machinery whole. Retry
policy stays job-level only: with a journal, retrying the attempt re-executes
exactly the failed step, and per-step backoff shaping is one conditional in
the policy callback the author already has. Everything effectful in a
step-using handler belongs inside a step — a documentation rule, not runtime
enforcement, until evidence shows the footgun firing. Waiting on external
events is deferred: it needs a parked-until-signaled row state and a wake
verb, and deserves a concrete use case before it is designed.
