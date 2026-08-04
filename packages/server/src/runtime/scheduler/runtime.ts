import type { Telemetry } from "../../telemetry/telemetry.ts";
import { outcomeFromError } from "../outcome.ts";
import { transportError, type RuntimeOperationRunner } from "../execution/operation-runner.ts";
import type { RuntimeSession } from "../sessions/store.ts";
import {
  RuntimeScheduledCandidates,
  type ScheduledCandidate,
} from "./candidate.ts";

const SCHEDULER_RETRY_MS = 1_000;

export interface RuntimeSchedulerOptions {
  readonly candidates: RuntimeScheduledCandidates;
  readonly scheduled: ReadonlyMap<string, string>;
  readonly batchSize: number;
  readonly operations: RuntimeOperationRunner<RuntimeSession>;
  readonly telemetry: Telemetry;
  readonly signal: () => AbortSignal;
  readonly now: () => number;
  readonly isReady: () => boolean;
  readonly assertReady: () => void;
  readonly executeMutation: (
    candidate: ScheduledCandidate,
    now: number,
    signal: AbortSignal,
  ) => Promise<ReadonlySet<string> | null>;
}

/** Owns scheduled execution, single-flight batches, timer arming, and retry. */
export class RuntimeScheduler {
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<number> | null = null;
  private readonly scheduledAt = new Map<string, number | null>();
  private initialized = false;

  constructor(private readonly options: RuntimeSchedulerOptions) {}

  get handlerCount(): number {
    return this.options.scheduled.size;
  }

  get armed(): boolean {
    return this.timer !== null;
  }

  run(now = this.options.now()): Promise<number> {
    if (this.running !== null) return this.running;
    this.options.assertReady();
    const refreshedTables = new Set<string>();
    const execution = this.options.operations.run(
      null,
      "scheduled",
      undefined,
      1,
      async () => {
        let handled = 0;
        for (let attempts = 0; attempts < this.options.batchSize; attempts++) {
          const candidate = await this.options.candidates.next(now);
          if (candidate === null) break;
          const touchedTables = await this.options.executeMutation(
            candidate,
            now,
            this.options.signal(),
          );
          if (touchedTables === null) continue;
          for (const table of touchedTables) refreshedTables.add(table);
          handled++;
        }
        return handled;
      },
    );
    let run!: Promise<number>;
    run = execution.then(
      (handled) => {
        if (this.options.isReady()) this.arm(refreshedTables);
        return handled;
      },
      (error) => {
        this.retry(error);
        throw error;
      },
    ).finally(() => {
      if (this.running === run) this.running = null;
    });
    this.running = run;
    return run;
  }

  arm(touchedTables?: ReadonlySet<string>): void {
    const generation = ++this.generation;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (!this.options.isReady() || this.options.scheduled.size === 0) return;
    const fullRefresh = touchedTables === undefined || !this.initialized;
    const tables = fullRefresh ? this.options.scheduled.keys() : touchedTables;
    void this.options.candidates.nextAt(tables).then(
      (refreshed) => {
        if (!this.options.isReady() || generation !== this.generation) return;
        if (fullRefresh) this.scheduledAt.clear();
        for (const [table, at] of refreshed) this.scheduledAt.set(table, at);
        if (fullRefresh) this.initialized = true;
        let at: number | null = null;
        for (const candidate of this.scheduledAt.values()) {
          if (candidate !== null && (at === null || candidate < at)) at = candidate;
        }
        if (at === null) return;
        const delay = Math.min(Math.max(0, at - this.options.now()), 0x7fff_ffff);
        this.timer = setTimeout(() => {
          this.timer = null;
          void this.run().catch(() => {});
        }, delay);
        this.timer.unref?.();
      },
      (error) => {
        if (this.options.isReady() && generation === this.generation) {
          this.retry(error);
        }
      },
    );
  }

  stop(): void {
    this.generation++;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private retry(error: unknown): void {
    this.options.telemetry.recordEvent({
      name: "failure",
      level: "error",
      operation: "scheduled",
      outcome: outcomeFromError(transportError(error)).code,
      errorClass: error instanceof Error ? error.name : "UnknownError",
    });
    const generation = ++this.generation;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (!this.options.isReady()) return;
    this.timer = setTimeout(() => {
      if (this.options.isReady() && generation === this.generation) this.arm();
    }, SCHEDULER_RETRY_MS);
    this.timer.unref?.();
  }
}
