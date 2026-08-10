/**
 * Planned-SQL access to `_ackerdb_jobs` and `_ackerdb_job_runs` for the runner:
 * targeted, indexed statements — never a full-table scan — with writes going
 * through the access-layer table writer so write keys, commit-wake, and
 * validation behave exactly like any table write.
 *
 * Every read here names the index it rides. The claim scan is the one that
 * cannot afford a sort: `pending` and `retrying` are both due states, so it
 * runs one keyset range per state over `(state, nextRunAt)` and merges the two
 * already-ordered streams, instead of asking SQLite to sort the union of every
 * due row on each claim.
 */
import type { Database } from "bun:sqlite";
import { makeFrameworkTableWriter, type WriteCollector } from "../../database/access.ts";
import type { Engine, TablePlan } from "../../database/engine.ts";
import { JOB_RUNS_TABLE, JOBS_TABLE } from "../../jobs/table.ts";
import type {
  JobRunState,
  JobRunTrigger,
  JobState,
  JobTrigger,
} from "../../jobs/definition.ts";

const quote = (name: string): string => `"${name}"`;

/** The states a Job can be claimed from; each is its own keyset range. */
const DUE_JOB_STATES: readonly JobState[] = ["pending", "retrying"];

export interface JobRow {
  readonly id: bigint;
  readonly name: string;
  readonly argsJson: string;
  readonly argsHash: string;
  readonly key: string | null;
  readonly state: JobState;
  readonly trigger: JobTrigger;
  readonly parentJobId: bigint | null;
  readonly scheduledAt: number;
  readonly nextRunAt: number;
  readonly runCount: number;
  readonly nextRunTrigger: JobRunTrigger | null;
  readonly stepsJson: string | null;
  readonly enqueuedAt: number;
  readonly settledAt: number | null;
  readonly deleteAfter: number | null;
}

export interface JobRunRow {
  readonly id: bigint;
  readonly jobId: bigint;
  readonly number: number;
  readonly trigger: JobRunTrigger;
  readonly scheduledAt: number;
  readonly startedAt: number;
  readonly settledAt: number | null;
  readonly state: JobRunState;
  readonly outputJson: string | null;
  readonly errorCode: string | null;
  readonly errorText: string | null;
  readonly leaseToken: string | null;
  readonly leaseUntil: number | null;
  readonly deleteAfter: number | null;
}

/** Keyset position in the claim scan's `(nextRunAt, id)` order. */
export interface JobCursor {
  readonly nextRunAt: number;
  readonly id: bigint;
}

/** One framework table's writer plus the targeted reads the runner needs. */
class TableStore<Row> {
  readonly plan: TablePlan;
  protected readonly writer: ReturnType<typeof makeFrameworkTableWriter>;

  constructor(
    protected readonly engine: Engine,
    writes: WriteCollector,
    table: string,
  ) {
    this.writer = makeFrameworkTableWriter(engine, writes, table);
    this.plan = this.writer.plan;
  }

  insert(row: Record<string, unknown>): Promise<bigint> {
    return this.writer.insert(row);
  }

  patch(id: bigint, partial: Record<string, unknown>): Promise<void> {
    return this.writer.patch(id, partial);
  }

  delete(id: bigint): Promise<void> {
    return this.writer.delete(id);
  }

  protected select(where: string, order: string, limit: number, params: unknown[]): Row[] {
    const raws = this.engine
      .statement(
        this.engine.writer,
        `SELECT ${this.plan.readProjection} FROM ${quote(this.plan.name)} WHERE ${where}${order} LIMIT ${limit}`,
      )
      .all(...(params as never[])) as Record<string, unknown>[];
    return raws.map((raw) => this.engine.rowFromSql(this.plan, raw) as unknown as Row);
  }

  byId(id: bigint): Row | null {
    return this.select(`${quote("id")} = ?`, "", 1, [id])[0] ?? null;
  }
}

/** The runner's writer-side Job store; construct one per transaction. */
export class JobsStore extends TableStore<JobRow> {
  constructor(engine: Engine, writes: WriteCollector) {
    super(engine, writes, JOBS_TABLE);
  }

