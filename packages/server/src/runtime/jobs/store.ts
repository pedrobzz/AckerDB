/**
 * Planned-SQL access to `_ackerdb_jobs` for the runner: targeted, indexed
 * statements — never a full-table scan — with writes going through the
 * access-layer table writer so write keys, commit-wake, and validation behave
 * exactly like any table write.
 */
import type { Database } from "bun:sqlite";
import { makeJobsTableWriter, type WriteCollector } from "../../database/access.ts";
import type { Engine, TablePlan } from "../../database/engine.ts";
import { JOBS_TABLE } from "../../jobs/table.ts";
import type { JobState } from "../../jobs/definition.ts";
import type { DbStatementObserver } from "../../database/statement-observation.ts";
import type { JobRow } from "./runtime.ts";

const quote = (name: string): string => `"${name}"`;

function rowsFrom(engine: Engine, plan: TablePlan, raws: Record<string, unknown>[]): JobRow[] {
  return raws.map((raw) => engine.rowFromSql(plan, raw) as unknown as JobRow);
}

/** The runner's writer-side store; construct one per transaction. */
export class JobsStore {
  private readonly writer: ReturnType<typeof makeJobsTableWriter>;
  private readonly plan: TablePlan;

  constructor(
    private readonly engine: Engine,
    writes: WriteCollector,
    observer?: DbStatementObserver,
  ) {
    this.writer = makeJobsTableWriter(engine, writes, observer);
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

  private select(where: string, order: string, limit: number, params: unknown[]): JobRow[] {
    const raws = this.engine
      .statement(
        this.engine.writer,
        `SELECT ${this.plan.readProjection} FROM ${quote(this.plan.name)} WHERE ${where}${order} LIMIT ${limit}`,
      )
      .all(...(params as never[])) as Record<string, unknown>[];
    return rowsFrom(this.engine, this.plan, raws);
  }

  byId(id: bigint): JobRow | null {
    return this.select(`${quote("id")} = ?`, "", 1, [id])[0] ?? null;
  }

  /** The live (pending or running) row of one identity, if any. */
  liveRowFor(name: string, argsHash: string): JobRow | null {
    return this.select(
      `${quote("name")} = ? AND ${quote("argsHash")} = ? AND ${quote("state")} IN ('pending', 'running')`,
      "",
      1,
      [name, argsHash],
    )[0] ?? null;
  }

  /** The newest settled row of one identity in the given state, if any. */
  newestSettledFor(name: string, argsHash: string, state: JobState): JobRow | null {
    return this.select(
      `${quote("name")} = ? AND ${quote("argsHash")} = ? AND ${quote("state")} = ?`,
      ` ORDER BY ${quote("settledAt")} DESC`,
      1,
      [name, argsHash, state],
    )[0] ?? null;
  }

  /**
   * Due pending rows in due order; the claim scan. `after` pages past rows an
   * earlier scan skipped (gate-saturated or undeclared) without re-reading
   * them: keyset on the same (runAt, id) order.
   */
  due(now: number, limit: number, after?: { runAt: number; id: bigint }): JobRow[] {
    const where = after === undefined
      ? `${quote("state")} = 'pending' AND ${quote("runAt")} <= ?`
      : `${quote("state")} = 'pending' AND ${quote("runAt")} <= ? AND (${quote("runAt")} > ? OR (${quote("runAt")} = ? AND ${quote("id")} > ?))`;
    return this.select(
      where,
      ` ORDER BY ${quote("runAt")}, ${quote("id")}`,
      limit,
      after === undefined ? [now] : [now, after.runAt, after.runAt, after.id],
    );
  }

  /** Running rows: bounded by the global cap. */
  running(): JobRow[] {
    return this.select(`${quote("state")} = 'running'`, "", 4096, []);
  }

  /** Running rows whose lease expired: crashed attempts to recover. */
  expiredLeases(now: number, limit: number): JobRow[] {
    return this.select(
      `${quote("state")} = 'running' AND ${quote("leaseUntil")} IS NOT NULL AND ${quote("leaseUntil")} <= ?`,
      "",
      limit,
      [now],
    );
  }

  /** One definition's terminal rows settled on or before `cutoff`, oldest first. */
  settledBefore(name: string, state: JobState, cutoff: number, limit: number): JobRow[] {
    return this.select(
      `${quote("name")} = ? AND ${quote("state")} = ? AND ${quote("settledAt")} IS NOT NULL AND ${quote("settledAt")} <= ?`,
      ` ORDER BY ${quote("settledAt")}`,
      limit,
      [name, state, cutoff],
    );
  }

  /** Terminal rows of undeclared definitions, settled on or before `cutoff`. */
  settledBeforeExcluding(
    declared: readonly string[],
    state: JobState,
    cutoff: number,
    limit: number,
  ): JobRow[] {
    const exclusion = declared.length === 0
      ? ""
      : ` AND ${quote("name")} NOT IN (${declared.map(() => "?").join(", ")})`;
    return this.select(
      `${quote("state")} = ? AND ${quote("settledAt")} IS NOT NULL AND ${quote("settledAt")} <= ?${exclusion}`,
      ` ORDER BY ${quote("settledAt")}`,
      limit,
      [state, cutoff, ...declared],
    );
  }
}

/** Off-writer reads used by arming and waiting; safe on any reader connection. */
export function readJobRow(engine: Engine, connection: Database, id: bigint): JobRow | null {
  const plan = engine.rootScope.plan(JOBS_TABLE);
  const raw = connection
    .query(`SELECT ${plan.readProjection} FROM ${quote(plan.name)} WHERE ${quote("id")} = ?`)
    .get(id as never) as Record<string, unknown> | null;
  return raw === null ? null : (engine.rowFromSql(plan, raw) as unknown as JobRow);
}

export function dueJobStats(
  engine: Engine,
  connection: Database,
  now: number,
): { due: number; oldestDueAt: number | null } {
  const plan = engine.rootScope.plan(JOBS_TABLE);
  const row = connection
    .query(
      `SELECT COUNT(*) AS due, MIN(${quote("runAt")}) AS oldest FROM ${quote(plan.name)} WHERE ${quote("state")} = 'pending' AND ${quote("runAt")} <= ?`,
    )
    .get(now as never) as { due: number | bigint; oldest: number | bigint | null };
  return {
    due: Number(row.due),
    oldestDueAt: row.oldest === null ? null : Number(row.oldest),
  };
}

/**
 * The next moment the runner must wake: the earliest pending `runAt`, or the
 * earliest `leaseUntil` of a running row with no live in-process run — a
 * crashed attempt whose recovery deadline is a wake reason of its own.
 */
export function nextDueJobAt(
  engine: Engine,
  connection: Database,
  inProcessIds: readonly bigint[] = [],
): number | null {
  const plan = engine.rootScope.plan(JOBS_TABLE);
  const pending = connection
    .query(
      `SELECT MIN(${quote("runAt")}) AS at FROM ${quote(plan.name)} WHERE ${quote("state")} = 'pending'`,
    )
    .get() as { at: number | bigint | null };
  const exclusion = inProcessIds.length === 0
    ? ""
    : ` AND ${quote("id")} NOT IN (${inProcessIds.map(() => "?").join(", ")})`;
  const abandoned = connection
    .query(
      `SELECT MIN(${quote("leaseUntil")}) AS at FROM ${quote(plan.name)} WHERE ${quote("state")} = 'running'${exclusion}`,
    )
    .get(...(inProcessIds as never[])) as { at: number | bigint | null };
  const candidates = [pending.at, abandoned.at]
    .filter((value): value is number | bigint => value !== null)
    .map(Number);
  return candidates.length === 0 ? null : Math.min(...candidates);
}
