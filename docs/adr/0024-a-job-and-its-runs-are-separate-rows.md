# A Job and its runs are separate rows

ADR-0018 put durable jobs in one framework-owned table, and that table
accumulated every question anyone could ask of a job: which work was admitted,
when it is due, whether a duplicate should collapse into it, what its handler
has already produced, and how each individual execution went. The last of those
lived in `attemptsJson`, a JSON array rewritten in full on every settle. One
row conflated a durable admission with unbounded execution history, so history
was O(n)-rewritten instead of appended, failures and timings could not be
paged or indexed, list payloads grew with the number of retries, and the
"cached outcome" of a completed job had no owner distinguishable from the job
itself. An operational surface over that model can only be a weaker view of
the wrong shape.

The decision: **a Job and a Job run are separate rows.** `_ackerdb_jobs` holds
one durable admission — canonical arguments, dedupe identity, scheduling
intent, state, provenance, retention. `_ackerdb_job_runs` holds one row per
actual handler execution, from claim through settlement, with its own trigger,
timings, outcome, error, and lease. **The claim is what creates a run**, which
makes the write-free dedupe hit a property of the model rather than a rule to
remember: a hit executes no handler, so there is nothing to record, and a Job
still waiting for its due time has no invented run.

The Job stores no pointer into its runs. `runCount` is both how many runs
exist and the latest run's `number`, so the Job's authoritative outcome is
`(id, runCount)` and the current run is that same row while the Job is running.
The alternative — `currentRunId` / `latestRunId` / `memoizedRunId` columns —
buys nothing a `(jobId, number)` unique index does not already give, and each
one is an invariant that can point at a run of another Job. Memoization is
derived the same way: a dedupe hit resolves to the newest terminal Job of an
identity whose settle is still inside the definition's window, and reads the
outcome from that Job's latest run. Force run again therefore needs no cache
subsystem to invalidate — it adds a run under the same identity, and the newest
outcome is the one the next hit receives.

Retention becomes a stamp instead of a sweep. A settle writes `deleteAfter` on
the Job and on the run, taking the longer of the definition's `retention` and
the dedupe window for that outcome, so the run an outcome is read from can
never expire before the Job that points at it. Reaping is then one indexed
range scan per table rather than a scan per (definition, state) pair, and a
settled run of a Job that is *still alive* expires on the plain retention —
which is what bounds the run history of a Job with a long retry chain. A
`"forever"` retention is exactly what it says: no automatic deletion and no
hidden run-count cap.

The break is real: `0.16.0` shipped the old shape with real data. It is
transformed, one way, rather than dropped — ADR-0018 promises that an admitted
job is durable, and a major version may not quietly withdraw that. The
transform is a **framework migration**: the application's chain answers
refusals on tables the application declares, and nobody can write a migration
file for `_ackerdb_jobs`, so the framework ships the transform with the code
that changed the shape. Its applied-ness is structural, not recorded — it
declares the stored shape it reads and therefore runs exactly while that shape
is on disk — which is the same rule ADR-0003 already builds everything else on,
that structure is the single truth. It runs through the ordinary migration
apply, so it gets the same one-transaction-per-step, PRE-typed decode, target-
typed validation, and byte-identical rollback; and it runs *after* the
application's chain, so a migration generated against an older framework still
meets the framework tables as they were when it was generated.

## Considered options

- **Keep one table, page `attemptsJson`**: rejected — the rewrite is O(history)
  per settle regardless of how the JSON is read, and no index can reach inside
  it.
- **A run row plus explicit pointer columns on the Job**: rejected — three
  columns that duplicate `runCount` and a unique index, each maintained by hand
  at every transition, each able to reference a run the Job does not own.
- **Drop `_ackerdb_jobs` on upgrade**: rejected — it withdraws ADR-0018's
  durability promise inside a major version, for no benefit beyond skipping a
  transform that already has an engine.
- **Dual-write both shapes through a deprecation window**: rejected — two
  writers for one state machine is the ambiguity the split exists to remove,
  and a shim would outlive its window.

## Consequences

- One extra row per handler execution, plus its indexes, and one additional
  insert at claim. Dedupe hits stay free; list payloads stop growing with
  retries; failures, timings, and run history become directly pageable.
- The Job's vocabulary follows the domain: `discarded` becomes `failed`, a Job
  between runs is `retrying`, and `ctx.attempt` becomes `ctx.runNumber`. The
  dedupe window keyed on failure is `failed` rather than `discarded`.
- `step.sleep` keeps its run open and unleased rather than settling it: the
  claim that wakes a suspended Job resumes the same run, which is what keeps
  sleeping out of the retry budget now that the budget *is* the run number.
- Deleting a Job is a transition rather than ordinary CRUD, because a Job
  removed any other way would leave run history parented to nothing; runs are
  read-only to applications for the same reason.
- Rows migrated from the old shape carry no retention stamp and are retained
  until deleted. Retention belongs to a Job definition, and definitions are not
  loaded while schema work runs — guessing a window could delete an outcome a
  `"forever"` dedupe promised.
- Framework migrations are now a mechanism the framework owns. The next change
  to a framework-owned table adds a link to the same list, and the entry before
  it freezes the shape it actually targeted.