  /** The live (non-terminal) Job of one identity, if any. */
  liveFor(name: string, argsHash: string): JobRow | null {
    return this.select(
      `${quote("name")} = ? AND ${quote("argsHash")} = ? AND ${quote("state")} IN ('pending', 'running', 'retrying')`,
      "",
      1,
      [name, argsHash],
    )[0] ?? null;
  }

  /**
   * The newest settled Job of one identity in the given state, if any. The id
   * breaks a tie: two Jobs of one identity really can settle in the same
   * millisecond — a repeat minted at settle can fail immediately — and "newest"
   * has to mean one row, not whichever the index happened to reach first.
   */
  newestSettledFor(name: string, argsHash: string, state: JobState): JobRow | null {
    return this.select(
      `${quote("name")} = ? AND ${quote("argsHash")} = ? AND ${quote("state")} = ?`,
      ` ORDER BY ${quote("settledAt")} DESC, ${quote("id")} DESC`,
      1,
      [name, argsHash, state],
    )[0] ?? null;
  }

  /**
   * Due Jobs in due order; the claim scan. `after` pages past Jobs an earlier
   * scan skipped (gate-saturated or undeclared) without re-reading them.
   *
   * A due Job is `pending` or `retrying`, and one `IN` over the leading column
   * of `(state, nextRunAt)` would make SQLite sort the whole due backlog on
   * every claim. So each state seeks its own keyset range under `LIMIT`, and
   * the two already-ordered windows — at most `2 * limit` rows — are ordered
   * once here.
   */
  due(now: number, limit: number, after?: JobCursor): JobRow[] {
    const where = after === undefined
      ? `${quote("state")} = ? AND ${quote("nextRunAt")} <= ?`
      : `${quote("state")} = ? AND ${quote("nextRunAt")} <= ? AND (${quote("nextRunAt")} > ? OR (${quote("nextRunAt")} = ? AND ${quote("id")} > ?))`;
    return DUE_JOB_STATES
      .flatMap((state) =>
        this.select(
          where,
          ` ORDER BY ${quote("nextRunAt")}, ${quote("id")}`,
          limit,
          after === undefined
            ? [state, now]
            : [state, now, after.nextRunAt, after.nextRunAt, after.id],
        ))
      .sort((a, b) => a.nextRunAt - b.nextRunAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, limit);
  }

  /** Running Jobs: bounded by the global cap. */
  running(): JobRow[] {
    return this.select(`${quote("state")} = 'running'`, "", 4096, []);
  }

  /** Jobs whose retention has expired, oldest first. */
  expired(now: number, limit: number): JobRow[] {
    return this.select(
      `${quote("deleteAfter")} IS NOT NULL AND ${quote("deleteAfter")} <= ?`,
      ` ORDER BY ${quote("deleteAfter")}`,
      limit,
      [now],
    );
  }
}

/** The runner's writer-side Job run store; construct one per transaction. */
export class JobRunsStore extends TableStore<JobRunRow> {
  constructor(engine: Engine, writes: WriteCollector) {
    super(engine, writes, JOB_RUNS_TABLE);
  }

  /** One run of one Job, by its position. */
  byNumber(jobId: bigint, number: number): JobRunRow | null {
    return this.select(
      `${quote("jobId")} = ? AND ${quote("number")} = ?`,
      "",
      1,
      [jobId, number],
    )[0] ?? null;
  }

  /** Every run of one Job, oldest first; the cascade a deleted Job performs. */
  ofJob(jobId: bigint, limit: number): JobRunRow[] {
    return this.select(`${quote("jobId")} = ?`, ` ORDER BY ${quote("number")}`, limit, [jobId]);
  }

  /** Running runs whose lease expired: crashed runs to recover. */
  expiredLeases(now: number, limit: number): JobRunRow[] {
    return this.select(
      `${quote("state")} = 'running' AND ${quote("leaseUntil")} IS NOT NULL AND ${quote("leaseUntil")} <= ?`,
      "",
      limit,
      [now],
    );
  }

