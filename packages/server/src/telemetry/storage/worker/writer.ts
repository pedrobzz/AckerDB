/**
 * The serving thread's side of the durable telemetry pipeline: a bounded ring,
 * a pre-serialized batched handoff, and a quiescence protocol built on
 * acknowledged sequence numbers.
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
  kindCounters,
  RECORD_SEPARATOR,
  type TelemetryExportRequest,
  type TelemetryRecordKind,
  type TelemetryWorkerEvent,
  type TelemetryWorkerExportReply,
  type TelemetryWorkerStats,
} from "./protocol.ts";
import {
  sealLoss,
  TRACE_STORAGE_DISABLED,
  TRACE_STORAGE_ENABLED,
  sidecarQueueLimits,
  type TelemetryExportPort,
  type TelemetrySidecarQueueLimits,
  type TelemetrySidecarSeal,
  type TelemetrySidecarSnapshot,
  type TelemetrySidecarWriter,
} from "../writer.ts";
import type {
  TelemetryConsumerAdvance,
  TelemetryConsumerBatch,
  TelemetryConsumerSnapshot,
} from "../../application-signals/journal.ts";
import { TelemetryAdmission } from "../admission.ts";

export interface TelemetryWorkerWriterOptions {
  readonly path: string;
  readonly queue?: Partial<TelemetrySidecarQueueLimits>;
  readonly retention?: Readonly<Record<string, number>>;
  readonly maxStoredBytes?: number;
  /** Identifies this process in the aggregate's coverage record. */
  readonly generation: string;
  /** Whether durable trace storage is on, so the snapshot can disclose it. */
  readonly traceStorage?: boolean;
}

export class TelemetryWorkerWriter implements TelemetrySidecarWriter {
  private readonly worker: Worker;
  private readonly limits: TelemetrySidecarQueueLimits;
  /** Pre-serialized `kind\tjson` lines awaiting a handoff. */
  private ring: string[] = [];
  private queuedBytes = 0;
  private acceptedSeq = 0;
  private acceptedRecords = 0;
  private droppedRecords = 0;
  private readonly acceptedByKind = kindCounters();
  private readonly droppedByKind = kindCounters();
  private handoffs = 0;
  private readonly admission = new TelemetryAdmission();
  private readonly traceStorage: boolean;
  /** Per handoff: the oldest accept time it carries, awaiting its watermark. */
  private readonly awaitingAck: { seq: number; oldestAcceptMs: number }[] = [];
  private oldestAcceptInRing: number | undefined;
  /** Accept -> commit acknowledgement, worst case per handoff, in milliseconds. */
  readonly commitAckMs: number[] = [];
  private handoffTimer?: ReturnType<typeof setTimeout>;
  private lastStats: TelemetryWorkerStats | undefined;
  private readonly failureListeners = new Set<(error: unknown) => void>();
  private readonly persistListeners = new Set<() => void>();
  private notifiedDurableSeq = 0;
  private readonly ready: Promise<void>;
  private statsToken = 0;
  private readonly statsWaiters = new Map<number, (stats: TelemetryWorkerStats) => void>();
  private exportToken = 0;
  private readonly exportWaiters = new Map<number, {
    readonly resolve: (reply: TelemetryWorkerExportReply) => void;
    readonly reject: (error: unknown) => void;
  }>();
  private sealWaiter?: (event: Extract<TelemetryWorkerEvent, { type: "sealed" }>) => void;
  private sealed = false;
  private notifiedFailure = false;
  private workerDied = false;
  private resolveReady!: () => void;

  readonly exports: TelemetryExportPort = {
    onPersist: (listener) => {
      this.persistListeners.add(listener);
      return () => this.persistListeners.delete(listener);
    },
    batch: async (name, limit): Promise<TelemetryConsumerBatch> => {
      const reply = await this.exportRequest(name, { kind: "batch", limit });
      return Object.freeze({ records: reply.records ?? [], consumer: reply.consumer });
    },
    advance: async (
      name,
      cursor,
      advance: TelemetryConsumerAdvance,
    ): Promise<TelemetryConsumerSnapshot> =>
      (await this.exportRequest(name, {
        kind: "advance",
        cursor,
        exportedRecords: advance.exportedRecords ?? 0,
        skippedUnsupported: advance.skippedUnsupported ?? 0,
        skippedIdentity: advance.skippedIdentity ?? 0,
      })).consumer,
    failure: async (name, timedOut): Promise<TelemetryConsumerSnapshot> =>
      (await this.exportRequest(name, { kind: "failure", timedOut })).consumer,
  };

