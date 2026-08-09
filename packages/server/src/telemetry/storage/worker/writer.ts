/**
 * PROTOTYPE (proto/telemetry-worker). The serving thread's side of the durable
 * telemetry pipeline: a bounded ring, a pre-serialized batched handoff, and a
 * quiescence protocol built on acknowledged sequence numbers.
 *
 * **Nothing here blocks the producer.** Accepting a record is one
 * `JSON.stringify` and one array write. The ring is finite; when it is full the
 * newest record is dropped and counted, which is the sanctioned degradation —
 * the alternative, an unbounded channel, converts loss into unbounded memory
 * growth, which on a 4 GiB envelope is the worse failure.
 *
 * **Serialization happens at accept, not at flush.** Posting an object graph
 * deep-clones it on the flushing call; posting an already-built string is close
 * to a memcpy. Paying ~0.15 µs on every accepting request is also strictly
 * better tail behaviour than paying a whole batch's clone on whichever request
 * happens to cross the threshold — which is the mode a throughput benchmark
 * hides and production finds.
 *
 * **Quiescence is a watermark, never a resolved promise.** Every accepted record
 * takes a sequence number BEFORE it enters the ring; a drain seals at the
 * highest accepted sequence and waits for the worker to acknowledge a durable
 * watermark at or past it. `opentelemetry-rust` #3453 was the same protocol with
 * the increment on the wrong side of the enqueue, and it silently lost accepted
 * spans through `force_flush` and `shutdown` for long enough that it took until
 * 2026 to notice.
 */
import {
  encodeRecordValue,
  FIELD_SEPARATOR,
  RECORD_SEPARATOR,
  type TelemetryRecordKind,
  type TelemetryWorkerEvent,
  type TelemetryWorkerStats,
} from "./protocol.ts";
import type {
  TelemetrySidecarSeal,
  TelemetrySidecarSnapshot,
  TelemetrySidecarWriter,
} from "../writer.ts";

export interface TelemetryWorkerWriterOptions {
  readonly path: string;
  /** Records the ring may hold before it drops the newest. */
  readonly maxQueuedRecords?: number;
  readonly maxQueuedBytes?: number;
  /** Records the serving thread accumulates before one handoff. */
  readonly handoffBatch?: number;
  /** Rows the worker accumulates before it opens a transaction. */
  readonly commitBatch?: number;
  /** Bound on how long a below-threshold record waits for a handoff. */
  readonly maxHandoffDelayMs?: number;
  /** Bound on how long the worker holds a below-threshold batch uncommitted. */
  readonly commitDelayMs?: number;
  readonly retention?: Readonly<Record<string, number>>;
  readonly maxStoredBytes?: number;
  /** Identifies this process in the aggregate's coverage record. */
  readonly generation: string;
}

export interface TelemetryWriterSnapshot {
  readonly acceptedRecords: number;
  readonly droppedRecords: number;
  readonly acceptedByKind: Readonly<Record<string, number>>;
  readonly droppedByKind: Readonly<Record<string, number>>;
  readonly queuedRecords: number;
  readonly queuedBytes: number;
  readonly handoffs: number;
  readonly acceptedSeq: number;
  readonly worker: TelemetryWorkerStats | undefined;
}

const DEFAULTS = {
  maxQueuedRecords: 65_536,
  maxQueuedBytes: 64 * 1_024 * 1_024,
  // Count OR time, never count alone. A count-only threshold makes durability
  // lag inversely proportional to traffic: at ten operations a second, a
  // 200-trace handoff plus a 512-row commit is twenty seconds of lag on a
  // record the application already considers accepted.
  handoffBatch: 1_400,
  commitBatch: 512,
  maxHandoffDelayMs: 5,
  commitDelayMs: 25,
};

export class TelemetryWorkerWriter implements TelemetrySidecarWriter {
  private readonly worker: Worker;
  private readonly limits: Required<
    Omit<TelemetryWorkerWriterOptions, "path" | "retention" | "maxStoredBytes" | "generation">
  >;
  /** Pre-serialized `kind\tjson` lines awaiting a handoff. */
  private ring: string[] = [];
  private queuedBytes = 0;
  private acceptedSeq = 0;
  private acceptedRecords = 0;
  private droppedRecords = 0;
  private readonly acceptedByKind: Record<string, number> = { log: 0, analytics: 0, span: 0, error: 0 };
  private readonly droppedByKind: Record<string, number> = { log: 0, analytics: 0, span: 0, error: 0 };
  private handoffs = 0;
  /** Per handoff: the oldest accept time it carries, awaiting its watermark. */
  private readonly awaitingAck: { seq: number; oldestAcceptMs: number }[] = [];
  private oldestAcceptInRing: number | undefined;
  /** Accept -> commit acknowledgement, worst case per handoff, in milliseconds. */
  readonly commitAckMs: number[] = [];
  private handoffTimer?: ReturnType<typeof setTimeout>;
  private lastStats: TelemetryWorkerStats | undefined;
  private readonly failureListeners = new Set<(error: unknown) => void>();
  private readonly ready: Promise<void>;
  private statsToken = 0;
  private readonly statsWaiters = new Map<number, (stats: TelemetryWorkerStats) => void>();
  private sealWaiter?: (event: Extract<TelemetryWorkerEvent, { type: "sealed" }>) => void;
  private sealed = false;
  private notifiedFailure = false;

