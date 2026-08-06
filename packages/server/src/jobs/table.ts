/**
 * The framework-owned jobs table. `_ackerdb_jobs` lives inside the logical
 * schema — planned, reactive, and queryable like any application table — but
 * is injected by the Engine, not declared by the application, so its name can
 * never collide (application table names must start with a letter).
 *
 * Column ownership is split once, here: the runner owns the state machine
 * (guarded columns); the application owns scheduling intent (open columns) and
 * may delete rows. Inserts go through `ctx.jobs.enqueue`, the one door that
 * computes identity and dedup.
 */
import { v } from "../validation/v.ts";
import { Schema, TableDef } from "../schema/definition.ts";

export const JOBS_TABLE = "_ackerdb_jobs";

/** Columns only the runner writes; a CRUD patch naming one is refused. */
export const JOBS_GUARDED_COLUMNS: ReadonlySet<string> = new Set([
  "name",
  "state",
  "argsHash",
  "attempt",
  "attemptsJson",
  "stepsJson",
  "outputJson",
  "leaseToken",
  "leaseUntil",
  "enqueuedAt",
  "settledAt",
]);

export function buildJobsTable(): TableDef {
  return new TableDef({
    id: v.primaryKey(),
    /** Declared job name: module path + export, `emails.sendReceipt`. */
    name: v.string(),
    /** Canonical-encoded args, the run's exact input. */
    argsJson: v.string(),
    /** Hash of the canonical args encoding: the dedup identity. */
    argsHash: v.string(),
    /** Partition key derived from args, or null for global concurrency. */
    key: v.string().nullable(),
    /** pending | running | completed | discarded | canceled */
    state: v.string(),
    /** When a pending row is due; keeps its last value outside pending. */
    runAt: v.scheduleAt(),
    /** 1-based count of started attempts. */
    attempt: v.int(),
    /** JSON attempt history: startedAt, settledAt, outcome, error, durationMs. */
    attemptsJson: v.string(),
    /**
     * The step journal (ADR-0022): completed steps' identities and recorded
     * results, replayed on resume so an attempt re-runs only unrecorded work.
     * Nullable so adding it to an existing database stays shape-safe; null
     * reads as an empty journal. It lives and dies with its row.
     */
    stepsJson: v.string().nullable(),
    /** Canonical-encoded settle outcome, kept for dedup-window reads. */
    outputJson: v.string().nullable(),
    /** Owner token of the running attempt; a settle with a stale token discards itself. */
    leaseToken: v.string().nullable(),
    /** Lease deadline; an expired lease is a crashed attempt to recover. */
    leaseUntil: v.float().nullable(),
    enqueuedAt: v.float(),
    settledAt: v.float().nullable(),
  }, "table")
    .index(["name", "argsHash"])
    .index(["state", "runAt"])
    .index(["state", "settledAt"]) as TableDef;
}

/**
 * The jobs facet consumed by `withFrameworkTables`, the sole root-schema
 * composition point. Adding it to an existing database is an additive,
 * shape-safe change that reconciliation applies on upgrade.
 */
export function withJobsTable(schema: Schema): Schema {
  if (Object.hasOwn(schema.tables, JOBS_TABLE)) return schema;
  return new Schema(
    { ...schema.tables, [JOBS_TABLE]: buildJobsTable() },
    new Map(schema.namedTypes),
  );
}
