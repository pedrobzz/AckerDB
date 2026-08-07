import type { Engine } from "../../database/engine.ts";
import type { PluginRuntime } from "../../plugins/runtime.ts";
import type { RealtimeRuntime } from "../../realtime/host.ts";
import { AckerDBError } from "../../shared/errors.ts";
import type { OutboundBudget } from "../../subscriptions/delivery/budget.ts";
import type { BoundedSseProducer } from "../../subscriptions/delivery/sse.ts";
import type { OrderedReactive } from "../../subscriptions/reactive/ordered.ts";
import type { TelemetryJournalExporters } from "../../telemetry/application-signals/exporters.ts";
import type { TelemetryJournal } from "../../telemetry/application-signals/journal.ts";
import type { TelemetryStore } from "../../telemetry/storage/store.ts";
import type { TelemetrySpanStore } from "../../telemetry/storage/spans.ts";
import type { Telemetry } from "../../telemetry/telemetry.ts";
import type { RuntimeStatus } from "../contracts/status.ts";
import type { RuntimeLifecycleState } from "../contracts/lifecycle.ts";
import type { RuntimeFunctionExecutor } from "../execution/functions.ts";
import type {
  OperationAdmission,
  SessionOperationOrder,
} from "../execution/operation-runner.ts";
import type { RuntimeReadExecutor } from "../execution/read.ts";
import type { ServiceLimits } from "../limits.ts";
import { outcomeFromError } from "../outcome.ts";
import type { RuntimeJobs } from "../jobs/runtime.ts";
import type {
  RuntimeReactiveContext,
  RuntimeSession,
  RuntimeSessionStore,
} from "../sessions/store.ts";
import type { FileCleanupRuntime } from "../../files/cleanup.ts";
import type { RuntimeFiles } from "../../files/namespace.ts";

const DRAIN_RETRY_AFTER_MS = 1_000;
/**
 * How long past the shutdown deadline a cooperative store drain may take to
 * acknowledge quiescence — enough for its one in-flight synchronous batch,
 * without letting a zombie drain hold the caller's drain hostage.
 */
const QUIESCENCE_GRACE_MS = 500;
const utf8 = new TextEncoder();

export interface RuntimeControlOptions {
  readonly limits: ServiceLimits;
  readonly engine: Engine;
  readonly telemetry: Telemetry;
  readonly telemetryStore: TelemetryStore;
  readonly telemetryJournal: TelemetryJournal;
  readonly telemetrySpans: TelemetrySpanStore;
  readonly telemetryExporters?: TelemetryJournalExporters;
  readonly ownsTelemetry: boolean;
  readonly ownsTelemetryStore: boolean;
  readonly ownsTelemetryJournal: boolean;
  readonly pluginRuntime?: PluginRuntime;
  readonly realtime?: RealtimeRuntime;
  readonly reads: RuntimeReadExecutor;
  readonly functions: RuntimeFunctionExecutor<RuntimeReactiveContext>;
  readonly reactive: OrderedReactive<RuntimeReactiveContext>;
  readonly sessions: RuntimeSessionStore;
  readonly jobs: RuntimeJobs;
  readonly fileCleanup: FileCleanupRuntime;
  readonly files: RuntimeFiles;
  readonly authCaptureBudget: OutboundBudget;
  readonly sseBudget: OutboundBudget;
  readonly sseProducers: ReadonlyMap<string, BoundedSseProducer>;
  /** Stops the sampler and every other periodic telemetry emitter at drain start. */
  readonly stopPeriodicTelemetry: () => void;
  /** Releases the durable-sink lease before the read-model store closes. */
  readonly releaseDurableSink: () => void;
  /** Appends the terminal lifecycle row synchronously — the last durable record. */
  readonly appendTerminalLifecycle: (record: {
    readonly lifecycleState: "stopped" | "failed";
    readonly outcome?: ReturnType<typeof outcomeFromError>["code"];
    readonly errorClass?: string;
  }) => void;
  readonly flushDeliveryFailures: () => void;
}

/** Owns Runtime admission, lifecycle state, status projection, and finite drain. */
export class RuntimeControl {
  private readonly externalOperations = new Map<string, number>();
  private readonly activeWaiters = new Set<() => void>();
  private readonly shutdownController = new AbortController();
  private readonly systemDrainController = new AbortController();
  private readonly releaseTelemetryJournalFailure: () => void;
  private lifecycle: RuntimeLifecycleState = "ready";
  private activeOperations = 0;
  private drainPromise: Promise<void> | null = null;
  /** The one shared finalization every drain path awaits — never re-run. */
  private finalization: Promise<unknown[]> | null = null;
  /** The first registered terminal failure; the deadline registers synchronously. */
  private terminalFailure: unknown;

