/**
 * The message contract between the serving thread and the thread that owns the
 * telemetry sidecar's SQLite connection.
 *
 * Records cross as ONE pre-serialized string per batch, newline framed. A
 * structured clone of an object graph costs about four microseconds per
 * operation's worth of spans; the same batch as an already-serialized string is
 * roughly a memcpy. Serializing at accept time also spreads the cost evenly over
 * requests instead of landing a whole batch's clone on whichever unlucky request
 * happens to trigger the flush.
 *
 * **Sequence numbers are assigned at accept, before the record enters the ring.**
 * `opentelemetry-rust` #3453 was exactly the other order: a flush read a counter
 * that did not yet include items already accepted, so `force_flush` and
 * `shutdown` reported success while silently dropping them. Quiescence here is
 * therefore never "the promise resolved" — it is "the worker acknowledged a
 * durable watermark at or past the sequence this drain sealed at".
 */
import type {
  TelemetryConsumerSnapshot,
} from "../../application-signals/journal.ts";
import type { TelemetryJournalEntry } from "../../application-signals/types.ts";

/**
 * One accepted record's kind; the worker routes on it. Every signal crosses the
 * same boundary: logs and analytics because ADR-0017 makes them durable and they
 * are never sampled, errors because an error storm must not stall an application
 * that is already failing, exemplars because they are the retained minority of
 * traces, and aggregate buckets because the thread that owns the connection is
 * the only one allowed to write it.
 */
export const TELEMETRY_RECORD_KINDS = Object.freeze([
  "log",
  "analytics",
  "error",
  "exemplar",
  "aggregate",
] as const);

export type TelemetryRecordKind = (typeof TELEMETRY_RECORD_KINDS)[number];

/** Every kind starts at zero, so a signal that never arrived reads as zero. */
export function kindCounters(): Record<string, number> {
  const counters: Record<string, number> = {};
  for (const kind of TELEMETRY_RECORD_KINDS) counters[kind] = 0;
  return counters;
}

export interface TelemetryWorkerOpen {
  readonly type: "open";
  readonly path: string;
  /** Rows the worker accumulates before it opens a transaction. */
  readonly commitBatch: number;
  /** Bound on how long a below-threshold batch waits before committing anyway. */
  readonly commitDelayMs: number;
  /** Identifies this process, so a minute left open by another one is visible. */
  readonly generation: string;
  readonly retention?: Readonly<Record<string, number>>;
  readonly maxStoredBytes?: number;
}

export interface TelemetryWorkerRecords {
  readonly type: "records";
  /** Highest sequence contained in this payload. */
  readonly through: number;
  /** Newline-framed `kind\tjson` lines. */
  readonly payload: string;
}

/** Seal the stream at `through`: commit everything up to it, then acknowledge. */
export interface TelemetryWorkerSeal {
  readonly type: "seal";
  readonly through: number;
  /** The terminal lifecycle row, appended after the queue drains. */
  readonly terminal?: string;
}

export interface TelemetryWorkerStatsRequest {
  readonly type: "stats";
  readonly token: number;
}

/**
 * One export consumer's cursor operation, run against the journal by the thread
 * that owns it. The exporter closure itself stays on the serving thread — an
 * application-supplied function cannot cross a thread — so only the cursor work
 * comes here, which is exactly the part that must be durable.
 *
 * The three requests share one command because they share one reply: every one
 * of them answers with the consumer's resulting cursor row, and a batch answers
 * with records besides. Splitting them would be three tokens, three waiter maps
 * and three failure paths for one round trip.
 */
export type TelemetryExportRequest =
  | { readonly kind: "batch"; readonly limit: number }
  | {
    readonly kind: "advance";
    readonly cursor: bigint;
    readonly exportedRecords: number;
    readonly skippedUnsupported: number;
    readonly skippedIdentity: number;
  }
  | { readonly kind: "failure"; readonly timedOut: boolean };

export interface TelemetryWorkerExport {
  readonly type: "export";
  readonly token: number;
  readonly name: string;
  readonly request: TelemetryExportRequest;
}

export type TelemetryWorkerCommand =
  | TelemetryWorkerOpen
  | TelemetryWorkerRecords
  | TelemetryWorkerSeal
  | TelemetryWorkerStatsRequest
  | TelemetryWorkerExport;

/** Accounting the worker owns and the serving thread can only observe. */
export interface TelemetryWorkerStats {
  /** Highest sequence the worker has COMMITTED. The quiescence watermark. */
  readonly durableSeq: number;
  /** Records parsed but not yet committed — the worker's own queue depth. */
  readonly pendingRecords: number;
  readonly pendingBytes: number;
  /** Milliseconds since the oldest uncommitted record was accepted. */
  readonly oldestPendingAgeMs: number;
  readonly committedRecords: number;
  readonly committedTransactions: number;
  readonly rejectedRecords: number;
  readonly storedBytes: number;
  readonly walBytes: number;
  readonly freeBytes: number;
  /** How close the sidecar is to being unable to write; admission scales by it. */
  readonly pressure: number;
  /** Below the free-space floor, nothing is written at all. */
  readonly readOnly: boolean;
  readonly containedFailures: number;
  readonly failed: boolean;
}

export interface TelemetryWorkerReady {
  readonly type: "ready";
}

export interface TelemetryWorkerWatermark {
  readonly type: "watermark";
  readonly stats: TelemetryWorkerStats;
}

export interface TelemetryWorkerSealed {
  readonly type: "sealed";
  readonly through: number;
  readonly stats: TelemetryWorkerStats;
  readonly terminalWritten: boolean;
  readonly error?: string;
}

export interface TelemetryWorkerStatsReply {
  readonly type: "stats";
  readonly token: number;
  readonly stats: TelemetryWorkerStats;
}

export interface TelemetryWorkerFailure {
  readonly type: "failure";
  readonly message: string;
}

/**
 * The answer to one export request. `error` and `consumer` are exclusive: a
 * cursor operation that threw must never reply with a cursor row, because the
 * pump would read it as the operation having happened.
 */
export interface TelemetryWorkerExportReply {
  readonly type: "export";
  readonly token: number;
  readonly consumer?: TelemetryConsumerSnapshot;
  /** Present only for a batch request that succeeded. */
  readonly records?: readonly TelemetryJournalEntry[];
  readonly error?: string;
}

export type TelemetryWorkerEvent =
  | TelemetryWorkerReady
  | TelemetryWorkerWatermark
  | TelemetryWorkerSealed
  | TelemetryWorkerStatsReply
  | TelemetryWorkerFailure
  | TelemetryWorkerExportReply;

export const RECORD_SEPARATOR = "\n";
export const FIELD_SEPARATOR = "\t";

/**
 * Telemetry records carry bigints — a log record's process sequence, an
 * analytics event's Identity — and `JSON.stringify` throws on them rather than
 * dropping them, so without this every log and every analytics event is refused
 * at the boundary while spans sail through. The prototype found exactly that.
 */
export function encodeRecordValue(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? { $bigint: value.toString() } : value;
}

export function decodeRecordValue(_key: string, value: unknown): unknown {
  return value !== null &&
      typeof value === "object" &&
      typeof (value as { $bigint?: unknown }).$bigint === "string"
    ? BigInt((value as { $bigint: string }).$bigint)
    : value;
}
