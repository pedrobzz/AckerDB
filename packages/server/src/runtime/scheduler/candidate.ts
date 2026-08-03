import type { Engine } from "../../database/engine.ts";
import type { RuntimeReadExecutor } from "../execution/read.ts";
import type { RuntimeTraceBridge } from "../telemetry/trace-bridge.ts";

type CandidateEngine = Pick<Engine, "plan">;
type CandidateReads = Pick<RuntimeReadExecutor, "submit">;
type CandidateTracing = Pick<RuntimeTraceBridge, "measureStatement">;

export interface ScheduledCandidate {
  readonly table: string;
  readonly address: string;
  readonly primaryKey: unknown;
}

export interface RuntimeScheduledCandidatesOptions {
  readonly scheduled: ReadonlyMap<string, string>;
  readonly engine: CandidateEngine;
  readonly reads: CandidateReads;
  readonly tracing: CandidateTracing;
}

/** Owns scheduled-table discovery SQL on the bounded reader pool. */
export class RuntimeScheduledCandidates {
  constructor(private readonly options: RuntimeScheduledCandidatesOptions) {}

  nextAt(): Promise<number | null> {
    return this.options.reads.submit((connection) => {
      let earliest: number | null = null;
      for (const table of this.options.scheduled.keys()) {
        const plan = this.options.engine.plan(table);
        const row = connection
          .query(
            `SELECT MIN(${quoteSqlIdentifier(plan.scheduleAt!)}) AS at FROM ${quoteSqlIdentifier(table)}`,
          )
          .get() as { at: number | bigint | null };
        if (row.at === null) continue;
        const value = Number(row.at);
        if (earliest === null || value < earliest) earliest = value;
      }
      return earliest;
    }, {
      operation: "scheduled",
      bytes: 1,
      fairnessKey: "system:scheduler",
    }, false);
  }

  next(now: number): Promise<ScheduledCandidate | null> {
    return this.options.reads.submit((connection) => {
      let candidate: (ScheduledCandidate & { readonly at: number }) | null = null;
      for (const [table, address] of this.options.scheduled) {
        const plan = this.options.engine.plan(table);
        const raw = this.options.tracing.measureStatement(
          "read",
          table,
          "scheduledCandidate",
          () => connection.query(
            `SELECT ${quoteSqlIdentifier(plan.pk)} AS primaryKey, ${quoteSqlIdentifier(plan.scheduleAt!)} AS at FROM ${quoteSqlIdentifier(table)} WHERE ${quoteSqlIdentifier(plan.scheduleAt!)} <= ? ORDER BY ${quoteSqlIdentifier(plan.scheduleAt!)}, ${quoteSqlIdentifier(plan.pk)} LIMIT 1`,
          ).get(now) as { primaryKey: unknown; at: number | bigint } | null,
          (value) => value === null ? 0 : 1,
        );
        if (raw === null) continue;
        const at = Number(raw.at);
        if (candidate === null || at < candidate.at) {
          candidate = { table, address, primaryKey: raw.primaryKey, at };
        }
      }
      return candidate === null
        ? null
        : {
            table: candidate.table,
            address: candidate.address,
            primaryKey: candidate.primaryKey,
          };
    }, {
      operation: "scheduled",
      bytes: 1,
      fairnessKey: "system:scheduler",
    });
  }
}

export function quoteSqlIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