  constructor(options: TelemetryWorkerWriterOptions) {
    this.limits = sidecarQueueLimits(options.queue);
    this.traceStorage = options.traceStorage === true;
    this.worker = new Worker(new URL("./entry.ts", import.meta.url).href);
    this.ready = new Promise<void>((resolve) => {
      this.resolveReady = resolve;
    });
    this.worker.onmessage = (event: MessageEvent<TelemetryWorkerEvent>) => {
      const message = event.data;
      switch (message.type) {
        case "ready":
          this.resolveReady();
          return;
        case "watermark":
          this.observeStats(message.stats);
          this.observeFailed(message.stats);
          return;
        case "stats": {
          this.observeStats(message.stats);
          this.statsWaiters.get(message.token)?.(message.stats);
          this.statsWaiters.delete(message.token);
          return;
        }
        case "sealed":
          this.observeStats(message.stats);
          this.sealWaiter?.(message);
          return;
        case "export": {
          const waiter = this.exportWaiters.get(message.token);
          this.exportWaiters.delete(message.token);
          if (message.error !== undefined) waiter?.reject(new Error(message.error));
          else waiter?.resolve(message);
          return;
        }
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
    // A worker can die before or between messages, and every promise this class
    // hands out is settled by one. Without this, a crash leaves readiness, stats,
    // exports and the seal pending until some outer deadline, and the failure
    // listeners never learn the sidecar is gone.
    const died = (cause: unknown): void => this.observeWorkerDeath(cause);
    this.worker.onerror = died;
    (this.worker as unknown as { onmessageerror?: (event: unknown) => void }).onmessageerror = died;
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
    if (this.sealed) return this.shed("sealed", kind);
    // Admission first, before the serialization it would otherwise pay for.
    if (this.admission.admit(kind) !== undefined) {
      this.droppedRecords++;
      this.droppedByKind[kind] = (this.droppedByKind[kind] ?? 0) + 1;
      return false;
    }
    let json: string;
    try {
      json = JSON.stringify(record, encodeRecordValue);
    } catch {
      return this.shed("line_too_long", kind);
    }
    if (json.length > this.limits.maxRecordBytes) return this.shed("line_too_long", kind);
    if (
      this.ring.length >= this.limits.maxQueuedRecords ||
      this.queuedBytes + json.length > this.limits.maxQueuedBytes
    ) {
      return this.shed("queue_full", kind);
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

  private shed(reason: Parameters<TelemetryAdmission["record"]>[0], kind: TelemetryRecordKind): false {
    this.admission.record(reason, kind);
    this.droppedRecords++;
    this.droppedByKind[kind] = (this.droppedByKind[kind] ?? 0) + 1;
    return false;
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
   *
   * A watermark that moved is also the only honest wake-up signal for the export
   * pump: it means rows were committed, so a consumer that read an empty batch
   * now has something to read.
   */
  private observeStats(stats: TelemetryWorkerStats): void {
    this.lastStats = stats;
    this.admission.observe(stats.pressure, stats.readOnly);
    const now = performance.now();
    while (this.awaitingAck.length > 0 && this.awaitingAck[0]!.seq <= stats.processedSeq) {
      this.commitAckMs.push(now - this.awaitingAck.shift()!.oldestAcceptMs);
    }
    if (stats.durableSeq <= this.notifiedDurableSeq) return;
    this.notifiedDurableSeq = stats.durableSeq;
    for (const listener of this.persistListeners) {
      try {
        listener();
      } catch {
        // Export scheduling is downstream of durable local persistence.
      }
    }
  }

  private async exportRequest(
    name: string,
    request: TelemetryExportRequest,
  ): Promise<TelemetryWorkerExportReply & { readonly consumer: TelemetryConsumerSnapshot }> {
    if (this.sealed) throw new Error("telemetry sidecar is sealed");
    // Hand the ring over FIRST. The channel is ordered, so records posted here
    // are parsed before the request that follows them — without this, a consumer
    // reads a journal missing everything this thread accepted since the last
    // handoff, which for a quiet process is everything it has.
    this.handoff();
    const token = ++this.exportToken;
    const reply = await new Promise<TelemetryWorkerExportReply>((resolve, reject) => {
      this.exportWaiters.set(token, { resolve, reject });
      this.worker.postMessage({ type: "export", token, name, request });
    });
    // A reply with no cursor row is a cursor operation that did not happen.
    // Returning a fabricated one would let the pump advance for work the
    // sidecar never recorded.
    if (reply.consumer === undefined) {
      throw new Error(`telemetry export request "${request.kind}" returned no consumer state`);
    }
    return reply as TelemetryWorkerExportReply & { readonly consumer: TelemetryConsumerSnapshot };
  }

  onFailure(listener: (error: unknown) => void): () => void {
    this.failureListeners.add(listener);
    return () => this.failureListeners.delete(listener);
  }

  /**
   * The worker is gone. Idempotent: settle everything waiting on it, mark the
   * snapshot failed, and tell the failure listeners once.
   */
  private observeWorkerDeath(cause: unknown): void {
    if (this.workerDied) return;
    this.workerDied = true;
    const error = cause instanceof Error
      ? cause
      : new Error("telemetry sidecar worker stopped unexpectedly");
    for (const waiter of this.exportWaiters.values()) waiter.reject(error);
    this.exportWaiters.clear();
    for (const [token, resolve] of this.statsWaiters) {
      resolve({ ...this.workerStats(), failed: true });
      this.statsWaiters.delete(token);
    }
    this.sealWaiter?.({
      type: "sealed",
      through: this.acceptedSeq,
      stats: { ...this.workerStats(), failed: true },
      terminalWritten: false,
      error: error.message,
    });
    this.resolveReady();
    this.notifyFailure(error);
  }

  private workerStats(): TelemetryWorkerStats {
    return this.lastStats ?? {
      durableSeq: 0,
      processedSeq: 0,
      pendingRecords: 0,
      pendingBytes: 0,
      oldestPendingAgeMs: 0,
      committedRecords: 0,
      committedTransactions: 0,
      rejectedRecords: 0,
      storedBytes: 0,
      walBytes: 0,
      freeBytes: Number.POSITIVE_INFINITY,
      pressure: 0,
      readOnly: false,
      containedFailures: 0,
      failed: true,
    };
  }

  private notifyFailure(error: unknown): void {
    if (this.notifiedFailure) return;
    this.notifiedFailure = true;
    for (const listener of this.failureListeners) {
      try {
        listener(error);
      } catch {
        // A health observer cannot replace the sidecar's own failure.
      }
    }
  }

  /** The worker reports its own store's health; a failed sidecar is fatal here too. */
  private observeFailed(stats: TelemetryWorkerStats): void {
    if (!stats.failed) return;
    this.notifyFailure(new Error("telemetry sidecar connection is unusable"));
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
      processedSeq: worker?.processedSeq ?? 0,
      acceptedSeq: this.acceptedSeq,
      committedRecords: worker?.committedRecords ?? 0,
      rejectedRecords: worker?.rejectedRecords ?? 0,
      storedBytes: worker?.storedBytes ?? 0,
      walBytes: worker?.walBytes ?? 0,
      shed: this.admission.snapshot(),
      traceStorage: this.traceStorage ? TRACE_STORAGE_ENABLED : TRACE_STORAGE_DISABLED,
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
    if (this.sealed) {
      const already = this.snapshot();
      return {
        snapshot: already,
        timedOut: false,
        lostRecords: sealLoss(already),
        terminalWritten: true,
      };
    }
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
    const snapshot = this.snapshot();
    // The thread that would have answered them is gone. A pump still awaiting a
    // cursor operation must learn that, or its consumer hangs for the life of
    // the process holding a batch it can neither deliver nor forget.
    const abandoned = new Error("telemetry sidecar closed before the export request was answered");
    for (const waiter of this.exportWaiters.values()) waiter.reject(abandoned);
    this.exportWaiters.clear();
    return {
      snapshot,
      timedOut: settled === "timeout",
      lostRecords: sealLoss(snapshot),
      // A seal that never answered cannot claim a terminal row was written.
      terminalWritten: settled !== "timeout" && settled.terminalWritten,
      ...(settled !== "timeout" && settled.error !== undefined ? { error: settled.error } : {}),
    };
  }
}
