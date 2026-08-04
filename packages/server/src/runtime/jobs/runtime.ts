/**
 * The job runner: owns the `_ackerdb_jobs` state machine end to end — arming,
 * claiming, executing, settling, recurrence, lease recovery, retention — on
 * top of the same commit machinery every mutation uses.
 *
 * Execution envelopes, by declared kind:
 * - mutation-kind: claim, handler, and settle collapse into one writer
 *   transaction — exactly-once, no external I/O. A failed handler rolls the
 *   whole transaction back; the failed attempt is then recorded in a fresh
 *   transaction, so no partial handler write can survive.
 * - procedure-kind: a claim transaction stamps a lease, the handler runs as a
 *   system operation (external work allowed), and a settle transaction
 *   re-validates state + lease before recording the outcome — at-least-once
 *   under retries; a stale lease means the row moved on and the result is
 *   discarded, never double-settled.
 *
 * Waiters resolve at the *current attempt's* settle — after its transaction
 * commits — and a failed attempt reports `nextRetryAt` so the caller decides
 * whether to keep waiting.
 */
import { decode, isApplicationError, isResult, stableEncode, type OutcomeCode } from "@ackerdb/core";
import type { SystemCtx, SystemRunner } from "../../app/system.ts";
import { AckerDBError } from "../../shared/errors.ts";
import { ValidationError } from "../../validation/error.ts";
import type { Telemetry } from "../../telemetry/telemetry.ts";
import type { AnyJob, DeclaredJob, JobState } from "../../jobs/definition.ts";
import { encodeJobArgs, hashJobArgs } from "../../jobs/identity.ts";
import type { JobsWriteSurface } from "../execution/functions.ts";
import type { JobsStore } from "./store.ts";
import type { RuntimeReadExecutor } from "../execution/read.ts";
import type { Database } from "bun:sqlite";
import { outcomeFromError } from "../outcome.ts";

/** The slice of the function executor the runner consumes. */
export interface JobsExecutor {
  jobsWrite<T>(
    signal: AbortSignal,
    work: (surface: JobsWriteSurface) => T | Promise<T>,
  ): Promise<T>;
  readJobRow(connection: Database, id: bigint): JobRow | null;
  nextDueJobAt(connection: Database): number | null;
}

const LEASE_EXPIRED = "job lease expired before the attempt settled";
const MAX_STORED_ERROR_LENGTH = 512;
const REAP_INTERVAL_MS = 60_000;

export interface JobRow {
  readonly id: bigint;
  readonly name: string;
  readonly argsJson: string;
  readonly argsHash: string;
  readonly key: string | null;
  readonly state: JobState;
  readonly runAt: number;
  readonly attempt: number;
  readonly attemptsJson: string;
  readonly outputJson: string | null;
  readonly leaseToken: string | null;
  readonly leaseUntil: number | null;
  readonly enqueuedAt: number;
  readonly settledAt: number | null;
}

export interface JobAttemptRecord {
  readonly startedAt: number;
  readonly settledAt: number;
  readonly outcome: "completed" | "failed" | "discarded" | "canceled";
  readonly error: string | null;
  readonly durationMs: number;
}

/** What one settled attempt reports to awaiting callers. */
export type JobAttemptOutcome =
  | { readonly ok: true; readonly value: unknown }
  | {
      readonly ok: false;
      readonly state: "pending" | "discarded" | "canceled";
      readonly error: unknown;
      /** When the next attempt is due, or null when the job will not retry. */
      readonly nextRetryAt: number | null;
    };

export interface JobEnqueueOptions {
  readonly at?: number;
  readonly delayMs?: number;
}

export interface JobHandle {
  readonly id: bigint;
  /** True when dedup resolved this call to an existing row. */
  readonly deduped: boolean;
}

export interface RuntimeJobsLimits {
  readonly maxRunning: number;
  readonly claimBatchSize: number;
  readonly leaseMs: number;
}

