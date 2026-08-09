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
import { TelemetryStore } from "./store.ts";
import { TelemetryJournal } from "../application-signals/journal.ts";
import { TelemetryErrorStore } from "../errors/store.ts";
import { TelemetryExemplarStore } from "./exemplars.ts";
import { TelemetryAggregateStore } from "./aggregate.ts";
import type { TelemetryJournalRecord } from "../application-signals/types.ts";
import type { TraceExemplar } from "../exemplars/collector.ts";
import type { AggregateSeriesRow } from "../aggregation/buckets.ts";
import type { TelemetryRecordKind } from "./worker/protocol.ts";
import type {
  TelemetrySidecarSeal,
  TelemetrySidecarSnapshot,
  TelemetrySidecarWriter,
} from "./writer.ts";

export interface TelemetryInlineWriterOptions {
  readonly path: string;
  readonly retention?: Readonly<Record<string, number>>;
  readonly maxStoredBytes?: number;
  readonly commitBatch?: number;
  readonly generation?: string;
}

interface Pending {
  readonly kind: TelemetryRecordKind;
  readonly value: unknown;
}

export class TelemetryInlineWriter implements TelemetrySidecarWriter {
  readonly store: TelemetryStore;
  readonly journal: TelemetryJournal;
  readonly errors: TelemetryErrorStore;
  readonly exemplars: TelemetryExemplarStore;
  readonly aggregate: TelemetryAggregateStore;
  private readonly commitBatch: number;
  private readonly pending: Pending[] = [];
  private readonly counts: Record<string, number> = { log: 0, analytics: 0, error: 0, exemplar: 0, aggregate: 0 };
  private readonly drops: Record<string, number> = { log: 0, analytics: 0, error: 0, exemplar: 0, aggregate: 0 };
  private acceptedRecords = 0;
  private droppedRecords = 0;
  private committedRecords = 0;
  private rejectedRecords = 0;
  private acceptedSeq = 0;
  private durableSeq = 0;
  private sealed = false;

  constructor(options: TelemetryInlineWriterOptions) {
    this.commitBatch = options.commitBatch ?? 256;
    this.store = new TelemetryStore({
      path: options.path,
      ...(options.retention === undefined ? {} : { retention: options.retention }),
      ...(options.maxStoredBytes === undefined
        ? {}
        : { limits: { maxStoredBytes: options.maxStoredBytes } }),
    });
    this.journal = new TelemetryJournal({ store: this.store });
    this.errors = new TelemetryErrorStore({ store: this.store });
    this.exemplars = new TelemetryExemplarStore(this.store);
    this.aggregate = new TelemetryAggregateStore(this.store, options.generation ?? randomUUID());
  }

  accept(kind: TelemetryRecordKind, record: unknown): boolean {
    if (this.sealed) {
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
    if (this.pending.length >= this.commitBatch) this.commit();
    return true;
  }

  private commit(): void {
    if (this.pending.length === 0) return;
    const batch = this.pending.splice(0, this.pending.length);
    const highest = this.acceptedSeq;
    try {
      this.store.database.transaction(() => {
        for (const item of batch) {
          switch (item.kind) {
            case "log":
            case "analytics":
              this.journal.appendDirect(item.value as TelemetryJournalRecord);
              break;
            case "error":
              this.errors.ingestDirect(item.value as Parameters<TelemetryErrorStore["ingestDirect"]>[0]);
              break;
            case "exemplar":
              this.exemplars.writeDirect(item.value as TraceExemplar);
              break;
            case "aggregate": {
              const handoff = item.value as {
                readonly startMs: number;
                readonly closed: boolean;
                readonly rows: readonly AggregateSeriesRow[];
              };
              this.aggregate.writeDirect(handoff.startMs, handoff.closed, handoff.rows);
              break;
            }
          }
        }
        this.store.maintain();
      })();
      this.committedRecords += batch.length;
    } catch (error) {
      this.rejectedRecords += batch.length;
      this.store.observeFailure(error);
    }
    // The watermark advances either way: records that will never become durable
    // must not wedge every future drain.
    this.durableSeq = highest;
  }

  snapshot(): TelemetrySidecarSnapshot {
    const store = this.store.snapshot();
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
      containedFailures: store.containedFailures,
      failed: store.state === "failed",
    });
  }

  onFailure(listener: (error: unknown) => void): () => void {
    return this.store.onFailure(listener);
  }

  async seal(terminal: unknown | undefined): Promise<TelemetrySidecarSeal> {
    if (this.sealed) return { snapshot: this.snapshot(), timedOut: false };
    this.sealed = true;
    this.commit();
    if (terminal !== undefined) {
      try {
        this.journal.appendFinal(terminal as TelemetryJournalRecord);
      } catch {
        // The drain reports this through the snapshot's failure accounting.
      }
    }
    const snapshot = this.snapshot();
    this.store.close();
    return { snapshot, timedOut: false };
  }
}
