/**
 * The four stored kinds, opened together and written together.
 *
 * Both sidecar writers commit through this one routing switch. Two copies would
 * be two places for a new signal to be dropped on one engine and not the other,
 * and the two engines have to agree: an application must not get different
 * telemetry because its database happens to live in memory.
 */
import { TelemetryStore } from "./store.ts";
import { TelemetryJournal } from "../application-signals/journal.ts";
import { TelemetryErrorStore } from "../errors/store.ts";
import { TelemetryExemplarStore } from "./exemplars.ts";
import { TelemetryAggregateStore } from "./aggregate.ts";
import type { TelemetryJournalRecord } from "../application-signals/types.ts";
import type { TelemetryErrorIngest } from "../errors/store.ts";
import type { TraceExemplar } from "../exemplars/collector.ts";
import type { AggregateSeriesRow } from "../aggregation/buckets.ts";
import type { TelemetryRecordKind } from "./worker/protocol.ts";

/** One minute of the aggregate, as it crosses to the thread that stores it. */
export interface AggregateHandoffPayload {
  readonly startMs: number;
  readonly closed: boolean;
  readonly rows: readonly AggregateSeriesRow[];
}

export interface TelemetrySidecarStoresOptions {
  readonly path: string;
  readonly retention?: Readonly<Record<string, number>>;
  readonly maxStoredBytes?: number;
  /** Identifies this process in the aggregate's coverage record. */
  readonly generation: string;
}

export class TelemetrySidecarStores {
  readonly store: TelemetryStore;
  readonly journal: TelemetryJournal;
  readonly errors: TelemetryErrorStore;
  readonly exemplars: TelemetryExemplarStore;
  readonly aggregate: TelemetryAggregateStore;

  constructor(options: TelemetrySidecarStoresOptions) {
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
    this.aggregate = new TelemetryAggregateStore(this.store, options.generation);
  }

  /** Route one accepted record to the kind that owns its table. */
  write(kind: TelemetryRecordKind, value: unknown): void {
    switch (kind) {
      case "log":
      case "analytics":
        this.journal.appendDirect(value as TelemetryJournalRecord);
        return;
      case "error":
        this.errors.ingestDirect(value as TelemetryErrorIngest);
        return;
      case "exemplar":
        this.exemplars.writeDirect(value as TraceExemplar);
        return;
      case "aggregate": {
        const handoff = value as AggregateHandoffPayload;
        this.aggregate.writeDirect(handoff.startMs, handoff.closed, handoff.rows);
        return;
      }
    }
  }
}