export interface RuntimeJobsOptions {
  readonly declared: readonly DeclaredJob[];
  readonly executor: JobsExecutor;
  readonly reads: RuntimeReadExecutor;
  readonly system: SystemRunner;
  readonly telemetry: Telemetry;
  readonly limits: RuntimeJobsLimits;
  readonly now: () => number;
  readonly signal: () => AbortSignal;
  readonly isReady: () => boolean;
}

interface ClaimedRow {
  readonly id: bigint;
  readonly name: string;
  readonly argsJson: string;
  readonly attempt: number;
  readonly leaseToken: string;
}

interface Notification {
  readonly id: bigint;
  readonly outcome: JobAttemptOutcome;
  readonly event: "settled" | "retried" | "discarded" | "canceled";
  readonly errorCode?: OutcomeCode;
}

/** Control-flow carrier: a mutation-kind handler failed and rolled back. */
class MutationJobFailure {
  constructor(
    readonly row: JobRow,
    readonly attempt: number,
    readonly error: unknown,
    readonly startedAt: number,
  ) {}
}

export class RuntimeJobs {
  private readonly definitions = new Map<string, AnyJob>();
  private readonly waiters = new Map<bigint, Set<(outcome: JobAttemptOutcome) => void>>();
  private readonly runControllers = new Map<bigint, AbortController>();
  private activeRuns = 0;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private leaseCounter = 0;
  private lastReapAt = 0;

  constructor(private readonly options: RuntimeJobsOptions) {
    for (const { name, job } of options.declared) {
      this.definitions.set(name, job);
    }
  }

  get declaredCount(): number {
    return this.definitions.size;
  }

  get declaredNames(): readonly string[] {
    return [...this.definitions.keys()];
  }

  get runningCount(): number {
    return this.activeRuns;
  }

  definition(name: string): AnyJob {
    const definition = this.definitions.get(name);
    if (definition === undefined) {
      throw new AckerDBError("not_found", `unknown job "${name}"`);
    }
    return definition;
  }

  /** Mint the first occurrence of every argless repeating job, then arm. */
  async activate(): Promise<void> {
    const bootstrap = [...this.definitions.entries()].filter(
      ([, definition]) =>
        definition.repeat !== null && Object.keys(definition.args).length === 0,
    );
    if (bootstrap.length > 0) {
      await this.options.executor.jobsWrite(this.options.signal(), async (surface) => {
        const now = this.options.now();
        for (const [name, definition] of bootstrap) {
          const argsJson = encodeJobArgs({});
          const argsHash = hashJobArgs(argsJson);
          if (this.liveRow(surface.jobs, name, argsHash) !== null) continue;
          const at = definition.repeat!(now, now);
          if (at === null) continue;
          await this.insertRow(surface.jobs, { name, argsJson, argsHash, key: null, runAt: at, now });
        }
      }).catch(() => {}); // arming still proceeds; enqueues re-wake the runner
    }
    this.arm();
  }

  /** Commit-wake: called after any transaction that touched the jobs table. */
  arm(): void {
    const generation = ++this.generation;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (!this.options.isReady() || this.definitions.size === 0) return;
    void this.nextDueAt().then(
      (at) => {
        if (!this.options.isReady() || generation !== this.generation) return;
        if (at === null) return;
        const delay = Math.min(Math.max(0, at - this.options.now()), 0x7fff_ffff);
        this.timer = setTimeout(() => {
          this.timer = null;
          void this.run().catch(() => {});
        }, delay);
        this.timer.unref?.();
      },
      () => {
        if (!this.options.isReady() || generation !== this.generation) return;
        this.timer = setTimeout(() => {
          this.timer = null;
          this.arm();
        }, 1_000);
        this.timer.unref?.();
      },
    );
  }

  get armed(): boolean {
    return this.timer !== null;
  }

  stop(): void {
    this.generation++;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    for (const controller of this.runControllers.values()) {
      controller.abort(new AckerDBError("unavailable", "runtime is shutting down"));
    }
  }

