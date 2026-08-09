/**
 * The sidecar writer for an engine that has no file: it writes on this thread,
 * because there is nothing to isolate.
 *
 * A worker would open its own private `:memory:` database that nothing on this
 * thread could ever read, so an in-memory engine's telemetry has to be written
 * here. That is also why the cost this implementation carries — a synchronous
 * commit on the calling thread — is acceptable: an in-memory engine is a test
 * and embedding shape, never the deployment the incident-amplification argument
 * is about.
 *
 * It still batches on count OR time, because the transaction boundary is where
 * the cost of a durable write lives regardless of which thread pays it.
 */
import { randomUUID } from "node:crypto";
import { TelemetryAdmission } from "./admission.ts";
import { TelemetrySidecarStores } from "./kinds.ts";
import type { TelemetryJournalRecord } from "../application-signals/types.ts";
import { kindCounters, type TelemetryRecordKind } from "./worker/protocol.ts";
import {
  DEFAULT_SIDECAR_QUEUE_LIMITS,
  type TelemetryExportPort,
  type TelemetrySidecarQueueLimits,
  type TelemetrySidecarSeal,
  type TelemetrySidecarSnapshot,
  type TelemetrySidecarWriter,
} from "./writer.ts";

export interface TelemetryInlineWriterOptions {
  readonly path: string;
  readonly queue?: Partial<TelemetrySidecarQueueLimits>;
  readonly retention?: Readonly<Record<string, number>>;
  readonly maxStoredBytes?: number;
  readonly generation?: string;
}

interface Pending {
  readonly kind: TelemetryRecordKind;
  readonly value: unknown;
}

export class TelemetryInlineWriter implements TelemetrySidecarWriter {
  readonly stores: TelemetrySidecarStores;
  private readonly limits: TelemetrySidecarQueueLimits;
  private readonly pending: Pending[] = [];
  private readonly counts = kindCounters();
  private readonly drops = kindCounters();
  private readonly persistListeners = new Set<() => void>();
  private readonly admission = new TelemetryAdmission();
  private commitTimer?: ReturnType<typeof setTimeout>;
  private acceptedRecords = 0;
  private droppedRecords = 0;
  private committedRecords = 0;
  private rejectedRecords = 0;
  private acceptedSeq = 0;
  private durableSeq = 0;
  private sealed = false;

  readonly exports: TelemetryExportPort = {
    onPersist: (listener) => {
      this.persistListeners.add(listener);
      return () => this.persistListeners.delete(listener);
    },
    // A batch commits first, exactly as the worker does: the queue in front of
    // this connection is invisible to a consumer, so a consumer that did not
    // flush it would read a journal missing records already accepted.
    batch: async (name, limit) => {
      this.commit();
      return this.stores.journal.consumerBatch(name, limit);
    },
    advance: async (name, cursor, advance) =>
      this.stores.journal.advanceConsumer(name, cursor, advance),
    failure: async (name, timedOut) => this.stores.journal.recordConsumerFailure(name, timedOut),
  };

  constructor(options: TelemetryInlineWriterOptions) {
    this.limits = Object.freeze({ ...DEFAULT_SIDECAR_QUEUE_LIMITS, ...options.queue });
    this.stores = new TelemetrySidecarStores({
      path: options.path,
      generation: options.generation ?? randomUUID(),
      ...(options.retention === undefined ? {} : { retention: options.retention }),
      ...(options.maxStoredBytes === undefined ? {} : { maxStoredBytes: options.maxStoredBytes }),
    });
  }

  accept(kind: TelemetryRecordKind, record: unknown): boolean {
    if (this.sealed) return this.shed("sealed", kind);
    const reason = this.admission.admit(kind);
    if (reason !== undefined) {
      this.droppedRecords++;
      this.drops[kind] = (this.drops[kind] ?? 0) + 1;
      return false;
    }
    // The sequence is taken before the record is queued, so a seal can never
    // seal at a number that excludes something already accepted.
    this.acceptedSeq++;
    this.acceptedRecords++;
    this.counts[kind] = (this.counts[kind] ?? 0) + 1;
    this.pending.push({ kind, value: record });
    if (this.pending.length >= this.limits.commitBatch) this.commit();
    else this.armCommit();
    return true;
  }

  private shed(reason: Parameters<TelemetryAdmission["record"]>[0], kind: TelemetryRecordKind): false {
    this.admission.record(reason, kind);
    this.droppedRecords++;
    this.drops[kind] = (this.drops[kind] ?? 0) + 1;
    return false;
  }

  /**
   * Count OR time. Without the timer a quiet process holds its last few records
   * uncommitted until unrelated traffic pushes the batch over the threshold —
   * unbounded durability lag on a record the application already accepted.
   */
  private armCommit(): void {
    if (this.commitTimer !== undefined || this.pending.length === 0) return;
    this.commitTimer = setTimeout(() => {
      this.commitTimer = undefined;
      this.commit();
    }, this.limits.commitDelayMs);
    this.commitTimer.unref?.();
  }

  private commit(): void {
    if (this.commitTimer !== undefined) {
      clearTimeout(this.commitTimer);
      this.commitTimer = undefined;
    }
    if (this.pending.length === 0) return;
    const batch = this.pending.splice(0, this.pending.length);
    const highest = this.acceptedSeq;
    try {
      this.stores.store.database.transaction(() => {
        for (const item of batch) this.stores.write(item.kind, item.value);
        this.stores.store.maintain();
      })();
      this.committedRecords += batch.length;
    } catch (error) {
      this.rejectedRecords += batch.length;
      this.stores.store.observeFailure(error);
    }
    // The watermark advances either way: records that will never become durable
    // must not wedge every future drain.
    this.durableSeq = highest;
    const store = this.stores.store;
    this.admission.observe(store.pressure, store.readOnly);
    for (const listener of this.persistListeners) {
      try {
        listener();
      } catch {
        // Export scheduling is downstream of durable local persistence.
      }
    }
  }

  snapshot(): TelemetrySidecarSnapshot {
    const store = this.stores.store.snapshot();
    return Object.freeze({
      acceptedRecords: this.acceptedRecords,
      droppedRecords: this.droppedRecords,
      acceptedByKind: Object.freeze({ ...this.counts }),
      droppedByKind: Object.freeze({ ...this.drops }),
      queuedRecords: this.pending.length,
      queuedBytes: 0,
      durableSeq: this.durableSeq,
      acceptedSeq: this.acceptedSeq,
      committedRecords: this.committedRecords,
      rejectedRecords: this.rejectedRecords,
      storedBytes: store.storedBytes,
      walBytes: store.walBytes,
      shed: this.admission.snapshot(),
      containedFailures: store.containedFailures,
      failed: store.state === "failed",
    });
  }

  onFailure(listener: (error: unknown) => void): () => void {
    return this.stores.store.onFailure(listener);
  }

  /**
   * The deadline is accepted and ignored: this implementation commits on the
   * calling thread, so by the time it returns the work is already done or
   * already failed. There is no acknowledgement to wait for and therefore no
   * way for it to arrive late.
   */
  async seal(terminal: unknown | undefined, _deadlineAtMs?: number): Promise<TelemetrySidecarSeal> {
    if (this.sealed) return { snapshot: this.snapshot(), timedOut: false };
    this.sealed = true;
    this.commit();
    if (terminal !== undefined) {
      try {
        this.stores.journal.appendFinal(terminal as TelemetryJournalRecord);
      } catch (error) {
        this.rejectedRecords++;
        this.stores.store.observeFailure(error);
      }
    }
    const snapshot = this.snapshot();
    this.stores.store.close();
    return { snapshot, timedOut: false };
  }
}