  constructor(options: TelemetryWorkerWriterOptions) {
    this.limits = {
      maxQueuedRecords: options.maxQueuedRecords ?? DEFAULTS.maxQueuedRecords,
      maxQueuedBytes: options.maxQueuedBytes ?? DEFAULTS.maxQueuedBytes,
      handoffBatch: options.handoffBatch ?? DEFAULTS.handoffBatch,
      commitBatch: options.commitBatch ?? DEFAULTS.commitBatch,
      maxHandoffDelayMs: options.maxHandoffDelayMs ?? DEFAULTS.maxHandoffDelayMs,
      commitDelayMs: options.commitDelayMs ?? DEFAULTS.commitDelayMs,
    };
    this.worker = new Worker(new URL("./entry.ts", import.meta.url).href);
    let resolveReady!: () => void;
    this.ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    this.worker.onmessage = (event: MessageEvent<TelemetryWorkerEvent>) => {
      const message = event.data;
      switch (message.type) {
        case "ready":
          resolveReady();
          return;
        case "watermark":
          this.lastStats = message.stats;
          this.settleAcks(message.stats.durableSeq);
          this.observeFailed(message.stats);
          return;
        case "stats": {
          this.lastStats = message.stats;
          this.settleAcks(message.stats.durableSeq);
          this.statsWaiters.get(message.token)?.(message.stats);
          this.statsWaiters.delete(message.token);
          return;
        }
        case "sealed":
          this.lastStats = message.stats;
          this.settleAcks(message.stats.durableSeq);
          this.sealWaiter?.(message);
          return;
        case "failure":
          for (const listener of this.failureListeners) {
            try {
              listener(new Error(message.message));
            } catch {
              // A health observer cannot replace the sidecar's own failure.
            }
          }
          return;
      }
    };
    this.worker.postMessage({
      type: "open",
      path: options.path,
      commitBatch: this.limits.commitBatch,
      commitDelayMs: this.limits.commitDelayMs,
      generation: options.generation,
      ...(options.retention === undefined ? {} : { retention: options.retention }),
      ...(options.maxStoredBytes === undefined ? {} : { maxStoredBytes: options.maxStoredBytes }),
    });
  }

  whenReady(): Promise<void> {
    return this.ready;
  }

  /**
   * Accept one record. Total and non-blocking: a full ring drops the newest and
   * counts it, and a value that cannot be serialized is counted the same way.
   * Returns whether the record was accepted, so callers that keep their own drop
   * accounting stay honest.
   */
  accept(kind: TelemetryRecordKind, record: unknown): boolean {
    if (this.sealed) {
      this.droppedRecords++;
      this.droppedByKind[kind]!++;
      return false;
    }
    let json: string;
    try {
      json = JSON.stringify(record, encodeRecordValue);
    } catch {
      this.droppedRecords++;
      this.droppedByKind[kind]!++;
      return false;
    }
    if (
      this.ring.length >= this.limits.maxQueuedRecords ||
      this.queuedBytes + json.length > this.limits.maxQueuedBytes
    ) {
      this.droppedRecords++;
      this.droppedByKind[kind]!++;
      return false;
    }
    // The sequence is taken BEFORE the record enters the ring: a seal that read
    // a counter updated afterwards could seal at a number that excludes records
    // it has already accepted, and then call the loss a clean shutdown.
    this.acceptedSeq++;
    this.acceptedRecords++;
    this.oldestAcceptInRing ??= performance.now();
    this.acceptedByKind[kind]!++;
    this.ring.push(`${kind}${FIELD_SEPARATOR}${json}`);
    this.queuedBytes += json.length;
    if (this.ring.length >= this.limits.handoffBatch) this.handoff();
    else this.armHandoff();
    return true;
  }

  private armHandoff(): void {
    if (this.handoffTimer !== undefined || this.ring.length === 0) return;
    this.handoffTimer = setTimeout(() => {
      this.handoffTimer = undefined;
      this.handoff();
    }, this.limits.maxHandoffDelayMs);
    this.handoffTimer.unref?.();
  }