  /** One single-flight batch: recover leases, claim due work, reap history. */
  run(): Promise<void> {
    if (this.running !== null) return this.running;
    const batch = this.batch().finally(() => {
      this.running = null;
      if (this.options.isReady()) this.arm();
    });
    this.running = batch;
    return batch;
  }

  // -- Enqueue and awaiting --------------------------------------------------

  /**
   * Insert one job row (or resolve to an existing one under dedup) inside an
   * already-open transaction — the transactional-enqueue seam mutations use.
   */
  async enqueueWith(
    store: JobsStore,
    name: string,
    args: unknown,
    options: JobEnqueueOptions = {},
  ): Promise<JobHandle> {
    const definition = this.definition(name);
    const validated = this.validateArgs(definition, name, args);
    const argsJson = encodeJobArgs(validated);
    const argsHash = hashJobArgs(argsJson);
    const now = this.options.now();
    if (definition.dedupe !== null) {
      const existing = this.dedupeRow(store, definition, name, argsHash, now);
      if (existing !== null) return { id: existing.id, deduped: true };
    }
    const runAt = options.at ?? (options.delayMs !== undefined ? now + options.delayMs : now);
    if (typeof runAt !== "number" || !Number.isFinite(runAt)) {
      throw new ValidationError(`jobs.${name}: enqueue at/delayMs must be finite milliseconds`);
    }
    const key = definition.key === null ? null : String(definition.key(validated as never));
    const id = await this.insertRow(store, { name, argsJson, argsHash, key, runAt, now });
    return { id, deduped: false };
  }

  /** Standalone enqueue: opens its own transaction (procedures, services). */
  async enqueue(
    name: string,
    args: unknown,
    options: JobEnqueueOptions = {},
  ): Promise<JobHandle> {
    return await this.options.executor.jobsWrite(
      this.options.signal(),
      (surface) => this.enqueueWith(surface.jobs, name, args, options),
    );
  }

  /**
   * Resolve when the row's current attempt settles. A row already terminal —
   * including a dedup hit inside a completed window — resolves immediately
   * from its recorded outcome.
   */
  async wait(id: bigint): Promise<JobAttemptOutcome> {
    if (typeof id !== "bigint") {
      throw new ValidationError("jobs.wait: expected a bigint job id");
    }
    let resolver: ((outcome: JobAttemptOutcome) => void) | null = null;
    const pending = new Promise<JobAttemptOutcome>((resolve) => {
      resolver = resolve;
      let set = this.waiters.get(id);
      if (set === undefined) this.waiters.set(id, (set = new Set()));
      set.add(resolve);
    });
    // Read after registering, so a settle between read and registration
    // cannot be missed; a terminal row resolves from its recorded state.
    const row = await this.readRow(id);
    const unregister = () => {
      const set = this.waiters.get(id);
      if (set !== undefined && resolver !== null) {
        set.delete(resolver);
        if (set.size === 0) this.waiters.delete(id);
      }
    };
    if (row === null) {
      unregister();
      throw new AckerDBError("not_found", `job ${id} does not exist`);
    }
    const terminal = this.terminalOutcome(row);
    if (terminal !== null) {
      unregister();
      return terminal;
    }
    return pending;
  }

  // -- Transitions -----------------------------------------------------------

  /** Cancel: settles a pending or running row; a running handler is aborted. */
  async cancel(id: bigint): Promise<JobState> {
    if (typeof id !== "bigint") {
      throw new ValidationError("jobs.cancel: expected a bigint job id");
    }
    const state = await this.options.executor.jobsWrite(this.options.signal(), async (surface) => {
      const row = surface.jobs.byId(id);
      if (row === null) throw new AckerDBError("not_found", `job ${id} does not exist`);
      if (row.state !== "pending" && row.state !== "running") return row.state;
      await surface.jobs.patch(id, {
        state: "canceled",
        leaseToken: null,
        leaseUntil: null,
        settledAt: this.options.now(),
        attemptsJson: row.state === "running"
          ? this.appendAttempt(row, "canceled", null)
          : row.attemptsJson,
      });
      return "canceled" as const;
    });
    if (state === "canceled") {
      this.runControllers.get(id)?.abort(new AckerDBError("unavailable", "job was canceled"));
      this.deliver([{
        id,
        event: "canceled",
        outcome: {
          ok: false,
          state: "canceled",
          error: new AckerDBError("unavailable", "job was canceled"),
          nextRetryAt: null,
        },
      }]);
    }
    return state;
  }

