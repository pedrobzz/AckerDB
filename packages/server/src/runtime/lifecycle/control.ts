import type { Engine } from "../../database/engine.ts";
import { AckerDBError, drainingError, notReadyError } from "../../shared/errors.ts";
import type { OutboundBudget } from "../../subscriptions/delivery/budget.ts";
import type { BoundedSseProducer } from "../../subscriptions/delivery/sse.ts";
import type { OrderedReactive } from "../../subscriptions/reactive/ordered.ts";
import type { RuntimeStatus } from "../contracts/status.ts";
import type { RuntimeLifecycleState } from "../contracts/lifecycle.ts";
import type { RuntimeFunctionExecutor } from "../execution/functions.ts";
import type {
  OperationAdmission,
  SessionOperationOrder,
} from "../execution/operation-runner.ts";
import type { RuntimeReadExecutor } from "../execution/read.ts";
import type { ServiceLimits } from "../limits.ts";
import type { RuntimeJobs } from "../jobs/runtime.ts";
import type {
  RuntimeReactiveContext,
  RuntimeSession,
  RuntimeSessionStore,
} from "../sessions/store.ts";
import type { FileCleanupRuntime } from "../../files/cleanup.ts";
import { wireByteLength } from "../../shared/bytes.ts";
import { finiteMillis } from "../../shared/clock.ts";


export interface RuntimeControlOptions {
  readonly limits: ServiceLimits;
  readonly engine: Engine;
  readonly reads: RuntimeReadExecutor;
  readonly functions: RuntimeFunctionExecutor<RuntimeReactiveContext>;
  readonly reactive: OrderedReactive<RuntimeReactiveContext>;
  readonly sessions: RuntimeSessionStore;
  readonly jobs: RuntimeJobs;
  readonly fileCleanup: FileCleanupRuntime;
  readonly authCaptureBudget: OutboundBudget;
  readonly sseBudget: OutboundBudget;
  readonly sseProducers: ReadonlyMap<string, BoundedSseProducer>;
}

/** Owns Runtime admission, lifecycle state, status projection, and finite drain. */
export class RuntimeControl {
  private readonly externalOperations = new Map<string, number>();
  private readonly activeWaiters = new Set<() => void>();
  private readonly shutdownController = new AbortController();
  private readonly systemDrainController = new AbortController();
  private lifecycle: RuntimeLifecycleState = "created";
  private activeOperations = 0;
  private drainPromise: Promise<void> | null = null;

  constructor(private readonly options: RuntimeControlOptions) {}

  get state(): RuntimeLifecycleState {
    return this.lifecycle;
  }

  /**
   * created → ready. Everything a Runtime does on its own initiative starts
   * here and nowhere earlier: File cleanup recovery begins, every argless
   * repeating Job is minted, and the runner is armed. The bootstrap is awaited
   * and its failure propagates — a Runtime that cannot mint its own repeat
   * Jobs has a storage problem everything else will hit, so it is the owner's
   * failure to make loud, not a line in a log.
   */
  async start(): Promise<void> {
    if (this.lifecycle !== "created") {
      throw new Error(`Runtime.start() requires a created Runtime (state: ${this.lifecycle})`);
    }
    this.options.functions.bindFileRecoveryBarrier(this.options.fileCleanup.activate());
    await this.options.jobs.bootstrap();
    // A drain that began during the bootstrap owns the state from here on.
    if (this.lifecycle !== "created") return;
    this.lifecycle = "ready";
    await this.options.jobs.arm();
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
      throw drainingError("runtime is not accepting operations", "operation");
    }
    throw notReadyError("runtime is not available", "operation");
  }

  admittedRequestBytes(request: unknown, receivedBytes?: number): number {
    let bytes = receivedBytes;
    if (bytes === undefined) {
      try {
        bytes = wireByteLength(request);
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
      declaredJobs: this.options.jobs.declaredCount,
      jobsArmed: this.options.jobs.armed,
      reader: this.options.reads.snapshot(),
      writer: this.options.functions.snapshot(),
      reactive: this.options.reactive.snapshot(),
      publication: this.options.reactive.publication.snapshot(),
      authCaptureBudget: this.options.authCaptureBudget.snapshot(),
      sseBudget: this.options.sseBudget.snapshot(),
      storage: this.options.engine.status(),
    });
  }

  drain(deadlineAtMs = Date.now() + this.options.limits.gracefulShutdownMs): Promise<void> {
    if (this.drainPromise !== null) return this.drainPromise;
    if (this.lifecycle === "stopped") return Promise.resolve();
    finiteMillis(deadlineAtMs, "runtime shutdown deadline");
    this.lifecycle = "draining";
    this.options.jobs.stop();
    this.options.fileCleanup.stop();
    const draining = drainingError("runtime is draining", "operation");
    this.systemDrainController.abort(draining);
    const sessionDrains = [...this.options.sessions.values()].map((state) =>
      this.options.sessions.startClose(state));
    for (const producer of this.options.sseProducers.values()) producer.fail(draining);

    this.options.functions.close();
    this.options.reads.close();
    const reactiveDrain = this.options.reactive.close();
    const coreShutdown = (async () => {
      const settled = await Promise.allSettled([
        this.waitForActiveOperations(),
        this.options.functions.drain(),
        this.options.fileCleanup.drain(),
        reactiveDrain,
        this.options.reads.drain(),
        ...sessionDrains,
      ]);
      const errors = settled.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : []);
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, "Runtime shutdown failed");
      }
    })();
    const shutdownWork = coreShutdown.then(() => undefined);

    const deadlineError = new AckerDBError(
      "deadline_exceeded",
      "runtime graceful shutdown deadline exceeded",
      { resource: "operation" },
    );
    let timeout!: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        this.shutdownController.abort(deadlineError);
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
        this.shutdownController.abort(error);
        this.lifecycle = "failed";
        throw error;
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
