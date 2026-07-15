import {
  AdmissionQueue,
  type AdmissionQueueSnapshot,
  type AdmissionRequestOptions,
} from "./admission.ts";
import type { QueueLimits } from "./limits.ts";
import type { TelemetryOperation, TelemetryResource } from "./telemetry.ts";

export interface ExecutorTaskOptions {
  readonly operation: TelemetryOperation;
  readonly bytes: number;
  readonly fairnessKey?: string;
  readonly deadlineMs?: number;
  readonly signal?: AbortSignal;
}

export interface ExecutorSnapshot {
  readonly concurrency: number;
  readonly active: number;
  readonly admitted: number;
  readonly completed: number;
  readonly failed: number;
  readonly queue: AdmissionQueueSnapshot;
}

export interface BoundedExecutorOptions {
  readonly concurrency: number;
  readonly discipline: "fifo" | "round-robin";
  readonly limits: QueueLimits;
  readonly resource: TelemetryResource;
  readonly retryAfterMs?: number;
  readonly now?: () => number;
}

interface Task<T> {
  readonly work: () => T | Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (error: unknown) => void;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

/** Finite admission plus bounded concurrent execution and deterministic drain. */
export class BoundedExecutor {
  readonly concurrency: number;
  private readonly queue: AdmissionQueue<Task<unknown>>;
  private readonly now: () => number;
  private active = 0;
  private admitted = 0;
  private completed = 0;
  private failed = 0;
  private pumping = false;
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private readonly drainWaiters = new Set<() => void>();

  constructor(options: BoundedExecutorOptions) {
    this.concurrency = positiveInteger(options.concurrency, "concurrency");
    this.queue = new AdmissionQueue({
      discipline: options.discipline,
      limits: options.limits,
      resource: options.resource,
      retryAfterMs: options.retryAfterMs,
      now: options.now,
    });
    this.now = options.now ?? Date.now;
  }

  submit<T>(work: () => T | Promise<T>, options: ExecutorTaskOptions): Promise<T> {
    if (typeof work !== "function") throw new TypeError("work must be a function");
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const result = new Promise<T>((accept, decline) => {
      resolve = accept;
      reject = decline;
    });
    const task: Task<T> = { work, resolve, reject };
    const request: AdmissionRequestOptions = {
      operation: options.operation,
      bytes: options.bytes,
      ...(options.fairnessKey === undefined ? {} : { fairnessKey: options.fairnessKey }),
      ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    };
    void this.queue.enqueue(task as Task<unknown>, request).catch((error) => {
      reject(error);
      this.scheduleExpiry();
      this.resolveDrainIfIdle();
    });
    this.pump();
    return result;
  }

  /** Stop accepting work, reject queued work, and let already-started handlers finish. */
  close(): void {
    this.clearExpiryTimer();
    this.queue.close();
    this.resolveDrainIfIdle();
  }

  /** Resolves when no admitted handler remains. Call close first to bound this wait. */
  drain(): Promise<void> {
    if (this.active === 0 && this.queue.snapshot().queuedItems === 0) return Promise.resolve();
    return new Promise((resolve) => this.drainWaiters.add(resolve));
  }

  snapshot(): ExecutorSnapshot {
    const queue = this.queue.snapshot();
    this.scheduleExpiry(queue);
    return Object.freeze({
      concurrency: this.concurrency,
      active: this.active,
      admitted: this.admitted,
      completed: this.completed,
      failed: this.failed,
      queue,
    });
  }

  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.active < this.concurrency) {
        const lease = this.queue.take();
        if (!lease) break;
        const task = lease.value;
        this.active++;
        this.admitted++;
        Promise.resolve()
          .then(task.work)
          .then(
            (value) => {
              this.completed++;
              task.resolve(value);
            },
            (error) => {
              this.failed++;
              task.reject(error);
            },
          )
          .finally(() => {
            this.active--;
            this.pump();
            this.resolveDrainIfIdle();
          });
      }
    } finally {
      this.pumping = false;
      this.scheduleExpiry();
    }
  }

  private resolveDrainIfIdle(): void {
    if (this.active !== 0 || this.queue.snapshot().queuedItems !== 0) return;
    for (const resolve of this.drainWaiters) resolve();
    this.drainWaiters.clear();
  }

  private scheduleExpiry(snapshot: AdmissionQueueSnapshot = this.queue.snapshot()): void {
    this.clearExpiryTimer();
    if (snapshot.closed || snapshot.nextExpiryAtMs === undefined) return;
    const now = this.now();
    if (!Number.isFinite(now)) throw new RangeError("executor clock must return finite milliseconds");
    const delay = Math.min(Math.max(0, snapshot.nextExpiryAtMs - now), 0x7fff_ffff);
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = undefined;
      this.queue.expire();
      this.scheduleExpiry();
      this.resolveDrainIfIdle();
    }, delay);
    this.expiryTimer.unref?.();
  }

  private clearExpiryTimer(): void {
    if (this.expiryTimer === undefined) return;
    clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
  }
}
