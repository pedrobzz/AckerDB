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

  nextAt(tables: Iterable<string>): Promise<ReadonlyMap<string, number | null>> {
    return this.options.reads.submit((connection) => {
      const refreshed = new Map<string, number | null>();
      for (const table of tables) {
        const plan = this.options.engine.plan(table);
        const row = connection
          .query(
            `SELECT MIN(${quoteSqlIdentifier(plan.scheduleAt!)}) AS at FROM ${quoteSqlIdentifier(table)}`,
          )
          .get() as { at: number | bigint | null };
        refreshed.set(table, row.at === null ? null : Number(row.at));
      }
      return refreshed;
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