  constructor(private readonly options: RuntimeControlOptions) {
    this.releaseTelemetryJournalFailure = options.telemetryJournal.onFailure((error) => {
      options.telemetry.recordEvent({
        name: "failure",
        level: "error",
        operation: "lifecycle",
        outcome: "internal",
        resource: "telemetry",
        errorClass: error instanceof Error ? error.name : "UnknownError",
      });
      if (this.lifecycle === "ready") {
        void this.drain(Date.now() + options.limits.gracefulShutdownMs).catch(() => {});
      }
    });
    options.telemetry.recordEvent({
      name: "lifecycle",
      level: "info",
      operation: "lifecycle",
      lifecycleState: "ready",
    });
  }

  get state(): RuntimeLifecycleState {
    return this.lifecycle;
  }

  get isReady(): boolean {
    return this.lifecycle === "ready";
  }

  get shutdownSignal(): AbortSignal {
    return this.shutdownController.signal;
  }

  get activeOperationCount(): number {
    return this.activeOperations;
  }

  get activeCallerCount(): number {
    return this.externalOperations.size;
  }

  admit(
    session: RuntimeSession | null,
    fairnessKey?: string,
    sessionOrder?: SessionOperationOrder,
  ): OperationAdmission {
    this.assertReady();
    const callerOperations = fairnessKey === undefined
      ? 0
      : this.externalOperations.get(fairnessKey) ?? 0;
    if (
      fairnessKey !== undefined &&
      callerOperations >= this.options.limits.maxOperationsPerCaller
    ) {
      throw operationOverload("per-caller operation capacity is full");
    }
    if (this.activeOperations >= this.options.limits.maxOperations) {
      throw operationOverload("operation capacity is full");
    }
    const sessionAdmission = session === null
      ? undefined
      : this.options.sessions.admit(session, sessionOrder);
    this.activeOperations++;
    if (fairnessKey !== undefined) {
      this.externalOperations.set(fairnessKey, callerOperations + 1);
    }

    let active = true;
    return {
      predecessor: sessionAdmission?.predecessor,
      release: () => {
        if (!active) return;
        active = false;
        sessionAdmission?.release();
        this.activeOperations--;
        if (fairnessKey !== undefined) {
          const remaining = this.externalOperations.get(fairnessKey)! - 1;
          if (remaining === 0) this.externalOperations.delete(fairnessKey);
          else this.externalOperations.set(fairnessKey, remaining);
        }
        if (this.activeOperations === 0) {
          for (const resolve of this.activeWaiters) resolve();
          this.activeWaiters.clear();
        }
      },
    };
  }

  assertReady(): void {
    if (this.lifecycle === "ready") return;
    if (this.lifecycle === "draining") {
      throw new AckerDBError(
        "draining",
        "runtime is not accepting operations",
        {
          retryable: true,
          retryAfterMs: DRAIN_RETRY_AFTER_MS,
          resource: "operation",
        },
      );
    }
    throw new AckerDBError(
      "unavailable",
      "runtime is not available",
      { resource: "operation" },
    );
  }

  admittedRequestBytes(request: unknown, receivedBytes?: number): number {
    let bytes = receivedBytes;
    if (bytes === undefined) {
      try {
        bytes = byteLength(request);
      } catch (cause) {
        throw new AckerDBError("validation", "request is not wire-representable", { cause });
      }
    }
    this.assertRequestBytes(bytes);
    return bytes;
  }

