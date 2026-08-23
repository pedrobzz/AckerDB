/**
 * The framework-owned jobs tables. `_ackerdb_jobs` holds one **Job** — a
 * durable admission of a Job definition with canonical arguments, scheduling
 * intent, and dedupe identity — and `_ackerdb_job_runs` holds every **Job
 * run**: one actual handler execution, from claim through settlement. A dedupe
 * hit produces no run, because no handler executes.
 *
 * Both live inside the logical schema — planned, reactive, and queryable like
 * any application table — but are injected by the Engine, not declared by the
 * application, so their names can never collide (application table names must
 * start with a letter).
 *
 * Column ownership is split once, here: the runner owns the state machine
 * (guarded columns); the application owns scheduling intent (open columns) and
 * may delete a Job, which deletes its runs with it. Inserts go through
 * `ctx.jobs.enqueue`, the one door that computes identity and dedupe. Runs are
 * read-only to applications: they are the runner's record of what actually ran.
 *
 * The Job stores no pointer into its runs. `runCount` is both how many runs
 * exist and the latest run's `number`, so the latest run is `(id, runCount)`
 * and the current run is that same row while the Job is running — a reference
 * that cannot drift out of the Job, and the one authoritative outcome the Job
 * never duplicates.
 */
import { v } from "../validation/v.ts";
import { Schema, TableDef } from "../schema/definition.ts";

export const JOBS_TABLE = "_ackerdb_jobs";
export const JOB_RUNS_TABLE = "_ackerdb_job_runs";

/** Columns only the runner writes; a CRUD patch naming one is refused. */
export const JOBS_GUARDED_COLUMNS: ReadonlySet<string> = new Set([
  "name",
  "state",
  "argsHash",
  "trigger",
  "parentJobId",
  "scheduledAt",
  "runCount",
  "nextRunTrigger",
  "stepsJson",
  "enqueuedAt",
  "settledAt",
  "deleteAfter",
]);

export function buildJobsTable(): TableDef {
  return new TableDef({
    id: v.primaryKey(),
    /** Declared job name: module path + export, `emails.sendReceipt`. */
    name: v.string(),
    /** Canonical-encoded args, the Job's exact input. */
    argsJson: v.string(),
    /** Hash of the canonical args encoding: the dedupe identity. */
    argsHash: v.string(),
    /** Partition key derived from args, or null for global concurrency. */
    key: v.string().nullable(),
    /** pending | running | retrying | completed | failed | canceled */
    state: v.string(),
    /** What admitted this Job: enqueue | repeat | run_again. */
    trigger: v.string(),
    /** The terminal Job a repeat policy minted this one from, if any. */
    parentJobId: v.bigint().nullable(),
    /** The due time this Job was admitted for; it never moves, so a repeat policy cannot drift behind retries. */
    scheduledAt: v.float(),
    /**
     * When the next run is due; it keeps its last value once the Job settles.
     * This is the claim scan's ordering, so it is the schedule column: it
     * carries the Engine's automatic due index and the commit-wake that arms
     * the runner.
     */
    nextRunAt: v.scheduleAt(),
    /** Runs created so far; also the latest run's `number`. */
    runCount: v.int(),
    /**
     * The trigger an administrator asked the next run to carry:
     * manual_retry | force. Null is the ordinary derivation — `initial` for the
     * first run, `automatic_retry` for a retry, and a resume of the suspended
     * latest run when a pending Job already has runs behind it.
     */
    nextRunTrigger: v.string().nullable(),
    /**
     * The step journal holds completed steps' identities and recorded results,
     * replayed on resume so a run re-executes only unrecorded work. It belongs
     * to the Job because it outlives one run — a retry resumes it, and only a
     * force run again clears it. Null reads as an empty journal.
     */
    stepsJson: v.string().nullable(),
    enqueuedAt: v.float(),
    settledAt: v.float().nullable(),
    /** When retention lets this Job and its runs be deleted; null is forever. */
    deleteAfter: v.float().nullable(),
  }, "table")
    // Identity first: its two-column prefix answers the live-Job lookup, and
    // the full key turns "the newest settled Job of this identity in this
    // state" into a seek. A `"forever"` dedupe keeps every Job of an identity,
    // so that read must not sort a history that only grows.
    .index(["name", "argsHash", "state", "settledAt"])
    .index(["state", "nextRunAt"])
    .index(["deleteAfter"]) as TableDef;
}

export function buildJobRunsTable(): TableDef {
  return new TableDef({
    id: v.primaryKey(),
    /** The Job this run belongs to. */
    jobId: v.bigint(),
    /** 1-based position within the Job; `(jobId, number)` is unique. */
    number: v.int(),
    /** Why this run exists: initial | automatic_retry | manual_retry | force. */
    trigger: v.string(),
    /** The Job due time this run was claimed for. */
    scheduledAt: v.float(),
    /** When the claim happened; a run resumed from `step.sleep` keeps its first claim. */
    startedAt: v.float(),
    settledAt: v.float().nullable(),
    /** running | completed | failed | canceled — a terminal run is immutable. */
    state: v.string(),
    /** Canonical-encoded successful output: the Job's authoritative result. */
    outputJson: v.string().nullable(),
    /** The failure's public outcome code. */
    errorCode: v.string().nullable(),
    /** The failure, described and truncated for storage. */
    errorText: v.string().nullable(),
    /** Owner token of this run; a settle with a stale token discards itself. */
    leaseToken: v.string().nullable(),
    /** Lease deadline; an expired lease is a crashed run to recover. */
    leaseUntil: v.float().nullable(),
    /**
     * When retention lets this run be deleted; null is forever. A terminal
     * Job's latest run carries the Job's own stamp, so the run an outcome is
     * read from can never expire before the Job that owns it.
     */
    deleteAfter: v.float().nullable(),
  }, "table")
    .index(["jobId", "number"], { unique: true })
    .index(["state", "leaseUntil"])
    .index(["deleteAfter"]) as TableDef;
}

/**
 * The Jobs tables, as one framework schema contribution. Adding them to a
 * database that has neither is an additive, shape-safe change reconciliation
 * applies on upgrade.
 */
export function jobsSchema(): Schema {
  return new Schema(
    {
      [JOBS_TABLE]: buildJobsTable(),
      [JOB_RUNS_TABLE]: buildJobRunsTable(),
    },
    new Map(),
  );
}
