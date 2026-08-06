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
      this.options.telemetry.recordEvent({
        name: "lifecycle",
        level: "info",
        operation: "lifecycle",
        lifecycleState: "stopped",
      });
      await this.options.telemetryExporters?.drain();
      if (this.options.ownsTelemetryJournal) {
        await this.options.telemetryJournal.drain();
      } else {
        await this.options.telemetryJournal.flush();
      }
      await this.options.telemetrySpans.drain();
      if (this.options.ownsTelemetryStore) this.options.telemetryStore.close();
      return this.options.ownsTelemetry
        ? this.options.telemetry.drain(deadlineAtMs)
        : this.options.telemetry.flush();
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
        this.shutdownController.abort(deadlineError);
        void this.options.pluginRuntime?.stop(deadlineError).catch(() => {});
        reject(deadlineError);
      }, Math.max(0, deadlineAtMs - Date.now()));
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
        this.options.telemetry.recordEvent({
          name: "lifecycle",
          level: "error",
          operation: "lifecycle",
          lifecycleState: "failed",
          outcome: outcomeFromError(error).code,
          errorClass: error instanceof Error ? error.name : "UnknownError",
        });
        const cleanupErrors: unknown[] = [];
        try {
          await this.options.telemetryExporters?.drain();
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
        try {
          if (this.options.ownsTelemetryJournal) {
            await this.options.telemetryJournal.drain();
          } else {
            await this.options.telemetryJournal.flush();
          }
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
        try {
          await this.options.telemetrySpans.drain();
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
        if (this.options.ownsTelemetryStore) {
          try {
            this.options.telemetryStore.close();
          } catch (cleanupError) {
            cleanupErrors.push(cleanupError);
          }
        }
        if (this.options.ownsTelemetry) {
          try {
            await this.options.telemetry.drain(deadlineAtMs);
          } catch (cleanupError) {
            cleanupErrors.push(cleanupError);
          }
        }
        if (cleanupErrors.length === 0) throw error;
        throw new AggregateError(
          [error, ...cleanupErrors],
          "Runtime shutdown and telemetry cleanup both failed",
        );
      },
    );
    return this.drainPromise;
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