  assertRequestBytes(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new RangeError("request bytes must be a non-negative safe integer");
    }
    if (bytes > this.options.limits.maxRequestBytes) {
      throw new AckerDBError("overloaded", "request exceeds maxRequestBytes", {
        resource: "operation",
      });
    }
  }

  operationSignal(signal?: AbortSignal): AbortSignal {
    return signal === undefined
      ? this.shutdownController.signal
      : AbortSignal.any([signal, this.shutdownController.signal]);
  }

  systemSignal(signal?: AbortSignal): AbortSignal {
    return AbortSignal.any([
      this.shutdownController.signal,
      this.systemDrainController.signal,
      ...(signal === undefined ? [] : [signal]),
    ]);
  }

  status(): RuntimeStatus {
    return Object.freeze({
      state: this.lifecycle,
      connections: this.options.sessions.size,
      activeOperations: this.activeOperations,
      activeOperationCallers: this.externalOperations.size,
      activeSse: this.options.sseProducers.size,
      realtime: this.options.realtime?.snapshot() ?? null,
      declaredJobs: this.options.jobs.declaredCount,
      jobsArmed: this.options.jobs.armed,
      files: this.options.files.observability.snapshot(),
      reader: this.options.reads.snapshot(),
      writer: this.options.functions.snapshot(),
      reactive: this.options.reactive.snapshot(),
      publication: this.options.reactive.publication.snapshot(),
      authCaptureBudget: this.options.authCaptureBudget.snapshot(),
      sseBudget: this.options.sseBudget.snapshot(),
      telemetry: this.options.telemetry.snapshot(),
      telemetryAggregates: this.options.telemetry.aggregateSnapshot(),
      telemetryStore: this.options.telemetryStore.snapshot(),
      telemetryJournal: this.options.telemetryJournal.snapshot(),
      telemetrySpans: this.options.telemetrySpans.snapshot(),
      telemetryExporters: this.options.telemetryExporters?.snapshot() ?? null,
      storage: this.options.engine.status(),
    });
  }

  drain(deadlineAtMs = Date.now() + this.options.limits.gracefulShutdownMs): Promise<void> {
    if (this.drainPromise !== null) return this.drainPromise;
    if (this.lifecycle === "stopped") return Promise.resolve();
    if (!Number.isFinite(deadlineAtMs)) {
      throw new RangeError("runtime shutdown deadline must be finite");
    }
    // The epoch deadline converts ONCE into a monotonic budget: every
    // scheduling, classification, and recheck below compares against the
    // monotonic clock, so a wall-clock adjustment mid-drain (VM resume,
    // NTP sync) can neither launder a late settlement as in-time nor
    // inflate a grace timer. The offset stays SIGNED — an already-expired
    // deadline must overrun immediately, not earn a fresh grace window;
    // timer delays clamp to zero only where they are scheduled.
    const deadlineMonotonicMs = performance.now() + (deadlineAtMs - Date.now());
    this.lifecycle = "draining";
    this.releaseTelemetryJournalFailure();
    this.options.jobs.stop();
    this.options.fileCleanup.stop();
    this.options.stopPeriodicTelemetry();
    this.options.telemetry.recordEvent({
      name: "lifecycle",
      level: "info",
      operation: "lifecycle",
      lifecycleState: "draining",
    });
    const draining = new AckerDBError("draining", "runtime is draining", {
      retryable: true,
      retryAfterMs: DRAIN_RETRY_AFTER_MS,
      resource: "operation",
    });
    this.systemDrainController.abort(draining);
    const sessionDrains = [...this.options.sessions.values()].map((state) =>
      this.options.sessions.startClose(state));
    const realtimeDrain = this.options.realtime?.drain() ?? Promise.resolve();
    for (const producer of this.options.sseProducers.values()) producer.fail(draining);

    this.options.functions.close();
    this.options.reads.close();
    if (this.options.ownsTelemetry) this.options.telemetry.stop();
    const reactiveDrain = this.options.reactive.close();
    let deadlineReached = false;
    const coreShutdown = (async () => {
      const settled = await Promise.allSettled([
        this.waitForActiveOperations(),
        this.options.functions.drain(),
        this.options.fileCleanup.drain(),
        reactiveDrain,
        this.options.reads.drain(),
        realtimeDrain,
        ...sessionDrains,
      ]);
      const errors = settled.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : []);
      try {
        await this.options.pluginRuntime?.stop(draining);
      } catch (error) {
        errors.push(error);
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, "Runtime shutdown failed");
      }
    })();
    const shutdownWork = coreShutdown.then(async () => {
      if (deadlineReached) return;
      this.options.flushDeliveryFailures();
      const errors = await this.finalizeTelemetry(undefined, deadlineAtMs, deadlineMonotonicMs);
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, "Runtime telemetry finalization failed");
      }
    });

    const deadlineError = new AckerDBError(
      "deadline_exceeded",
      "runtime graceful shutdown deadline exceeded",
      { resource: "operation" },
    );
    let timeout!: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        deadlineReached = true;
        // Synchronous: an in-flight finalization that has not yet frozen its
        // terminal outcome must see this deadline as the failure.
        this.registerTerminalFailure(deadlineError);
        this.shutdownController.abort(deadlineError);
        void this.options.pluginRuntime?.stop(deadlineError).catch(() => {});
        reject(deadlineError);
      }, Math.max(0, deadlineMonotonicMs - performance.now()));
    });
    this.drainPromise = Promise.race([shutdownWork, deadline]).then(
      () => {
        clearTimeout(timeout);
        this.shutdownController.abort(draining);
        this.lifecycle = "stopped";
      },
      async (error) => {
        clearTimeout(timeout);
        deadlineReached = true;
        this.shutdownController.abort(error);
        this.lifecycle = "failed";
        // Awaits the SAME shared finalization: the drain never settles while
        // the owning finalizer is active, and this failure was registered
        // synchronously before the finalizer could freeze its outcome. The
        // shared errors may include the very failure that reached us — and
        // the shutdown deadline is one cause however many steps it expired —
        // so keep each cause once.
        const isDeadline = (candidate: unknown): boolean =>
          candidate instanceof AckerDBError && candidate.code === "deadline_exceeded";
        const finalizationErrors = await this.finalizeTelemetry(error, deadlineAtMs, deadlineMonotonicMs);
        const cleanupErrors = finalizationErrors.filter((cleanup) =>
          cleanup !== error &&
          !(error instanceof AggregateError && error.errors.includes(cleanup)) &&
          !(isDeadline(cleanup) && isDeadline(error)));
        if (cleanupErrors.length === 0) throw error;
        throw new AggregateError(
          [error, ...cleanupErrors],
          "Runtime shutdown and telemetry cleanup both failed",
        );
      },
    );
    return this.drainPromise;
  }

  /**
   * Register one failure and share the single finalization. Every drain path
   * — clean, core-shutdown failure, deadline — registers its failure
   * synchronously and awaits the SAME promise, so the drain never settles
   * while the owning finalizer is still active, and a deadline expiring
   * mid-finalization flips the terminal outcome instead of racing it.
   */
  private finalizeTelemetry(
    failure: unknown,
    deadlineAtMs: number,
    deadlineMonotonicMs: number,
  ): Promise<unknown[]> {
    this.registerTerminalFailure(failure);
    this.finalization ??= this.runFinalization(deadlineAtMs, deadlineMonotonicMs);
    return this.finalization;
  }

  private registerTerminalFailure(failure: unknown): void {
    if (failure !== undefined && this.terminalFailure === undefined) {
      this.terminalFailure = failure;
    }
  }

  /**
   * One telemetry finalization for every drain outcome. All fallible durable
   * flushing runs FIRST, each step bounded by the shutdown deadline so a
   * hung flush cannot hold the terminal write (or the caller's drain)
   * hostage; only then is the terminal lifecycle outcome frozen — read and
   * written in ONE synchronous stretch, so an expiring deadline either
   * registered its failure before the freeze or arrives too late to matter.
   * Exactly one `stopped`/`failed` event: recorded into the exporter stream
   * and appended synchronously into the journal as the structurally LAST
   * durable record before the sidecar closes. Errors are collected, never
   * thrown. Failures discovered after the freeze — a terminal append that
   * cannot write, store-close, export-flush — still reject the drain and
   * surface in accounting, but cannot flip the durable row: nothing can be
   * written into a sidecar that already failed.
   */
  private async runFinalization(
    deadlineAtMs: number,
    deadlineMonotonicMs: number,
  ): Promise<unknown[]> {
    const errors: unknown[] = [];
    const attempt = async (work: () => unknown): Promise<void> => {
      try {
        await this.boundedBy(work(), deadlineMonotonicMs);
      } catch (error) {
        errors.push(error);
      }
    };
    // Ordinary concurrent records bypass cleanly while the queues flush:
    // never accepted by Telemetry yet dropped by a not-ready store.
    await attempt(() => this.options.releaseDurableSink());
    // The exporter and in-memory telemetry flushes guard their own post-stop
    // store writes, so Promise-race abandonment at the deadline is safe for
    // them. The journal and span stores are different: their drains are
    // COOPERATIVE — the monotonic deadline is passed in, they drop the
    // unpersisted tail and settle only once the sidecar is guaranteed
    // quiescent.
    await attempt(() => this.options.telemetryExporters?.drain());
    const graceMonotonicMs = deadlineMonotonicMs + QUIESCENCE_GRACE_MS;
    const journalAck = await this.acknowledged(
      this.options.ownsTelemetryJournal
        ? this.options.telemetryJournal.drain(deadlineMonotonicMs)
        : this.options.telemetryJournal.flush(deadlineMonotonicMs),
      graceMonotonicMs,
    );
    if (journalAck.error !== undefined) errors.push(journalAck.error);
    const spansAck = await this.acknowledged(
      this.options.telemetrySpans.drain(deadlineMonotonicMs),
      graceMonotonicMs,
    );
    if (spansAck.error !== undefined) errors.push(spansAck.error);
    const quiescent = journalAck.ack !== "none" && spansAck.ack !== "none";
    if (!quiescent) {
      errors.push(new AckerDBError(
        "deadline_exceeded",
        "telemetry stores did not acknowledge quiescence by the shutdown deadline",
        { resource: "operation" },
      ));
    } else if (journalAck.ack === "late" || spansAck.ack === "late") {
      // Quiescence arrived, but past the bound: safe to append and close —
      // never clean to claim.
      errors.push(new AckerDBError(
        "deadline_exceeded",
        "telemetry stores acknowledged quiescence after the shutdown deadline",
        { resource: "operation" },
      ));
    }
    // FREEZE: synchronous from here through the terminal append. Monotonic
    // recheck first — a blocked event loop can deliver every settlement
    // before the overdue deadline timer, and a finalization past its
    // deadline must never freeze a clean outcome.
    if (performance.now() > deadlineMonotonicMs && this.terminalFailure === undefined && errors.length === 0) {
      errors.push(new AckerDBError(
        "deadline_exceeded",
        "telemetry finalization completed after the shutdown deadline",
        { resource: "operation" },
      ));
    }
    const terminal = this.terminalFailure ?? errors[0];
    const outcome = terminal === undefined
      ? { lifecycleState: "stopped" as const }
      : {
          lifecycleState: "failed" as const,
          outcome: outcomeFromError(terminal).code,
          errorClass: terminal instanceof Error ? terminal.name : "UnknownError",
        };
    try {
      // Exporter-stream parity; the detached sink makes this non-durable.
      this.options.telemetry.recordEvent({
        name: "lifecycle",
        level: outcome.lifecycleState === "stopped" ? "info" : "error",
        operation: "lifecycle",
        ...outcome,
      });
    } catch (error) {
      errors.push(error);
    }
    // The deadline-overrun form: without acknowledged quiescence, a zombie
    // flush may still touch the sidecar — never append the terminal row
    // into it and never close it under active owners. The drain rejects
    // with the deadline error instead; a late-resuming flush is then a
    // clean write into a store that was deliberately left open.
    if (quiescent) {
      try {
        this.options.appendTerminalLifecycle(outcome);
      } catch (error) {
        errors.push(error);
      }
    }
    await attempt(() => this.options.ownsTelemetry
      ? this.options.telemetry.drain(deadlineAtMs)
      : this.options.telemetry.flush());
    if (quiescent) {
      await attempt(() => {
        if (this.options.ownsTelemetryStore) this.options.telemetryStore.close();
      });
    }
    return errors;
  }

  /**
   * Await one cooperative store drain up to the grace bound. Settlement —
   * resolution OR rejection — is the quiescence acknowledgement; only a
   * drain that answers nothing at all leaves the store unacknowledged.
   * Timers alone cannot judge lateness: a synchronously blocked event loop
   * delivers every settlement microtask before any overdue timer macrotask,
   * so the settlement handlers check the clock themselves — the MONOTONIC
   * clock, which no wall-clock adjustment can rewind under a settlement.
   * A late REAL settlement is still quiescent (safe to append and close),
   * it just must never be called clean.
   */
  private acknowledged(
    work: Promise<void>,
    graceMonotonicMs: number,
  ): Promise<{ readonly ack: "in-time" | "late" | "none"; readonly error?: unknown }> {
    const ackNow = (): "in-time" | "late" =>
      performance.now() > graceMonotonicMs ? "late" : "in-time";
    return Promise.race([
      work.then(
        () => ({ ack: ackNow() }),
        (error: unknown) => ({ ack: ackNow(), error }),
      ),
      new Promise<{ readonly ack: "none" }>((resolve) => {
        const timer = setTimeout(
          () => resolve({ ack: "none" as const }),
          Math.max(0, graceMonotonicMs - performance.now()),
        );
        timer.unref?.();
      }),
    ]);
  }

  /** Bound one finalization step by the monotonic shutdown deadline. */
  private boundedBy<T>(work: T | Promise<T>, deadlineMonotonicMs: number): Promise<T> {
    if (!(work instanceof Promise)) return Promise.resolve(work);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new AckerDBError(
          "deadline_exceeded",
          "telemetry finalization exceeded the shutdown deadline",
          { resource: "operation" },
        ));
      }, Math.max(0, deadlineMonotonicMs - performance.now()));
      timer.unref?.();
      work.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  private waitForActiveOperations(): Promise<void> {
    if (this.activeOperations === 0) return Promise.resolve();
    return new Promise((resolve) => this.activeWaiters.add(resolve));
  }
}

function operationOverload(message: string): AckerDBError {
  return new AckerDBError("overloaded", message, {
    retryable: true,
    retryAfterMs: 0,
    resource: "operation",
  });
}

function byteLength(value: unknown): number {
  return utf8.encode(encode(value)).byteLength;
}
import { encode } from "@ackerdb/core";
