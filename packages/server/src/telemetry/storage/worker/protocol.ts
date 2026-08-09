/**
 * PROTOTYPE (proto/telemetry-worker). The message contract between the serving
 * thread and the thread that owns the telemetry sidecar's SQLite connection.
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

/**
 * One accepted record's kind; the worker routes on it. Every signal crosses the
 * same boundary: logs and analytics because ADR-0017 makes them durable and they
 * are never sampled, errors because an error storm must not stall an application
 * that is already failing, exemplars because they are the retained minority of
 * traces, and aggregate buckets because the thread that owns the connection is
 * the only one allowed to write it.
 */
export type TelemetryRecordKind =
  | "log"
  | "analytics"
  | "error"
  | "exemplar"
  | "aggregate";

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

export type TelemetryWorkerCommand =
  | TelemetryWorkerOpen
  | TelemetryWorkerRecords
  | TelemetryWorkerSeal
  | TelemetryWorkerStatsRequest;

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

export type TelemetryWorkerEvent =
  | TelemetryWorkerReady
  | TelemetryWorkerWatermark
  | TelemetryWorkerSealed
  | TelemetryWorkerStatsReply
  | TelemetryWorkerFailure;

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