  /** Re-run a terminal row now, keeping its identity and attempt history. */
  async retryNow(id: bigint): Promise<void> {
    if (typeof id !== "bigint") {
      throw new ValidationError("jobs.retry: expected a bigint job id");
    }
    await this.options.executor.jobsWrite(this.options.signal(), async (surface) => {
      const row = surface.jobs.byId(id);
      if (row === null) throw new AckerDBError("not_found", `job ${id} does not exist`);
      if (row.state === "pending" || row.state === "running") {
        throw new AckerDBError("conflict", `job ${id} is ${row.state}; only settled jobs retry`);
      }
      await surface.jobs.patch(id, {
        state: "pending",
        runAt: this.options.now(),
        outputJson: null,
        leaseToken: null,
        leaseUntil: null,
        settledAt: null,
      });
    });
  }

  /** Move a pending row's due time. */
  async reschedule(id: bigint, at: number): Promise<void> {
    if (typeof id !== "bigint") {
      throw new ValidationError("jobs.reschedule: expected a bigint job id");
    }
    if (typeof at !== "number" || !Number.isFinite(at)) {
      throw new ValidationError("jobs.reschedule: expected finite milliseconds");
    }
    await this.options.executor.jobsWrite(this.options.signal(), async (surface) => {
      const row = surface.jobs.byId(id);
      if (row === null) throw new AckerDBError("not_found", `job ${id} does not exist`);
      if (row.state !== "pending") {
        throw new AckerDBError("conflict", `job ${id} is ${row.state}; only pending jobs reschedule`);
      }
      await surface.jobs.patch(id, { runAt: at });
    });
  }

  // -- The batch -------------------------------------------------------------

  private async batch(): Promise<void> {
    if (!this.options.isReady()) return;
    const signal = this.options.signal();
    const claimBudget = this.options.limits.claimBatchSize;
    let claims = 0;
    try {
      await this.recoverExpiredLeases(signal);
      while (
        claims < claimBudget &&
        this.activeRuns < this.options.limits.maxRunning &&
        !signal.aborted
      ) {
        const claimed = await this.claimNext(signal);
        if (claimed === null) break;
        claims++;
        if (claimed !== "settled-inline") this.dispatch(claimed);
      }
      await this.reap(signal);
      this.recordGauges();
    } catch (error) {
      this.event("failure", "error", outcomeFromError(error).code);
    }
  }

  /**
   * Recover crashed attempts: a running row whose lease expired settles as a
   * failed attempt through the ordinary retry policy. Rows with a live
   * in-process run are skipped — their settle owns them.
   */
  private async recoverExpiredLeases(signal: AbortSignal): Promise<void> {
    const now = this.options.now();
    const notifications = await this.options.executor.jobsWrite(signal, async (surface) => {
      const delivered: Notification[] = [];
      for (const row of surface.jobs.expiredLeases(now, this.options.limits.claimBatchSize)) {
        if (this.runControllers.has(row.id)) continue;
        delivered.push(
          await this.settleFailureIn(surface, row, new AckerDBError("unavailable", LEASE_EXPIRED)),
        );
      }
      return delivered;
    });
    this.deliver(notifications);
  }