  /** Settled runs whose retention has expired, oldest first. */
  expired(now: number, limit: number): JobRunRow[] {
    return this.select(
      `${quote("deleteAfter")} IS NOT NULL AND ${quote("deleteAfter")} <= ?`,
      ` ORDER BY ${quote("deleteAfter")}`,
      limit,
      [now],
    );
  }
}

/** Off-writer reads used by arming and waiting; safe on any reader connection. */
export function readJobRow(engine: Engine, connection: Database, id: bigint): JobRow | null {
  return readOne<JobRow>(engine, connection, JOBS_TABLE, `${quote("id")} = ?`, [id]);
}

/** The run a Job's outcome is read from: its latest, `(id, runCount)`. */
export function readJobRunRow(
  engine: Engine,
  connection: Database,
  jobId: bigint,
  number: number,
): JobRunRow | null {
  return readOne<JobRunRow>(
    engine,
    connection,
    JOB_RUNS_TABLE,
    `${quote("jobId")} = ? AND ${quote("number")} = ?`,
    [jobId, number],
  );
}

function readOne<Row>(
  engine: Engine,
  connection: Database,
  table: string,
  where: string,
  params: unknown[],
): Row | null {
  const plan = engine.rootScope.plan(table);
  const raw = connection
    .query(`SELECT ${plan.readProjection} FROM ${quote(plan.name)} WHERE ${where} LIMIT 1`)
    .get(...(params as never[])) as Record<string, unknown> | null;
  return raw === null ? null : (engine.rowFromSql(plan, raw) as unknown as Row);
}

/**
 * The next moment the runner must wake: the earliest due Job's `nextRunAt`, the
 * earliest `leaseUntil` of a running run with no live in-process run — a
 * crashed run whose recovery deadline is a wake reason of its own — or the
 * earliest retention deadline, because a stamp an idle application never
 * collects is not retention.
 */
export function nextDueJobAt(
  engine: Engine,
  connection: Database,
  inProcessIds: readonly bigint[] = [],
  notBefore = 0,
): number | null {
  const jobs = engine.rootScope.plan(JOBS_TABLE);
  const runs = engine.rootScope.plan(JOB_RUNS_TABLE);
  // One MIN per due state, not one `IN` over both: `IN` costs SQLite the
  // min-from-index shortcut and makes it walk each state's whole range instead
  // — and this runs on every commit that touches a jobs table.
  const due = DUE_JOB_STATES.map((state) =>
    connection
      .query(
        `SELECT MIN(${quote("nextRunAt")}) AS at FROM ${quote(jobs.name)} WHERE ${quote("state")} = ?`,
      )
      .get(state as never) as { at: number | bigint | null });
  const exclusion = inProcessIds.length === 0
    ? ""
    : ` AND ${quote("jobId")} NOT IN (${inProcessIds.map(() => "?").join(", ")})`;
  const abandoned = connection
    .query(
      `SELECT MIN(${quote("leaseUntil")}) AS at FROM ${quote(runs.name)} WHERE ${quote("state")} = 'running' AND ${quote("leaseUntil")} IS NOT NULL${exclusion}`,
    )
    .get(...(inProcessIds as never[])) as { at: number | bigint | null };
  const candidates = [...due.map((row) => row.at), abandoned.at]
    .filter((value): value is number | bigint => value !== null)
    .map(Number);
  // Retention rides its own index in both tables. `notBefore` is the sweep's
  // own interval: waking earlier than it would find nothing to do and park.
  const expiring = [jobs, runs]
    .map((plan) =>
      (connection
        .query(`SELECT MIN(${quote("deleteAfter")}) AS at FROM ${quote(plan.name)}`)
        .get() as { at: number | bigint | null }).at)
    .filter((value): value is number | bigint => value !== null)
    .map((value) => Math.max(Number(value), notBefore));
  const all = [...candidates, ...expiring];
  return all.length === 0 ? null : Math.min(...all);
}
