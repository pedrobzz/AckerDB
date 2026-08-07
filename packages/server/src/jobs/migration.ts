/**
 * The one-way transform from the single pre-split `_ackerdb_jobs` table to the
 * Job / Job run pair. `0.16.0` shipped the old shape with real data, and
 * ADR-0018 promises that an admitted job is durable — so the table is not
 * dropped on upgrade, it is *transformed*: every Job survives with its identity,
 * scheduling intent, journal, and lease, and every recorded attempt becomes the
 * Job run it always was. Nothing dual-writes and nothing reads the old shape
 * afterwards; the old shape simply ceases to exist.
 *
 * The reconstruction, column by column:
 *
 * - `attemptsJson` is the run history. Attempt `i` becomes run number `i`, with
 *   its recorded start, settle, outcome, and error text. The old model recorded
 *   no provenance for a re-run, so every run after the first reads as an
 *   automatic retry — the honest default, since that is what the old
 *   `attemptsJson` could not distinguish.
 * - `attempt` (started attempts) is the authority on how many runs existed, so
 *   an unreadable or short history still yields that many runs and the Job's
 *   retry budget survives the migration exactly.
 * - A `running` Job keeps its lease on its in-flight run, so ordinary lease
 *   recovery finishes the crashed run through the retry policy instead of
 *   silently restarting it.
 * - `outputJson` moves onto the run that produced it — the completed Job's
 *   latest run — which is where dedupe and awaiting read it from now on.
 * - `deleteAfter` is deliberately left null (retained until deleted). Retention
 *   belongs to the Job definition, and definitions are not loaded when schema
 *   work runs; guessing a window could delete an outcome a `"forever"` dedupe
 *   promised. Every Job the runner settles from here on is stamped.
 */
import type { SchemaSnapshot } from "../schema/snapshot.ts";
import { defineMigration, type MigrationRow } from "../schema/migrations/types.ts";
import type { FrameworkMigration } from "../schema/migrations/framework.ts";
import {
  buildJobRunsTable,
  buildJobsTable,
  JOB_RUNS_TABLE,
  JOBS_TABLE,
} from "./table.ts";

/** One entry of the old `attemptsJson` array. */
interface StoredAttempt {
  readonly startedAt: number;
  readonly settledAt: number;
  readonly outcome: string;
  readonly error: string | null;
}

const RUN_STATE_OF_OUTCOME: Record<string, string> = {
  completed: "completed",
  canceled: "canceled",
  failed: "failed",
  discarded: "failed",
};

const JOB_STATE_OF_OLD_STATE: Record<string, string> = {
  pending: "pending",
  running: "running",
  completed: "completed",
  discarded: "failed",
  canceled: "canceled",
};

/**
 * The recorded attempts, position preserved. A malformed entry becomes a hole
 * rather than disappearing: attempt `i` is run `i`, and compacting the array
 * would renumber every attempt behind the damaged one — including the last,
 * which is where a completed Job's output belongs.
 *
 * Every field is validated, not just the ones the reconstruction reads. An
 * entry whose `error` is an object would otherwise reach the new table's
 * validator and roll the whole migration back — one damaged row taking a
 * database's entire startup with it.
 */
function readAttempts(value: unknown): (StoredAttempt | undefined)[] {
  if (typeof value !== "string") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.map((raw) => {
    if (typeof raw !== "object" || raw === null) return undefined;
    const entry = raw as Record<string, unknown>;
    const readable =
      Number.isFinite(entry["startedAt"]) &&
      Number.isFinite(entry["settledAt"]) &&
      typeof entry["outcome"] === "string" &&
      (entry["error"] === null ||
        entry["error"] === undefined ||
        typeof entry["error"] === "string");
    return readable ? (raw as StoredAttempt) : undefined;
  });
}

const finite = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/**
 * True while `stored` still describes the pre-split table: `attemptsJson` is the
 * column the split deletes, and no other shape of `_ackerdb_jobs` has ever had
 * it. Applied-ness is structural — the transform runs exactly while the old
 * shape is on disk, and never again once it is not.
 */