  /**
   * Claim the next eligible due row. Mutation-kind rows execute and settle in
   * the same transaction; procedure-kind rows are leased for dispatch.
   */
  private async claimNext(signal: AbortSignal): Promise<ClaimedRow | "settled-inline" | null> {
    let outcome:
      | { claimed: ClaimedRow }
      | { inline: Notification }
      | null = null;
    try {
      outcome = await this.options.executor.jobsWrite(signal, async (surface) => {
        const now = this.options.now();
        const runningByGate = new Map<string, number>();
        for (const row of surface.jobs.running()) {
          const gate = `${row.name} ${row.key ?? ""}`;
          runningByGate.set(gate, (runningByGate.get(gate) ?? 0) + 1);
        }
        for (const row of surface.jobs.due(now, this.options.limits.claimBatchSize)) {
          const definition = this.definitions.get(row.name);
          if (definition === undefined) continue; // undeclared leftover; visible in the table
          const gate = `${row.name} ${row.key ?? ""}`;
          if ((runningByGate.get(gate) ?? 0) >= definition.concurrency) continue;
          const attempt = row.attempt + 1;
          if (definition.kind === "mutation") {
            const inline = await this.runMutationJob(surface, row, definition, attempt);
            return { inline };
          }
          const leaseToken = `${now.toString(36)}-${(++this.leaseCounter).toString(36)}`;
          await surface.jobs.patch(row.id, {
            state: "running",
            attempt,
            leaseToken,
            leaseUntil: now + this.options.limits.leaseMs,
          });
          return {
            claimed: {
              id: row.id,
              name: row.name,
              argsJson: row.argsJson,
              attempt,
              leaseToken,
            },
          };
        }
        return null;
      });
    } catch (error) {
      if (!(error instanceof MutationJobFailure)) throw error;
      // The handler's transaction rolled back whole; record the failed
      // attempt in a fresh transaction so no partial write survives.
      const notification = await this.options.executor.jobsWrite(
        signal,
        async (surface) => {
          const row = surface.jobs.byId(error.row.id);
          if (row === null || row.state !== "pending") return null;
          return await this.settleFailureIn(
            surface,
            { ...row, attempt: error.attempt },
            error.error,
            error.startedAt,
          );
        },
      );
      this.deliver(notification === null ? [] : [notification]);
      return "settled-inline";
    }
    if (outcome === null) return null;
    if ("inline" in outcome) {
      this.deliver([outcome.inline]);
      this.event("claimed", "info");
      return "settled-inline";
    }
    this.event("claimed", "info");
    return outcome.claimed;
  }

  /** Claim + handler + settle in one writer transaction: exactly-once. */
  private async runMutationJob(
    surface: JobsWriteSurface,
    row: JobRow,
    definition: AnyJob,
    attempt: number,
  ): Promise<Notification> {
    const startedAt = this.options.now();
    const args = decode(row.argsJson);
    let value: unknown;
    try {
      const context = Object.freeze({
        ...surface.systemMutationCtx(),
        attempt,
      });
      value = await definition.handler(context as never, args as never);
    } catch (error) {
      throw new MutationJobFailure(row, attempt, error, startedAt);
    }
    if (isResult(value) && !value.ok) {
      throw new MutationJobFailure(row, attempt, value.error, startedAt);
    }
    return await this.settleSuccessIn(
      surface,
      { ...row, attempt },
      isResult(value) ? value.data : value,
      startedAt,
    );
  }

  /** Procedure-kind dispatch: run as a system operation, then settle. */
  private dispatch(claimed: ClaimedRow): void {
    const definition = this.definitions.get(claimed.name)!;
    const controller = new AbortController();
    this.runControllers.set(claimed.id, controller);
    this.activeRuns++;
    const startedAt = this.options.now();
    const args = decode(claimed.argsJson);
    void this.options.system
      .run(
        `jobs.${claimed.name}`,
        async (ctx: SystemCtx) => {
          const context = Object.freeze({ ...ctx, attempt: claimed.attempt });
          return await definition.handler(context as never, args as never);
        },
        { signal: controller.signal },
      )
      .then(
        (value) =>
          isResult(value) && !value.ok
            ? this.settle(claimed, { ok: false, error: value.error }, startedAt)
            : this.settle(
                claimed,
                { ok: true, value: isResult(value) ? value.data : value },
                startedAt,
              ),
        (error) => this.settle(claimed, { ok: false, error }, startedAt),
      )
      .finally(() => {
        this.activeRuns--;
        this.runControllers.delete(claimed.id);
        if (this.options.isReady()) this.arm();
      });
  }

