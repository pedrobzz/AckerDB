/**
 * The job runner: owns the Job / Job run state machine end to end — arming,
 * claiming, executing, settling, recurrence, lease recovery, retention — on
 * top of the same commit machinery every mutation uses.
 *
 * A Job is the durable admission; a Job run is one actual handler execution.
 * The claim is what creates a run, so a Job waiting for its due time has no
 * invented run and a dedupe hit — which executes no handler — writes nothing
 * at all. `runCount` is both how many runs exist and the latest run's number,
 * so the Job needs no pointer that could reference a run of another Job.
 *
 * Execution envelopes, by declared kind:
 * - mutation-kind: claim, handler, and settle collapse into one writer
 *   transaction — exactly-once, no external I/O. A failed handler rolls the
 *   whole transaction back; the failed run is then recorded in a fresh
 *   transaction, so no partial handler write can survive.
 * - procedure-kind: a claim transaction creates the run under a lease, the
 *   handler runs as a system operation (external work allowed), and a settle
 *   transaction re-validates the run and its lease before recording the
 *   outcome — at-least-once under retries; a stale lease means the run moved on
 *   and the result is discarded, never double-settled.
 *
 * Waiters resolve at the *current run's* settle — after its transaction
 * commits — and a failed run reports `nextRetryAt` so the caller decides
 * whether to keep waiting.
 */
import { decode, isApplicationError, isResult, stableEncode, type OutcomeCode } from "@ackerdb/core";
import type { SystemCtx, SystemRunner } from "../../app/system.ts";
import { AckerDBError } from "../../shared/errors.ts";
import { ValidationError } from "../../validation/error.ts";
import {
  DEFAULT_JOB_RETENTION_MS,
  type AnyJob,
  type DeclaredJob,
  type JobRunTrigger,
  type JobState,
  type JobTrigger,
  type JobWindow,
} from "../../jobs/definition.ts";
import { hashJobArgs } from "../../jobs/identity.ts";
import type { JobsWriteSurface } from "../execution/functions.ts";
import type { Registry } from "../../app/registry.ts";
import { JobSleepSignal, JobSteps, StepRefusalError } from "./steps.ts";
import type { JobCursor, JobRow, JobRunRow, JobsStore } from "./store.ts";
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
  readJobRunRow(connection: Database, jobId: bigint, number: number): JobRunRow | null;
  nextDueJobAt(
    connection: Database,
    inProcessIds: readonly bigint[],
    notBefore: number,
  ): number | null;
}

const LEASE_EXPIRED = "job lease expired before the run settled";
const MAX_STORED_ERROR_LENGTH = 512;
const REAP_INTERVAL_MS = 60_000;
/** Runs deleted with their Job in one sweep; a Job's history is small by construction. */
const CASCADE_BATCH = 512;

/** What one settled run reports to awaiting callers. */
export type JobRunOutcome =
  | { readonly ok: true; readonly value: unknown }
  | {
      readonly ok: false;
      readonly state: "pending" | "retrying" | "failed" | "canceled";
      readonly error: unknown;
      /** When the next run is due, or null when the Job will not run again. */
      readonly nextRetryAt: number | null;
    };

export interface JobEnqueueOptions {
  readonly at?: number;
  readonly delayMs?: number;
}

export interface JobHandle {
  readonly id: bigint;
  /** True when dedupe resolved this call to an existing Job. */
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
  readonly limits: RuntimeJobsLimits;
  readonly now: () => number;
  readonly signal: () => AbortSignal;
  readonly isReady: () => boolean;
}

/** One claimed run, handed to the procedure-kind dispatcher. */
interface ClaimedRun {
  readonly jobId: bigint;
  readonly runId: bigint;
  readonly name: string;
  readonly argsJson: string;
  readonly stepsJson: string | null;
  readonly runNumber: number;
  readonly leaseToken: string;
  readonly startedAt: number;
}

interface Notification {
  readonly id: bigint;
  readonly outcome: JobRunOutcome;
  readonly event: "settled" | "retried" | "failed" | "canceled" | "slept";
  readonly errorCode?: OutcomeCode;
}

/** What a terminal settlement records on the Job and its current run. */
type TerminalOutcome =
  | { readonly state: "completed"; readonly outputJson: string }
  | { readonly state: "failed"; readonly error: unknown }
  | { readonly state: "canceled" };

/** A run under the lease that just claimed it. */
type LeasedRun = JobRunRow & { readonly leaseToken: string };