function appliesToStoredSnapshot(stored: SchemaSnapshot): boolean {
  const jobs = stored.tables[JOBS_TABLE];
  return jobs?.kind === "table" && Object.hasOwn(jobs.columns, "attemptsJson");
}

export const SPLIT_JOBS_INTO_RUNS: FrameworkMigration = {
  name: "split_jobs_into_runs",
  applies: appliesToStoredSnapshot,
  produces: { [JOBS_TABLE]: buildJobsTable(), [JOB_RUNS_TABLE]: buildJobRunsTable() },
  migration: defineMigration({
    tables: {
      [JOBS_TABLE]: (row, ctx): MigrationRow => {
        const jobId = row["id"] as bigint;
        const oldState = String(row["state"]);
        const state = JOB_STATE_OF_OLD_STATE[oldState] ?? "failed";
        const runAt = finite(row["runAt"], finite(row["enqueuedAt"], 0));
        const settled = readAttempts(row["attemptsJson"]);
        const inFlight = oldState === "running";
        const runCount = Math.max(
          finite(row["attempt"], 0),
          settled.length + (inFlight ? 1 : 0),
        );

        for (let position = 1; position <= runCount; position++) {
          // The last run of a Job that was running is the one that crashed: it
          // keeps its lease, so ordinary recovery settles it through the retry
          // policy exactly as it would have before the split.
          const open = position === runCount && inFlight;
          const attempt = open ? undefined : settled[position - 1];
          const startedAt = open ? runAt : finite(attempt?.startedAt, runAt);
          const lost = !open && attempt === undefined;
          // The Job's own state is the authority on how it ended, so the last
          // run of a terminal Job takes its outcome from the Job when its own
          // record is unreadable. Otherwise a completed Job could end up
          // pointing at a failed run with no output — a success that answers
          // `undefined`.
          const inherits = lost && position === runCount && state !== "pending";
          const outcome = inherits
            ? state === "retrying" ? "failed" : state
            : RUN_STATE_OF_OUTCOME[attempt?.outcome ?? ""] ?? "failed";
          ctx.insert(JOB_RUNS_TABLE, {
            jobId,
            number: position,
            trigger: position === 1 ? "initial" : "automatic_retry",
            scheduledAt: startedAt,
            startedAt,
            settledAt: open ? null : finite(attempt?.settledAt, startedAt),
            state: open ? "running" : outcome,
            // The Job's recorded output belongs to the run that produced it.
            outputJson: outcome === "completed" && position === runCount
              ? row["outputJson"] ?? null
              : null,
            errorCode: null,
            errorText: lost
              ? "attempt history was unreadable when the jobs table was split"
              : attempt?.error ?? null,
            leaseToken: open ? row["leaseToken"] ?? null : null,
            leaseUntil: open ? row["leaseUntil"] ?? null : null,
            deleteAfter: null,
          });
        }

        return {
          name: row["name"],
          argsJson: row["argsJson"],
          argsHash: row["argsHash"],
          key: row["key"] ?? null,
          // A pending Job with runs behind it was waiting out a retry backoff:
          // that is exactly a Retrying Job.
          state: state === "pending" && runCount > 0 ? "retrying" : state,
          trigger: "enqueue",
          parentJobId: null,
          // The old row overwrote its due time on every retry, so the admitted
          // occurrence survives only on the first run; a Job that never ran
          // still carries it in `runAt`.
          scheduledAt: finite(settled[0]?.startedAt, runAt),
          nextRunAt: runAt,
          runCount,
          nextRunTrigger: null,
          stepsJson: row["stepsJson"] ?? null,
          enqueuedAt: finite(row["enqueuedAt"], runAt),
          settledAt: row["settledAt"] ?? null,
          deleteAfter: null,
        };
      },
    },
  }),
};