  private handoff(): void {
    if (this.ring.length === 0) return;
    if (this.handoffTimer !== undefined) {
      clearTimeout(this.handoffTimer);
      this.handoffTimer = undefined;
    }
    const payload = this.ring.join(RECORD_SEPARATOR);
    this.ring = [];
    this.queuedBytes = 0;
    this.handoffs++;
    this.awaitingAck.push({
      seq: this.acceptedSeq,
      oldestAcceptMs: this.oldestAcceptInRing ?? performance.now(),
    });
    this.oldestAcceptInRing = undefined;
    this.worker.postMessage({ type: "records", through: this.acceptedSeq, payload });
  }

  /**
   * A watermark settles every handoff it covers. The latency recorded is from
   * the OLDEST accept in that handoff, because that is the record that waited
   * longest — measuring the transaction alone would hide both queues, which is
   * exactly how this shape looks healthy while deferring loss.
   */
  private settleAcks(durableSeq: number): void {
    const now = performance.now();
    while (this.awaitingAck.length > 0 && this.awaitingAck[0]!.seq <= durableSeq) {
      this.commitAckMs.push(now - this.awaitingAck.shift()!.oldestAcceptMs);
    }
  }

  onFailure(listener: (error: unknown) => void): () => void {
    this.failureListeners.add(listener);
    return () => this.failureListeners.delete(listener);
  }

  /** The worker reports its own store's health; a failed sidecar is fatal here too. */
  private observeFailed(stats: TelemetryWorkerStats): void {
    if (!stats.failed || this.notifiedFailure) return;
    this.notifiedFailure = true;
    for (const listener of this.failureListeners) {
      try {
        listener(new Error("telemetry sidecar connection is unusable"));
      } catch {
        // A health observer cannot replace the sidecar's own failure.
      }
    }
  }

  /** Ask the worker for its accounting; also flushes anything it is holding. */
  async stats(): Promise<TelemetryWorkerStats> {
    const token = ++this.statsToken;
    const answer = new Promise<TelemetryWorkerStats>((resolve) => {
      this.statsWaiters.set(token, resolve);
    });
    this.worker.postMessage({ type: "stats", token });
    return answer;
  }

  snapshot(): TelemetrySidecarSnapshot {
    const worker = this.lastStats;
    return Object.freeze({
      acceptedRecords: this.acceptedRecords,
      droppedRecords: this.droppedRecords,
      acceptedByKind: Object.freeze({ ...this.acceptedByKind }),
      droppedByKind: Object.freeze({ ...this.droppedByKind }),
      queuedRecords: this.ring.length,
      queuedBytes: this.queuedBytes,
      durableSeq: worker?.durableSeq ?? 0,
      acceptedSeq: this.acceptedSeq,
      committedRecords: worker?.committedRecords ?? 0,
      rejectedRecords: worker?.rejectedRecords ?? 0,
      storedBytes: worker?.storedBytes ?? 0,
      walBytes: worker?.walBytes ?? 0,
      containedFailures: worker?.containedFailures ?? 0,
      failed: worker?.failed ?? false,
    });
  }

  /** Handoffs performed; diagnostic, not part of the sidecar contract. */
  get handoffCount(): number {
    return this.handoffs;
  }

  /**
   * Seal the stream and wait for the worker to acknowledge a durable watermark
   * at or past every sequence this thread ever accepted. Resolving is a claim
   * about what is on disk, which is why it is the worker's number and not this
   * thread's promise.
   */
  async seal(terminal: unknown | undefined, deadlineMs: number): Promise<TelemetrySidecarSeal> {
    if (this.sealed) return { snapshot: this.snapshot(), timedOut: false };
    this.sealed = true;
    this.handoff();
    const answer = new Promise<Extract<TelemetryWorkerEvent, { type: "sealed" }>>((resolve) => {
      this.sealWaiter = resolve;
    });
    this.worker.postMessage({
      type: "seal",
      through: this.acceptedSeq,
      ...(terminal === undefined ? {} : { terminal: JSON.stringify(terminal, encodeRecordValue) }),
    });
    let timer!: ReturnType<typeof setTimeout>;
    const expiry = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), Math.max(0, deadlineMs - Date.now()));
      timer.unref?.();
    });
    const settled = await Promise.race([answer, expiry]);
    clearTimeout(timer);
    if (settled !== "timeout") this.lastStats = settled.stats;
    this.worker.terminate();
    return { snapshot: this.snapshot(), timedOut: settled === "timeout" };
  }
}