  /** The settle transaction: re-validate state and lease, then record. */
  private async settle(
    claimed: ClaimedRow,
    outcome: { ok: true; value: unknown } | { ok: false; error: unknown },
    startedAt: number,
  ): Promise<void> {
    try {
      const notification = await this.options.executor.jobsWrite(
        this.options.signal(),
        async (surface) => {
          const row = surface.jobs.byId(claimed.id);
          if (row === null || row.state !== "running" || row.leaseToken !== claimed.leaseToken) {
            return null; // canceled, reclaimed, or deleted while running: the row moved on
          }
          return outcome.ok
            ? await this.settleSuccessIn(surface, row, outcome.value, startedAt)
            : await this.settleFailureIn(surface, row, outcome.error, startedAt);
        },
      );
      this.deliver(notification === null ? [] : [notification]);
    } catch (error) {
      // Shutdown or a failed settle commit: the lease expires and recovery
      // re-runs the attempt — at-least-once, as declared.
      this.event("failure", "error", outcomeFromError(error).code);
    }
  }

  private async settleSuccessIn(
    surface: JobsWriteSurface,
    row: JobRow,
    value: unknown,
    startedAt = this.options.now(),
  ): Promise<Notification> {
    const now = this.options.now();
    let outputJson: string;
    try {
      outputJson = stableEncode(value);
    } catch (error) {
      return await this.settleFailureIn(surface, row, error, startedAt);
    }
    await surface.jobs.patch(row.id, {
      state: "completed",
      attempt: row.attempt,
      outputJson,
      leaseToken: null,
      leaseUntil: null,
      settledAt: now,
      attemptsJson: this.appendAttempt(row, "completed", null, startedAt, now),
    });
    await this.mintRepeat(surface, row, now);
    return { id: row.id, event: "settled", outcome: { ok: true, value } };
  }

  private async settleFailureIn(
    surface: JobsWriteSurface,
    row: JobRow,
    error: unknown,
    startedAt = this.options.now(),
  ): Promise<Notification> {
    const definition = this.definitions.get(row.name);
    const now = this.options.now();
    let delay: number | null = null;
    if (definition !== undefined) {
      try {
        delay = definition.retry(row.attempt, error);
      } catch {
        delay = null; // a throwing retry policy discards, never wedges
      }
    }
    if (delay !== null && (typeof delay !== "number" || !Number.isFinite(delay) || delay < 0)) {
      delay = null;
    }
    if (delay !== null) {
      const nextRetryAt = now + delay;
      await surface.jobs.patch(row.id, {
        state: "pending",
        runAt: nextRetryAt,
        attempt: row.attempt,
        leaseToken: null,
        leaseUntil: null,
        attemptsJson: this.appendAttempt(row, "failed", error, startedAt, now),
      });
      return {
        id: row.id,
        event: "retried",
        errorCode: outcomeFromError(error).code,
        outcome: { ok: false, state: "pending", error, nextRetryAt },
      };
    }
    await surface.jobs.patch(row.id, {
      state: "discarded",
      attempt: row.attempt,
      leaseToken: null,
      leaseUntil: null,
      settledAt: now,
      attemptsJson: this.appendAttempt(row, "discarded", error, startedAt, now),
    });
    await this.mintRepeat(surface, row, now);
    return {
      id: row.id,
      event: "discarded",
      errorCode: outcomeFromError(error).code,
      outcome: { ok: false, state: "discarded", error, nextRetryAt: null },
    };
  }

