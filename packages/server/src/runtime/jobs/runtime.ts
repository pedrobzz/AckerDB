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
import { DEFAULT_JOB_RETENTION_MS, type AnyJob, type DeclaredJob, type JobState } from "../../jobs/definition.ts";
import { hashJobArgs } from "../../jobs/identity.ts";
import type { JobsWriteSurface } from "../execution/functions.ts";
import type { Registry } from "../../app/registry.ts";
import { JobSleepSignal, JobSteps, StepMismatchError } from "./steps.ts";
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
  nextDueJobAt(connection: Database, inProcessIds: readonly bigint[]): number | null;
  dueJobStats(connection: Database, now: number): { due: number; oldestDueAt: number | null };
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
  readonly stepsJson: string | null;
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
  readonly registry: Pick<Registry, "get">;
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
  readonly stepsJson: string | null;
  readonly attempt: number;
  readonly leaseToken: string;
}

interface Notification {
  readonly id: bigint;
  readonly outcome: JobAttemptOutcome;
  readonly event: "settled" | "retried" | "discarded" | "canceled" | "slept";
  readonly errorCode?: OutcomeCode;
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
  /**
   * True after a batch that claimed nothing: every due row is gated,
   * undeclared, or already running. Overdue-but-unclaimable work must not arm
   * a zero-delay timer — the commits that free it (settles, cancels, CRUD,
   * enqueues) and dispatch completions wake the runner instead.
   */
  private stalled = false;

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
          const argsJson = stableEncode({});
          const argsHash = hashJobArgs(argsJson);
          if (this.liveRow(surface.jobs, name, argsHash) !== null) continue;
          const at = definition.repeat!(now, now);
          if (at === null) continue;
          await this.insertRow(surface.jobs, { name, argsJson, argsHash, key: null, runAt: at, now });
        }
      }).catch((error) => {
        // Arming still proceeds and enqueues re-wake the runner, but the
        // failure leaves evidence.
        this.event("failure", "error", outcomeFromError(error).code);
      });
    }
    this.arm();
  }

  /** Commit-wake: called after any transaction that touched the jobs table. */
  arm(reason: "wake" | "requeue" = "wake"): void {
    if (reason === "wake") this.stalled = false;
    const generation = ++this.generation;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (!this.options.isReady() || this.definitions.size === 0) return;
    void this.nextDueAt().then(
      (at) => {
        if (!this.options.isReady() || generation !== this.generation) return;
        if (at === null) return;
        const now = this.options.now();
        if (at <= now && this.stalled) return; // overdue but unclaimable: wait for a wake
        const delay = Math.min(Math.max(0, at - now), 0x7fff_ffff);
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
    // Waiters must not hold admitted operations open until the drain
    // deadline: deliver a typed draining outcome now. The rows themselves are
    // durable — pending and running work resumes after restart.
    const stranded = [...this.waiters.keys()];
    for (const id of stranded) {
      this.notifyDirect(id, {
        ok: false,
        state: "pending",
        error: new AckerDBError("draining", "runtime is draining; the job resumes after restart"),
        nextRetryAt: null,
      });
    }
  }

  /** One single-flight batch: recover leases, claim due work, reap history. */
  run(): Promise<void> {
    if (this.running !== null) return this.running;
    const batch = this.batch().finally(() => {
      this.running = null;
      if (this.options.isReady()) this.arm("requeue");
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
    const argsJson = stableEncode(validated);
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
      let cursor: { runAt: number; id: bigint } | undefined;
      while (
        claims < claimBudget &&
        this.activeRuns < this.options.limits.maxRunning &&
        !signal.aborted
      ) {
        const next = await this.claimNext(signal, cursor);
        if (next === null) break;
        cursor = next.cursor;
        claims++;
        if (next.outcome !== "settled-inline") this.dispatch(next.outcome);
      }
      this.stalled = claims === 0;
      await this.reap(signal);
      await this.recordGauges();
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
   * Claim the next eligible due row at or beyond `cursor`. Mutation-kind rows
   * execute and settle in the same transaction; procedure-kind rows are
   * leased for dispatch. Pages past gate-saturated and undeclared rows so a
   * blocked prefix cannot starve eligible work behind it.
   */
  private async claimNext(
    signal: AbortSignal,
    cursor?: { runAt: number; id: bigint },
  ): Promise<
    | {
        outcome: ClaimedRow | "settled-inline";
        cursor: { runAt: number; id: bigint } | undefined;
      }
    | null
  > {
    type Page = { runAt: number; id: bigint } | undefined;
    type ClaimTxResult =
      | { readonly inline: Notification; readonly page: Page }
      | { readonly claimed: ClaimedRow; readonly page: Page }
      | null;
    const result = await this.options.executor.jobsWrite<ClaimTxResult>(signal, async (surface) => {
      const now = this.options.now();
      const runningByGate = new Map<string, number>();
      for (const row of surface.jobs.running()) {
        const gate = `${row.name}\u0000${row.key ?? ""}`;
        runningByGate.set(gate, (runningByGate.get(gate) ?? 0) + 1);
      }
      let page = cursor;
      for (;;) {
        const due = surface.jobs.due(now, this.options.limits.claimBatchSize, page);
        if (due.length === 0) return null;
        for (const row of due) {
          page = { runAt: row.runAt, id: row.id };
          const definition = this.definitions.get(row.name);
          if (definition === undefined) continue; // undeclared leftover; visible in the table
          const gate = `${row.name}\u0000${row.key ?? ""}`;
          if ((runningByGate.get(gate) ?? 0) >= definition.concurrency) continue;
          const attempt = row.attempt + 1;
          if (definition.kind === "mutation") {
            const inline = await this.runMutationJob(surface, row, definition, attempt);
            return { inline, page };
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
              stepsJson: row.stepsJson,
              attempt,
              leaseToken,
            },
            page,
          };
        }
        if (due.length < this.options.limits.claimBatchSize) return null;
      }
    });
    if (result === null) return null;
    if ("inline" in result) {
      this.deliver([result.inline]);
      this.event("claimed", "info");
      return { outcome: "settled-inline", cursor: result.page };
    }
    this.event("claimed", "info");
    return { outcome: result.claimed, cursor: result.page };
  }

  /**
   * Claim + handler + settle in one writer transaction: exactly-once. The
   * handler runs inside a savepoint, so its writes roll back on failure while
   * the same transaction still records the failed attempt — no window in
   * which a concurrent transition can observe the claim half-done.
   */
  private async runMutationJob(
    surface: JobsWriteSurface,
    row: JobRow,
    definition: AnyJob,
    attempt: number,
  ): Promise<Notification> {
    const startedAt = this.options.now();
    const args = decode(row.argsJson);
    const claimed: JobRow = { ...row, attempt };
    const savepoint = surface.savepoint();
    let failure: { error: unknown } | null = null;
    let value: unknown;
    let outputJson = "";
    try {
      value = await surface.runMutationHandler(row.name, attempt, (ctx) =>
        definition.handler(ctx as never, args as never));
      if (isResult(value) && !value.ok) {
        failure = { error: value.error };
      } else {
        value = isResult(value) ? value.data : value;
        outputJson = stableEncode(value); // an unencodable result fails the attempt whole
      }
    } catch (error) {
      failure = { error };
    }
    if (failure !== null) {
      savepoint.rollback();
      return await this.settleFailureIn(surface, claimed, failure.error, startedAt);
    }
    savepoint.release();
    return await this.settleSuccessIn(surface, claimed, value, startedAt, outputJson);
  }

  /** Procedure-kind dispatch: run as a system operation, then settle. */
  private dispatch(claimed: ClaimedRow): void {
    const definition = this.definitions.get(claimed.name)!;
    const controller = new AbortController();
    this.runControllers.set(claimed.id, controller);
    this.activeRuns++;
    const startedAt = this.options.now();
    let args: unknown;
    try {
      args = decode(claimed.argsJson);
    } catch (error) {
      // A row whose stored args no longer decode fails through the ordinary
      // settle path; the slot and controller are released either way.
      void this.settle(claimed, { ok: false, error }, startedAt).finally(() => {
        this.activeRuns--;
        this.runControllers.delete(claimed.id);
        if (this.options.isReady()) this.arm();
      });
      return;
    }
    const steps = new JobSteps({
      id: claimed.id,
      jobName: claimed.name,
      attempt: claimed.attempt,
      leaseToken: claimed.leaseToken,
      stepsJson: claimed.stepsJson,
      executor: this.options.executor,
      registry: this.options.registry,
      signal: controller.signal,
      now: this.options.now,
    });
    void this.options.system
      .run(
        `jobs.${claimed.name}`,
        async (ctx: SystemCtx) => {
          const context = Object.freeze({
            ...ctx,
            attempt: claimed.attempt,
            step: steps.surface(ctx),
          });
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
        (error) =>
          error instanceof JobSleepSignal
            ? this.settleSleep(claimed, error.wakeAt)
            : this.settle(claimed, { ok: false, error }, startedAt),
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

  /**
   * A sleeping attempt settles back to pending at its wake time with no
   * attempt increment: sleeping is not failing, and retry budget is
   * untouched. Waiters resolve now — a caller must not block for the wake.
   */
  private async settleSleep(claimed: ClaimedRow, wakeAt: number): Promise<void> {
    try {
      const notification = await this.options.executor.jobsWrite(
        this.options.signal(),
        async (surface): Promise<Notification | null> => {
          const row = surface.jobs.byId(claimed.id);
          if (row === null || row.state !== "running" || row.leaseToken !== claimed.leaseToken) {
            return null; // canceled, reclaimed, or deleted while running: the row moved on
          }
          await surface.jobs.patch(claimed.id, {
            state: "pending",
            runAt: wakeAt,
            attempt: claimed.attempt - 1,
            leaseToken: null,
            leaseUntil: null,
          });
          return {
            id: claimed.id,
            event: "slept",
            outcome: {
              ok: false,
              state: "pending",
              error: new AckerDBError("unavailable", "job is sleeping; the run resumes at its wake time"),
              nextRetryAt: wakeAt,
            },
          };
        },
      );
      this.deliver(notification === null ? [] : [notification]);
    } catch (error) {
      // Shutdown or a failed settle commit: the lease expires and recovery
      // re-runs the attempt; the journaled sleep re-suspends it.
      this.event("failure", "error", outcomeFromError(error).code);
    }
  }

  private async settleSuccessIn(
    surface: JobsWriteSurface,
    row: JobRow,
    value: unknown,
    startedAt = this.options.now(),
    encodedOutput?: string,
  ): Promise<Notification> {
    const now = this.options.now();
    let outputJson: string;
    try {
      outputJson = encodedOutput ?? stableEncode(value);
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
    // A journal/code mismatch discards without consulting the retry policy:
    // retrying into unchanged code cannot fix code (ADR-0022).
    if (definition !== undefined && !(error instanceof StepMismatchError)) {
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

  /**
   * Delete terminal rows past their definition's effective retention. Reads
   * are targeted per definition and state, so forever-retained rows can never
   * shadow finite-retention rows behind them.
   */
  private async reap(signal: AbortSignal): Promise<void> {
    const now = this.options.now();
    if (now - this.lastReapAt < REAP_INTERVAL_MS) return;
    this.lastReapAt = now;
    const limit = this.options.limits.claimBatchSize;
    await this.options.executor.jobsWrite(signal, async (surface) => {
      for (const state of ["completed", "discarded", "canceled"] as const) {
        for (const [name, definition] of this.definitions) {
          const retention = this.effectiveRetention(definition, state);
          if (retention === "forever") continue;
          for (const row of surface.jobs.settledBefore(name, state, now - retention, limit)) {
            await surface.jobs.delete(row.id);
          }
        }
        // Rows of no-longer-declared jobs keep the default retention.
        for (const row of surface.jobs.settledBeforeExcluding(
          this.declaredNames,
          state,
          now - DEFAULT_JOB_RETENTION_MS,
          limit,
        )) {
          await surface.jobs.delete(row.id);
        }
      }
    });
  }

  private effectiveRetention(
    definition: AnyJob | undefined,
    state: JobState,
  ): number | "forever" {
    // Rows of a no-longer-declared job keep the default retention: deleting a
    // definition must not silently erase its history at the next sweep.
    if (definition === undefined) return DEFAULT_JOB_RETENTION_MS;
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
      stepsJson: "[]",
      outputJson: null,
      leaseToken: null,
      leaseUntil: null,
      enqueuedAt: row.now,
      settledAt: null,
    });
  }

  /** A live (pending or running) row for this identity, if any. */
  private liveRow(store: JobsStore, name: string, argsHash: string): JobRow | null {
    return store.liveRowFor(name, argsHash);
  }

  private dedupeRow(
    store: JobsStore,
    definition: AnyJob,
    name: string,
    argsHash: string,
    now: number,
  ): JobRow | null {
    const live = store.liveRowFor(name, argsHash);
    if (live !== null) return live;
    const windows = definition.dedupe!;
    let best: JobRow | null = null;
    for (const state of ["completed", "discarded"] as const) {
      const window = windows[state];
      if (window === 0) continue;
      const row = store.newestSettledFor(name, argsHash, state);
      if (row === null || row.settledAt === null) continue;
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
    const code = (error as { readonly code?: unknown }).code;
    const text = isApplicationError(error)
      ? `${error.code}: ${stableEncode(error.body ?? null)}`
      : error instanceof Error
        ? `${error.name}${typeof code === "string" ? `(${code})` : ""}: ${error.message}`
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

  private notifyDirect(id: bigint, outcome: JobAttemptOutcome): void {
    const set = this.waiters.get(id);
    if (set === undefined) return;
    this.waiters.delete(id);
    for (const resolve of set) resolve(outcome);
  }

  /** Post-commit delivery: waiters and telemetry see only committed settles. */
  private deliver(notifications: readonly Notification[]): void {
    for (const notification of notifications) {
      this.event(
        notification.event,
        notification.event === "settled" || notification.event === "slept"
          ? "info"
          : notification.event === "retried"
            ? "warn"
            : "error",
        notification.errorCode ?? "ok",
      );
      this.notifyDirect(notification.id, notification.outcome);
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
    const inProcessIds = [...this.runControllers.keys()];
    return await this.options.reads.submit(
      (connection) => this.options.executor.nextDueJobAt(connection, inProcessIds),
      { operation: "scheduled", bytes: 1, fairnessKey: "system:jobs" },
      false,
    );
  }

  private async recordGauges(): Promise<void> {
    if (!this.options.telemetry.enabled) return;
    this.options.telemetry.recordMetric({
      name: "jobs.running",
      value: this.activeRuns,
      unit: "gauge",
    });
    const now = this.options.now();
    const backlog = await this.options.reads.submit(
      (connection) => this.options.executor.dueJobStats(connection, now),
      { operation: "scheduled", bytes: 1, fairnessKey: "system:jobs" },
      false,
    );
    this.options.telemetry.recordMetric({
      name: "jobs.due_backlog",
      value: backlog.due,
      unit: "gauge",
    });
    this.options.telemetry.recordMetric({
      name: "jobs.oldest_due_age_ms",
      value: backlog.oldestDueAt === null ? 0 : Math.max(0, now - backlog.oldestDueAt),
      unit: "gauge",
    });
  }

  private event(
    name: "claimed" | "settled" | "retried" | "discarded" | "canceled" | "slept" | "failure",
    level: "info" | "warn" | "error",
    outcome: OutcomeCode | "ok" = "ok",
  ): void {
    if (!this.options.telemetry.enabled) return;
    this.options.telemetry.recordEvent({
      name: `job_${name}`,
      level,
      operation: "job",
      outcome,
    });
  }
}
