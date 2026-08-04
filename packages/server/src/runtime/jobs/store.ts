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

  /** Every row of one identity — bounded by dedup collapsing live duplicates. */
  byIdentity(name: string, argsHash: string): JobRow[] {
    return this.select(
      `${quote("name")} = ? AND ${quote("argsHash")} = ?`,
      "",
      64,
      [name, argsHash],
    );
  }

  /** Due pending rows in due order; the claim scan. */
  due(now: number, limit: number): JobRow[] {
    return this.select(
      `${quote("state")} = 'pending' AND ${quote("runAt")} <= ?`,
      ` ORDER BY ${quote("runAt")}, ${quote("id")}`,
      limit,
      [now],
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

  /** Terminal rows settled on or before `cutoff`, oldest first. */
  settledBefore(state: JobState, cutoff: number, limit: number): JobRow[] {
    return this.select(
      `${quote("state")} = ? AND ${quote("settledAt")} IS NOT NULL AND ${quote("settledAt")} <= ?`,
      ` ORDER BY ${quote("settledAt")}`,
      limit,
      [state, cutoff],
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

export function nextDueJobAt(engine: Engine, connection: Database): number | null {
  const plan = engine.rootScope.plan(JOBS_TABLE);
  const row = connection
    .query(
      `SELECT MIN(${quote("runAt")}) AS at FROM ${quote(plan.name)} WHERE ${quote("state")} = 'pending'`,
    )
    .get() as { at: number | bigint | null };
  return row.at === null ? null : Number(row.at);
}