  /** Recurrence is framework-owned: the next occurrence is a fresh row. */
  private async mintRepeat(surface: JobsWriteSurface, row: JobRow, now: number): Promise<void> {
    const definition = this.definitions.get(row.name);
    if (definition === undefined || definition.repeat === null) return;
    let at: number | null;
    try {
      at = definition.repeat(row.runAt, now);
    } catch {
      return; // a throwing repeat rule ends the recurrence
    }
    if (at === null) return;
    if (typeof at !== "number" || !Number.isFinite(at)) return;
    if (this.liveRow(surface.jobs, row.name, row.argsHash) !== null) return;
    await this.insertRow(surface.jobs, {
      name: row.name,
      argsJson: row.argsJson,
      argsHash: row.argsHash,
      key: row.key,
      runAt: at,
      now,
    });
  }

  /** Delete terminal rows past their definition's effective retention. */
  private async reap(signal: AbortSignal): Promise<void> {
    const now = this.options.now();
    if (now - this.lastReapAt < REAP_INTERVAL_MS) return;
    this.lastReapAt = now;
    await this.options.executor.jobsWrite(signal, async (surface) => {
      for (const state of ["completed", "discarded", "canceled"] as const) {
        for (const row of surface.jobs.settledBefore(state, now, this.options.limits.claimBatchSize)) {
          const retention = this.effectiveRetention(this.definitions.get(row.name), state);
          if (retention === "forever") continue;
          if (row.settledAt! + retention <= now) await surface.jobs.delete(row.id);
        }
      }
    });
  }

  private effectiveRetention(
    definition: AnyJob | undefined,
    state: JobState,
  ): number | "forever" {
    if (definition === undefined) return 0;
    const windows: (number | "forever")[] = [definition.retention];
    if (definition.dedupe !== null) {
      windows.push(
        state === "completed" ? definition.dedupe.completed : definition.dedupe.discarded,
      );
    }
    if (windows.includes("forever")) return "forever";
    return Math.max(...(windows as number[]));
  }

  // -- Row helpers -----------------------------------------------------------