/** A Job and the run its outcome is read from, if it has one. */
interface JobOutcomeRows {
  readonly job: JobRow;
  readonly run: JobRunRow | null;
}

export class RuntimeJobs {
  private readonly definitions = new Map<string, AnyJob>();
  private readonly waiters = new Map<bigint, Set<(outcome: JobRunOutcome) => void>>();
  private readonly runControllers = new Map<bigint, AbortController>();
  private activeRuns = 0;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private leaseCounter = 0;
  private lastReapAt = 0;
  /**
   * True after a batch that claimed nothing: every due Job is gated,
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
          if (surface.jobs.liveFor(name, argsHash) !== null) continue;
          const at = definition.repeat!(now, now);
          if (at === null) continue;
          await this.insertJob(surface.jobs, {
            name,
            argsJson,
            argsHash,
            key: null,
            at,
            now,
            trigger: "repeat",
            parentJobId: null,
          });
        }
      }).catch((error) => {
        console.log("job bootstrap failed", {
          outcome: outcomeFromError(error).code,
        });
      });
    }
    this.arm();
  }

  /** Commit-wake: called after any transaction that touched the jobs tables. */
  arm(reason: "wake" | "requeue" = "wake"): void {
    if (reason === "wake") this.stalled = false;
    const generation = ++this.generation;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    // No short-circuit on an empty definition list: an application that
    // removed a job definition still owns the rows it left behind, and their
    // retention is still a promise.
    if (!this.options.isReady()) return;
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
    // deadline: deliver a typed draining outcome now. The Jobs themselves are
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
   * Admit one Job (or resolve to an existing one under dedupe) inside an
   * already-open transaction — the transactional-enqueue seam mutations use.
   * A dedupe hit performs no write: no handler runs, so nothing about the
   * existing Job changes.
   */
  async enqueueWith(
    store: JobsStore,
    name: string,
    args: unknown,
    options: JobEnqueueOptions = {},
    trigger: JobTrigger = "enqueue",
  ): Promise<JobHandle> {
    const definition = this.definition(name);
    const validated = this.validateArgs(definition, name, args);
    const argsJson = stableEncode(validated);
    const argsHash = hashJobArgs(argsJson);
    const now = this.options.now();
    if (definition.dedupe !== null) {
      const existing = this.dedupeJob(store, definition, name, argsHash, now);
      if (existing !== null) return { id: existing.id, deduped: true };
    }
    const at = options.at ?? (options.delayMs !== undefined ? now + options.delayMs : now);
    if (typeof at !== "number" || !Number.isFinite(at)) {
      throw new ValidationError(`jobs.${name}: enqueue at/delayMs must be finite milliseconds`);
    }
    const key = definition.key === null ? null : String(definition.key(validated as never));
    const id = await this.insertJob(store, {
      name,
      argsJson,
      argsHash,
      key,
      at,
      now,
      trigger,
      parentJobId: null,
    });
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
   * Resolve when the Job's current run settles. An already terminal Job —
   * including a dedupe hit inside a completed window — resolves immediately
   * from its latest run's recorded outcome.
   */
  async wait(id: bigint): Promise<JobRunOutcome> {
    if (typeof id !== "bigint") {
      throw new ValidationError("jobs.wait: expected a bigint job id");
    }
    let resolver: ((outcome: JobRunOutcome) => void) | null = null;
    const pending = new Promise<JobRunOutcome>((resolve) => {
      resolver = resolve;
      let set = this.waiters.get(id);
      if (set === undefined) this.waiters.set(id, (set = new Set()));
      set.add(resolve);
    });
    // Read after registering, so a settle between read and registration
    // cannot be missed; a terminal Job resolves from its recorded outcome.
    const rows = await this.readOutcome(id);
    const unregister = () => {
      const set = this.waiters.get(id);
      if (set !== undefined && resolver !== null) {
        set.delete(resolver);
        if (set.size === 0) this.waiters.delete(id);
      }
    };
    if (rows === null) {
      unregister();
      throw new AckerDBError("not_found", `job ${id} does not exist`);
    }
    const terminal = this.terminalOutcome(rows);
    if (terminal !== null) {
      unregister();
      return terminal;
    }
    return pending;
  }

  // -- Transitions -----------------------------------------------------------

  /**
   * Cancel: settles a non-terminal Job. A run in flight — including one
   * suspended by `step.sleep` — settles as canceled, and a running handler is
   * aborted cooperatively.
   */
  async cancel(id: bigint): Promise<JobState> {
    const state = await this.options.executor.jobsWrite(this.options.signal(), async (surface) => {
      const job = this.requireJob(surface, id, "cancel");
      if (this.isTerminal(job.state)) return job.state;
      const run = job.runCount === 0 ? null : surface.runs.byNumber(id, job.runCount);
      await this.settleJobIn(surface, job, run, { state: "canceled" });
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

  /** Manual retry: give a Failed Job another run, keeping identity and journal. */
  async retry(id: bigint): Promise<void> {
    await this.options.executor.jobsWrite(this.options.signal(), async (surface) => {
      const job = this.requireJob(surface, id, "retry");
      if (job.state !== "failed") {
        throw new AckerDBError("conflict", `job ${id} is ${job.state}; only failed jobs retry`);
      }
      await this.reopen(surface, job, { nextRunTrigger: "manual_retry", state: "retrying" });
    });
  }

  /**
   * Force run again: give a terminal Job another run under the same identity,
   * so its new outcome is the one future dedupe hits receive. The step journal
   * is cleared — replaying a completed journal would produce no work at all,
   * which is the opposite of what forcing a run means.
   */
  async forceRunAgain(id: bigint): Promise<void> {
    await this.options.executor.jobsWrite(this.options.signal(), async (surface) => {
      const job = this.requireJob(surface, id, "forceRunAgain");
      if (!this.isTerminal(job.state)) {
        throw new AckerDBError(
          "conflict",
          `job ${id} is ${job.state}; only terminal jobs are forced to run again`,
        );
      }
      await this.reopen(surface, job, {
        nextRunTrigger: "force",
        state: "pending",
        stepsJson: "[]",
      });
    });
  }

  /**
   * Give a terminal Job another run. Its previous latest run stops being the
   * Job's outcome the moment the next one opens, so it is restamped down to
   * the definition's plain retention: the dedupe-extended stamp it settled
   * with — possibly forever — would keep history no dedupe hit can ever reach
   * again.
   */
  private async reopen(
    surface: JobsWriteSurface,
    job: JobRow,
    intent: {
      readonly state: "pending" | "retrying";
      readonly nextRunTrigger: JobRunTrigger;
      readonly stepsJson?: string;
    },
  ): Promise<void> {
    const now = this.options.now();
    const previous = job.runCount === 0 ? null : surface.runs.byNumber(job.id, job.runCount);
    if (previous !== null && previous.settledAt !== null) {
      const definition = this.definitions.get(job.name);
      await surface.runs.patch(previous.id, {
        deleteAfter: this.window(
          definition?.retention ?? DEFAULT_JOB_RETENTION_MS,
          previous.settledAt,
        ),
      });
    }
    await surface.jobs.patch(job.id, {
      ...intent,
      nextRunAt: now,
      settledAt: null,
      deleteAfter: null,
    });
  }

  /**
   * Run again: submit a terminal Job's arguments through its definition again.
   * Ordinary dedupe applies, so this may resolve to an existing Job and its
   * memoized outcome without executing anything.
   */
  async runAgain(id: bigint): Promise<JobHandle> {
    return await this.options.executor.jobsWrite(this.options.signal(), async (surface) => {
      const job = this.requireJob(surface, id, "runAgain");
      if (!this.isTerminal(job.state)) {
        throw new AckerDBError(
          "conflict",
          `job ${id} is ${job.state}; only terminal jobs are run again`,
        );
      }
      return await this.enqueueWith(
        surface.jobs,
        job.name,
        decode(job.argsJson),
        {},
        "run_again",
      );
    });
  }

  /** Delete a Job together with every run it owns; the destructive action. */
  async delete(id: bigint): Promise<void> {
    await this.options.executor.jobsWrite(this.options.signal(), async (surface) => {
      const job = this.requireJob(surface, id, "delete");
      await this.deleteWithRuns(surface, job.id);
    });
  }

  /** Move a Job's next run time; only a Job that has one accepts it. */
  async reschedule(id: bigint, at: number): Promise<void> {
    if (typeof at !== "number" || !Number.isFinite(at)) {
      throw new ValidationError("jobs.reschedule: expected finite milliseconds");
    }
    await this.options.executor.jobsWrite(this.options.signal(), async (surface) => {
      const job = this.requireJob(surface, id, "reschedule");
      if (job.state !== "pending" && job.state !== "retrying") {
        throw new AckerDBError(
          "conflict",
          `job ${id} is ${job.state}; only jobs awaiting a run reschedule`,
        );
      }
      await surface.jobs.patch(id, { nextRunAt: at });
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
      let cursor: JobCursor | undefined;
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
      // Stalled means "nothing this runner can do", not "nothing claimable":
      // a reap that filled its page still has work waiting behind it, and a
      // page of runs alone wakes nothing on commit.
      this.stalled = claims === 0 && !(await this.reap(signal));
    } catch (error) {
      console.log("job batch failed", {
        outcome: outcomeFromError(error).code,
      });
    }
  }

  /**
   * Recover crashed runs: a running run whose lease expired settles as a
   * failed run through the ordinary retry policy. Runs with a live in-process
   * handler are skipped — their settle owns them. A run suspended by
   * `step.sleep` holds no lease, so it is never mistaken for a crash.
   */
  private async recoverExpiredLeases(signal: AbortSignal): Promise<void> {
    const now = this.options.now();
    const notifications = await this.options.executor.jobsWrite(signal, async (surface) => {
      const delivered: Notification[] = [];
      for (const run of surface.runs.expiredLeases(now, this.options.limits.claimBatchSize)) {
        if (this.runControllers.has(run.jobId)) continue;
        const job = surface.jobs.byId(run.jobId);
        if (job === null) continue; // the Job was deleted; its runs go with it
        delivered.push(
          await this.settleFailureIn(
            surface,
            job,
            run,
            new AckerDBError("unavailable", LEASE_EXPIRED),
          ),
        );
      }
      return delivered;
    });
    this.deliver(notifications);
  }

  /**
   * Claim the next eligible due Job at or beyond `cursor`. Mutation-kind Jobs
   * execute and settle in the same transaction; procedure-kind Jobs get a
   * leased run for dispatch. Pages past gate-saturated and undeclared Jobs so
   * a blocked prefix cannot starve eligible work behind it.
   */
  private async claimNext(
    signal: AbortSignal,
    cursor?: JobCursor,
  ): Promise<
    | { outcome: ClaimedRun | "settled-inline"; cursor: JobCursor | undefined }
    | null
  > {
    type Page = JobCursor | undefined;
    type ClaimTxResult =
      | { readonly inline: Notification; readonly page: Page }
      | { readonly claimed: ClaimedRun; readonly page: Page }
      | null;
    const result = await this.options.executor.jobsWrite<ClaimTxResult>(signal, async (surface) => {
      const now = this.options.now();
      const runningByGate = new Map<string, number>();
      for (const job of surface.jobs.running()) {
        const gate = `${job.name}\u0000${job.key ?? ""}`;
        runningByGate.set(gate, (runningByGate.get(gate) ?? 0) + 1);
      }
      let page = cursor;
      for (;;) {
        const due = surface.jobs.due(now, this.options.limits.claimBatchSize, page);
        if (due.length === 0) return null;
        for (const job of due) {
          page = { nextRunAt: job.nextRunAt, id: job.id };
          const definition = this.definitions.get(job.name);
          if (definition === undefined) continue; // undeclared leftover; visible in the table
          const gate = `${job.name}\u0000${job.key ?? ""}`;
          if ((runningByGate.get(gate) ?? 0) >= definition.concurrency) continue;
          const run = await this.openRun(surface, job, now);
          if (definition.kind === "mutation") {
            const inline = await this.runMutationJob(surface, job, run, definition);
            return { inline, page };
          }
          return {
            claimed: {
              jobId: job.id,
              runId: run.id,
              name: job.name,
              argsJson: job.argsJson,
              stepsJson: job.stepsJson,
              runNumber: run.number,
              leaseToken: run.leaseToken,
              startedAt: run.startedAt,
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
      return { outcome: "settled-inline", cursor: result.page };
    }
    return { outcome: result.claimed, cursor: result.page };
  }

  /**
   * The claim itself: create the Job's next run, or re-lease the one a
   * `step.sleep` suspended. A suspended run is exactly a pending Job with runs
   * behind it and no administrator-requested trigger waiting — resuming it is
   * what keeps sleeping out of the retry budget.
   */
  private async openRun(
    surface: JobsWriteSurface,
    job: JobRow,
    now: number,
  ): Promise<LeasedRun> {
    const leaseToken = `${now.toString(36)}-${(++this.leaseCounter).toString(36)}`;
    const leaseUntil = now + this.options.limits.leaseMs;
    const resuming =
      job.state === "pending" && job.runCount > 0 && job.nextRunTrigger === null;
    const suspended = resuming ? surface.runs.byNumber(job.id, job.runCount) : null;
    let run: LeasedRun;
    if (suspended !== null && suspended.state === "running") {
      await surface.runs.patch(suspended.id, { leaseToken, leaseUntil });
      run = { ...suspended, leaseToken, leaseUntil };
    } else {
      const fresh = {
        jobId: job.id,
        number: job.runCount + 1,
        trigger: job.nextRunTrigger ?? (job.runCount === 0 ? "initial" : "automatic_retry"),
        scheduledAt: job.nextRunAt,
        startedAt: now,
        settledAt: null,
        state: "running",
        outputJson: null,
        errorCode: null,
        errorText: null,
        leaseToken,
        leaseUntil,
        deleteAfter: null,
      } satisfies Omit<JobRunRow, "id">;
      run = { ...fresh, id: await surface.runs.insert(fresh) };
    }
    await surface.jobs.patch(job.id, {
      state: "running",
      runCount: run.number,
      nextRunTrigger: null,
    });
    return run;
  }

  /**
   * Claim + handler + settle in one writer transaction: exactly-once. The
   * handler runs inside a savepoint, so its writes roll back on failure while
   * the same transaction still records the failed run — no window in which a
   * concurrent transition can observe the claim half-done.
   */
  private async runMutationJob(
    surface: JobsWriteSurface,
    job: JobRow,
    run: JobRunRow,
    definition: AnyJob,
  ): Promise<Notification> {
    const savepoint = surface.savepoint();
    let failure: { error: unknown } | null = null;
    let value: unknown;
    let outputJson = "";
    try {
      // Decoding belongs inside the caught boundary, with the savepoint already
      // open. Stored arguments that no longer decode are a failed run like any
      // other failure; decoding before the boundary would instead throw out of
      // the claim transaction, roll the claim back, and leave the Job due — to
      // be claimed and thrown out of again, forever, with nothing recorded. A
      // job that cannot run must say so once, durably, not spin.
      const args = decode(job.argsJson);
      value = await surface.runMutationHandler(job.name, run.number, (ctx) =>
        definition.handler(ctx as never, args as never));
      if (isResult(value) && !value.ok) {
        failure = { error: value.error };
      } else {
        value = isResult(value) ? value.data : value;
        outputJson = stableEncode(value); // an unencodable result fails the run whole
      }
    } catch (error) {
      failure = { error };
    }
    if (failure !== null) {
      savepoint.rollback();
      return await this.settleFailureIn(surface, job, run, failure.error);
    }
    savepoint.release();
    return await this.settleSuccessIn(surface, job, run, value, outputJson);
  }

  /** Procedure-kind dispatch: run as a system operation, then settle. */
  private dispatch(claimed: ClaimedRun): void {
    const definition = this.definitions.get(claimed.name)!;
    const controller = new AbortController();
    this.runControllers.set(claimed.jobId, controller);
    this.activeRuns++;
    let args: unknown;
    try {
      args = decode(claimed.argsJson);
    } catch (error) {
      // A Job whose stored args no longer decode fails through the ordinary
      // settle path; the slot and controller are released either way.
      void this.settle(claimed, { ok: false, error }).finally(() => {
        this.releaseRun(claimed.jobId, controller);
      });
      return;
    }
    const steps = new JobSteps({
      jobId: claimed.jobId,
      runId: claimed.runId,
      jobName: claimed.name,
      runNumber: claimed.runNumber,
      leaseToken: claimed.leaseToken,
      stepsJson: claimed.stepsJson,
      executor: this.options.executor,
      registry: this.options.registry,
      signal: controller.signal,
      now: this.options.now,
      // The suspend itself committed inside step.sleep's own transaction;
      // this is the post-commit notification to waiters.
      onSlept: (wakeAt) =>
        this.deliver([{
          id: claimed.jobId,
          event: "slept",
          outcome: {
            ok: false,
            state: "pending",
            error: new AckerDBError("unavailable", "job is sleeping; the run resumes at its wake time"),
            nextRetryAt: wakeAt,
          },
        }]),
    });
    void this.options.system
      .run(
        `jobs.${claimed.name}`,
        async (ctx: SystemCtx) => {
          const context = Object.freeze({
            ...ctx,
            runNumber: claimed.runNumber,
            step: steps.surface(ctx),
          });
          return await definition.handler(context as never, args as never);
        },
        { signal: controller.signal },
      )
      .then(
        (value) =>
          isResult(value) && !value.ok
            ? this.settle(claimed, { ok: false, error: value.error })
            : this.settle(claimed, { ok: true, value: isResult(value) ? value.data : value }),
        (error) =>
          // A sleep already settled atomically inside step.sleep; the signal
          // only unwound the handler. Anything else settles as a failure.
          error instanceof JobSleepSignal
            ? undefined
            : this.settle(claimed, { ok: false, error }),
      )
      .finally(() => {
        this.releaseRun(claimed.jobId, controller);
      });
  }

  /**
   * Release the slot one dispatch held. The controller is compared, not
   * assumed: a canceled Job that is forced to run again can put a second run in
   * flight while the first handler is still unwinding, and the newer run must
   * keep the entry that cancel and the wake calculation reach for.
   */
  private releaseRun(jobId: bigint, controller: AbortController): void {
    this.activeRuns--;
    if (this.runControllers.get(jobId) === controller) this.runControllers.delete(jobId);
    if (this.options.isReady()) this.arm();
  }

  /** The settle transaction: re-validate the run and its lease, then record. */
  private async settle(
    claimed: ClaimedRun,
    outcome: { ok: true; value: unknown } | { ok: false; error: unknown },
  ): Promise<void> {
    try {
      const notification = await this.options.executor.jobsWrite(
        this.options.signal(),
        async (surface) => {
          const run = surface.runs.byId(claimed.runId);
          const job = surface.jobs.byId(claimed.jobId);
          if (
            run === null ||
            job === null ||
            run.state !== "running" ||
            run.leaseToken !== claimed.leaseToken
          ) {
            return null; // canceled, resumed, or deleted while running: the run moved on
          }
          return outcome.ok
            ? await this.settleSuccessIn(surface, job, run, outcome.value)
            : await this.settleFailureIn(surface, job, run, outcome.error);
        },
      );
      this.deliver(notification === null ? [] : [notification]);
    } catch (error) {
      // Shutdown or a failed settle commit: the lease expires and recovery
      // re-runs the run — at-least-once, as declared.
      console.log("job settlement failed", {
        outcome: outcomeFromError(error).code,
      });
    }
  }

  /**
   * The one way a Job reaches a terminal state: its current run records the
   * outcome, the Job records the same instant and retention stamp, and the
   * repeat policy mints the next occurrence. Cancel goes through it too — an
   * operator ending one occurrence does not end the recurrence — and every
   * caller therefore stamps retention the same way, in one transaction.
   */
  private async settleJobIn(
    surface: JobsWriteSurface,
    job: JobRow,
    run: JobRunRow | null,
    outcome: TerminalOutcome,
  ): Promise<void> {
    const now = this.options.now();
    const deleteAfter = this.retentionStamp(this.definitions.get(job.name), outcome.state, now);
    // A Job with no run, or whose latest run already settled, records only its
    // own end: cancel before the claim invents no run.
    if (run !== null && run.state === "running") {
      await surface.runs.patch(run.id, {
        state: outcome.state,
        settledAt: now,
        outputJson: outcome.state === "completed" ? outcome.outputJson : null,
        errorCode: outcome.state === "failed" ? outcomeFromError(outcome.error).code : null,
        errorText: outcome.state === "failed" ? this.describeError(outcome.error) : null,
        leaseToken: null,
        leaseUntil: null,
        deleteAfter,
      });
    }
    await surface.jobs.patch(job.id, {
      state: outcome.state,
      nextRunTrigger: null,
      settledAt: now,
      deleteAfter,
    });
    await this.mintRepeat(surface, job, now);
  }

  private async settleSuccessIn(
    surface: JobsWriteSurface,
    job: JobRow,
    run: JobRunRow,
    value: unknown,
    encodedOutput?: string,
  ): Promise<Notification> {
    let outputJson: string;
    try {
      outputJson = encodedOutput ?? stableEncode(value);
    } catch (error) {
      return await this.settleFailureIn(surface, job, run, error);
    }
    await this.settleJobIn(surface, job, run, { state: "completed", outputJson });
    return { id: job.id, event: "settled", outcome: { ok: true, value } };
  }

  private async settleFailureIn(
    surface: JobsWriteSurface,
    job: JobRow,
    run: JobRunRow,
    error: unknown,
  ): Promise<Notification> {
    const definition = this.definitions.get(job.name);
    const now = this.options.now();
    let delay: number | null = null;
    // A step refusal — journal/code mismatch, corrupt journal, or exhausted
    // journal bounds — fails without consulting the retry policy: retrying
    // into unchanged code cannot fix code (ADR-0022).
    if (definition !== undefined && !(error instanceof StepRefusalError)) {
      try {
        delay = definition.retry(run.number, error);
      } catch {
        delay = null; // a throwing retry policy fails the Job, never wedges it
      }
    }
    if (delay !== null && (typeof delay !== "number" || !Number.isFinite(delay) || delay < 0)) {
      delay = null;
    }
    const code = outcomeFromError(error).code;
    if (delay !== null) {
      const nextRetryAt = now + delay;
      await surface.runs.patch(run.id, {
        state: "failed",
        settledAt: now,
        errorCode: code,
        errorText: this.describeError(error),
        leaseToken: null,
        leaseUntil: null,
        // A failed run of a Job that is still alive expires on the definition's
        // plain retention, so a long retry chain cannot grow history forever.
        deleteAfter: this.window(definition?.retention ?? DEFAULT_JOB_RETENTION_MS, now),
      });
      await surface.jobs.patch(job.id, {
        state: "retrying",
        nextRunAt: nextRetryAt,
        nextRunTrigger: null,
      });
      return {
        id: job.id,
        event: "retried",
        errorCode: code,
        outcome: { ok: false, state: "retrying", error, nextRetryAt },
      };
    }
    await this.settleJobIn(surface, job, run, { state: "failed", error });
    return {
      id: job.id,
      event: "failed",
      errorCode: code,
      outcome: { ok: false, state: "failed", error, nextRetryAt: null },
    };
  }

  /**
   * Recurrence is framework-owned: the next occurrence is a fresh Job linked
   * to the one that just settled. It is computed from the admitted occurrence,
   * not from the last retry, so retries cannot drag a schedule forward.
   */
  private async mintRepeat(surface: JobsWriteSurface, job: JobRow, now: number): Promise<void> {
    const definition = this.definitions.get(job.name);
    if (definition === undefined || definition.repeat === null) return;
    let at: number | null;
    try {
      at = definition.repeat(job.scheduledAt, now);
    } catch {
      return; // a throwing repeat rule ends the recurrence
    }
    if (at === null) return;
    if (typeof at !== "number" || !Number.isFinite(at)) return;
    if (surface.jobs.liveFor(job.name, job.argsHash) !== null) return;
    await this.insertJob(surface.jobs, {
      name: job.name,
      argsJson: job.argsJson,
      argsHash: job.argsHash,
      key: job.key,
      at,
      now,
      trigger: "repeat",
      parentJobId: job.id,
    });
  }


  /**
   * Delete what retention has released: expired Jobs with the runs they own,
   * then expired runs that are only history. A Job's latest run is never
   * history — it is the run its outcome is read from — so it is skipped and
   * leaves only with its Job. That keeps the two sweeps independent: neither
   * ordering nor either sweep's limit can leave a Job pointing at a run that
   * is gone.
   */
  private async reap(signal: AbortSignal): Promise<boolean> {
    const now = this.options.now();
    if (now - this.lastReapAt < REAP_INTERVAL_MS) return false;
    this.lastReapAt = now;
    const limit = this.options.limits.claimBatchSize;
    return await this.options.executor.jobsWrite(signal, async (surface) => {
      const jobs = surface.jobs.expired(now, limit);
      for (const job of jobs) await this.deleteWithRuns(surface, job.id);
      const runs = surface.runs.expired(now, limit);
      for (const run of runs) {
        const job = surface.jobs.byId(run.jobId);
        if (job !== null && job.runCount === run.number) continue;
        await surface.runs.delete(run.id);
      }
      // A full page means more is waiting: say so, so the runner comes back
      // instead of parking on work it can see.
      return jobs.length === limit || runs.length === limit;
    });
  }

  private async deleteWithRuns(surface: JobsWriteSurface, id: bigint): Promise<void> {
    for (;;) {
      const runs = surface.runs.ofJob(id, CASCADE_BATCH);
      for (const run of runs) await surface.runs.delete(run.id);
      if (runs.length < CASCADE_BATCH) break;
    }
    await surface.jobs.delete(id);
  }

  /**
   * When a terminal Job and the run its outcome lives on may be deleted. It is
   * the longer of the definition's retention and the dedupe window for that
   * outcome, so a memoized result can never be reaped while dedupe would still
   * return it.
   */
  private retentionStamp(
    definition: AnyJob | undefined,
    state: "completed" | "failed" | "canceled",
    now: number,
  ): number | null {
    // A Job of a no-longer-declared definition keeps the default retention:
    // deleting a definition must not silently erase its history.
    if (definition === undefined) return now + DEFAULT_JOB_RETENTION_MS;
    const windows: JobWindow[] = [definition.retention];
    if (definition.dedupe !== null && state !== "canceled") {
      windows.push(state === "completed" ? definition.dedupe.completed : definition.dedupe.failed);
    }
    if (windows.includes("forever")) return null;
    return this.window(Math.max(...(windows as number[])), now);
  }

  private window(value: JobWindow, now: number): number | null {
    return value === "forever" ? null : now + value;
  }

  // -- Row helpers -----------------------------------------------------------

  private isTerminal(state: JobState): boolean {
    return state === "completed" || state === "failed" || state === "canceled";
  }

  private requireJob(surface: JobsWriteSurface, id: bigint, op: string): JobRow {
    if (typeof id !== "bigint") {
      throw new ValidationError(`jobs.${op}: expected a bigint job id`);
    }
    const job = surface.jobs.byId(id);
    if (job === null) throw new AckerDBError("not_found", `job ${id} does not exist`);
    return job;
  }

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

  private insertJob(
    store: JobsStore,
    job: {
      readonly name: string;
      readonly argsJson: string;
      readonly argsHash: string;
      readonly key: string | null;
      readonly at: number;
      readonly now: number;
      readonly trigger: JobTrigger;
      readonly parentJobId: bigint | null;
    },
  ): Promise<bigint> {
    return store.insert({
      name: job.name,
      argsJson: job.argsJson,
      argsHash: job.argsHash,
      key: job.key,
      state: "pending",
      trigger: job.trigger,
      parentJobId: job.parentJobId,
      scheduledAt: job.at,
      nextRunAt: job.at,
      runCount: 0,
      nextRunTrigger: null,
      stepsJson: "[]",
      enqueuedAt: job.now,
      settledAt: null,
      deleteAfter: null,
    });
  }

  /**
   * The Job a dedupe hit resolves to: a live one for this identity, else the
   * newest terminal one whose outcome is still inside its window. Read-only by
   * construction — a hit executes no handler, so it writes nothing.
   */
  private dedupeJob(
    store: JobsStore,
    definition: AnyJob,
    name: string,
    argsHash: string,
    now: number,
  ): JobRow | null {
    const live = store.liveFor(name, argsHash);
    if (live !== null) return live;
    const windows = definition.dedupe!;
    let best: JobRow | null = null;
    for (const state of ["completed", "failed"] as const) {
      const window = windows[state];
      if (window === 0) continue;
      const job = store.newestSettledFor(name, argsHash, state);
      if (job === null || job.settledAt === null) continue;
      if (window !== "forever" && job.settledAt + window <= now) continue;
      // The same total order the per-state read uses: settle time, then id.
      if (
        best === null ||
        job.settledAt > best.settledAt! ||
        (job.settledAt === best.settledAt && job.id > best.id)
      ) {
        best = job;
      }
    }
    return best;
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

  private terminalOutcome(rows: JobOutcomeRows): JobRunOutcome | null {
    const { job, run } = rows;
    switch (job.state) {
      case "completed":
        return {
          ok: true,
          value: run === null || run.outputJson === null ? undefined : decode(run.outputJson),
        };
      case "failed":
        return {
          ok: false,
          state: "failed",
          error: new AckerDBError("unavailable", run?.errorText ?? "job failed"),
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

  private notifyDirect(id: bigint, outcome: JobRunOutcome): void {
    const set = this.waiters.get(id);
    if (set === undefined) return;
    this.waiters.delete(id);
    for (const resolve of set) resolve(outcome);
  }

  /** Post-commit delivery: waiters see only committed settles. */
  private deliver(notifications: readonly Notification[]): void {
    for (const notification of notifications) {
      this.notifyDirect(notification.id, notification.outcome);
    }
  }

  /** The Job and the run its outcome is read from, off the writer. */
  private async readOutcome(id: bigint): Promise<JobOutcomeRows | null> {
    return await this.options.reads.submit(
      (connection) => {
        const job = this.options.executor.readJobRow(connection, id);
        if (job === null) return null;
        const run = job.runCount === 0
          ? null
          : this.options.executor.readJobRunRow(connection, id, job.runCount);
        return { job, run };
      },
      { bytes: 1, fairnessKey: "system:jobs" },
    );
  }

  private async nextDueAt(): Promise<number | null> {
    const inProcessIds = [...this.runControllers.keys()];
    return await this.options.reads.submit(
      (connection) =>
        this.options.executor.nextDueJobAt(
          connection,
          inProcessIds,
          this.lastReapAt + REAP_INTERVAL_MS,
        ),
      { bytes: 1, fairnessKey: "system:jobs" },
    );
  }

}