  private validateArgs(
    definition: AnyJob,
    name: string,
    args: unknown,
  ): Record<string, unknown> {
    if (args === null || typeof args !== "object" || Array.isArray(args)) {
      throw new ValidationError(`jobs.${name}: expected an args object`);
    }
    const input = args as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [field, validator] of Object.entries(
      definition.args as Record<string, { check(value: unknown, where: string): unknown }>,
    )) {
      out[field] = validator.check(input[field], `jobs.${name}.args.${field}`);
    }
    for (const field of Object.keys(input)) {
      if (!Object.hasOwn(definition.args, field) && input[field] !== undefined) {
        throw new ValidationError(`jobs.${name}: unknown args field "${field}"`);
      }
    }
    return out;
  }

  private insertRow(
    store: JobsStore,
    row: {
      readonly name: string;
      readonly argsJson: string;
      readonly argsHash: string;
      readonly key: string | null;
      readonly runAt: number;
      readonly now: number;
    },
  ): Promise<bigint> {
    return store.insert({
      name: row.name,
      argsJson: row.argsJson,
      argsHash: row.argsHash,
      key: row.key,
      state: "pending",
      runAt: row.runAt,
      attempt: 0,
      attemptsJson: "[]",
      outputJson: null,
      leaseToken: null,
      leaseUntil: null,
      enqueuedAt: row.now,
      settledAt: null,
    });
  }

  /** A live (pending or running) row for this identity, if any. */
  private liveRow(store: JobsStore, name: string, argsHash: string): JobRow | null {
    return (
      store
        .byIdentity(name, argsHash)
        .find((row) => row.state === "pending" || row.state === "running") ?? null
    );
  }

  private dedupeRow(
    store: JobsStore,
    definition: AnyJob,
    name: string,
    argsHash: string,
    now: number,
  ): JobRow | null {
    const rows = store.byIdentity(name, argsHash);
    const live = rows.find((row) => row.state === "pending" || row.state === "running");
    if (live !== undefined) return live;
    const windows = definition.dedupe!;
    if (windows.completed === 0 && windows.discarded === 0) return null;
    let best: JobRow | null = null;
    for (const row of rows) {
      if (row.settledAt === null) continue;
      const window = row.state === "completed"
        ? windows.completed
        : row.state === "discarded"
          ? windows.discarded
          : 0;
      if (window === 0) continue;
      if (window !== "forever" && row.settledAt + window <= now) continue;
      if (best === null || row.settledAt > best.settledAt!) best = row;
    }
    return best;
  }

  private appendAttempt(
    row: JobRow,
    outcome: JobAttemptRecord["outcome"],
    error: unknown,
    startedAt = this.options.now(),
    settledAt = this.options.now(),
  ): string {
    let history: JobAttemptRecord[];
    try {
      history = JSON.parse(row.attemptsJson) as JobAttemptRecord[];
      if (!Array.isArray(history)) history = [];
    } catch {
      history = [];
    }
    history.push({
      startedAt,
      settledAt,
      outcome,
      error: error === null ? null : this.describeError(error),
      durationMs: Math.max(0, settledAt - startedAt),
    });
    return JSON.stringify(history);
  }

  private describeError(error: unknown): string {
    const text = isApplicationError(error)
      ? `${error.code}: ${stableEncode(error.body ?? null)}`
      : error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
    return text.length > MAX_STORED_ERROR_LENGTH
      ? `${text.slice(0, MAX_STORED_ERROR_LENGTH - 1)}…`
      : text;
  }

  private terminalOutcome(row: JobRow): JobAttemptOutcome | null {
    switch (row.state) {
      case "completed":
        return {
          ok: true,
          value: row.outputJson === null ? undefined : decode(row.outputJson),
        };
      case "discarded":
        return {
          ok: false,
          state: "discarded",
          error: new AckerDBError("unavailable", this.lastError(row) ?? "job was discarded"),
          nextRetryAt: null,
        };
      case "canceled":
        return {
          ok: false,
          state: "canceled",
          error: new AckerDBError("unavailable", "job was canceled"),
          nextRetryAt: null,
        };
      default:
        return null;
    }
  }

  private lastError(row: JobRow): string | null {
    try {
      const history = JSON.parse(row.attemptsJson) as JobAttemptRecord[];
      for (let index = history.length - 1; index >= 0; index--) {
        if (history[index]!.error !== null) return history[index]!.error;
      }
    } catch {
      /* recorded history is best-effort */
    }
    return null;
  }

  /** Post-commit delivery: waiters and telemetry see only committed settles. */
  private deliver(notifications: readonly Notification[]): void {
    for (const notification of notifications) {
      this.event(
        notification.event,
        notification.event === "settled" ? "info" : notification.event === "retried" ? "warn" : "error",
        notification.errorCode ?? "ok",
      );
      const set = this.waiters.get(notification.id);
      if (set === undefined) continue;
      this.waiters.delete(notification.id);
      for (const resolve of set) resolve(notification.outcome);
    }
  }

  private async readRow(id: bigint): Promise<JobRow | null> {
    return await this.options.reads.submit(
      (connection) => this.options.executor.readJobRow(connection, id),
      { operation: "query", bytes: 1, fairnessKey: "system:jobs" },
      false,
    );
  }

  private async nextDueAt(): Promise<number | null> {
    return await this.options.reads.submit(
      (connection) => this.options.executor.nextDueJobAt(connection),
      { operation: "scheduled", bytes: 1, fairnessKey: "system:jobs" },
      false,
    );
  }

  private recordGauges(): void {
    if (!this.options.telemetry.enabled) return;
    this.options.telemetry.recordMetric({
      name: "jobs.running",
      value: this.activeRuns,
      unit: "gauge",
    });
  }

  private event(
    name: "claimed" | "settled" | "retried" | "discarded" | "canceled" | "failure",
    level: "info" | "warn" | "error",
    outcome: OutcomeCode | "ok" = "ok",
  ): void {
    if (!this.options.telemetry.enabled) return;
    this.options.telemetry.recordEvent({
      name: `job_${name}`,
      level,
      operation: "scheduled",
      outcome,
    });
  }
}
