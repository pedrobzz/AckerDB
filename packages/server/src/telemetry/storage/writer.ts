/**
 * What the serving thread knows about durable telemetry: accept a record, look
 * at the accounting, read the export queue, seal.
 *
 * The bounded ring, the pre-serialized handoff, the sequence numbers and the
 * acknowledged watermark are all behind this. They are what let `seal()` claim
 * anything at all, and they are none of the Runtime's business.
 *
 * Two implementations, chosen once by whether there is a file to own. A
 * file-backed engine gets the worker, because that is where the incident
 * isolation lives — the retained fraction approaches 100% during an outage and
 * the serving thread must not be the one committing it. An in-memory engine has
 * no durable sidecar to isolate: a worker would open its own private `:memory:`
 * database that nothing on this thread could ever read, so it writes inline.
 */
import type {
  TelemetryConsumerAdvance,
  TelemetryConsumerBatch,
  TelemetryConsumerSnapshot,
} from "../application-signals/journal.ts";
import type { TelemetryShedSnapshot } from "./admission.ts";
import type { TelemetryRecordKind } from "./worker/protocol.ts";

export interface TelemetrySidecarSnapshot {
  readonly acceptedRecords: number;
  readonly droppedRecords: number;
  readonly acceptedByKind: Readonly<Record<string, number>>;
  readonly droppedByKind: Readonly<Record<string, number>>;
  readonly queuedRecords: number;
  readonly queuedBytes: number;
  /** Highest sequence the sidecar has committed; the quiescence watermark. */
  readonly durableSeq: number;
  readonly acceptedSeq: number;
  readonly committedRecords: number;
  readonly rejectedRecords: number;
  readonly storedBytes: number;
  readonly walBytes: number;
  /** Admission's own accounting: what pressure shed, by reason and by kind. */
  readonly shed: TelemetryShedSnapshot;
  readonly containedFailures: number;
  readonly failed: boolean;
}

export interface TelemetrySidecarSeal {
  readonly snapshot: TelemetrySidecarSnapshot;
  /** True when the sidecar never acknowledged everything the drain sealed at. */
  readonly timedOut: boolean;
}

/**
 * The consumer side of the durable journal, reachable from the serving thread.
 *
 * The exporters cannot move to the thread that owns the connection: a
 * `TelemetrySignalExporter` is an application-supplied closure and a closure
 * does not cross a thread. So the *work* stays here and the *cursor* stays in
 * the sidecar — batches travel up, the closure runs on this thread, and the
 * advance travels back down. Durability is unaffected, because at no point does
 * a cursor live anywhere but in the file it describes.
 *
 * The consequence is the delivery contract, and it is the same one the
 * synchronous shape had: a batch is at-least-once. A process that dies between
 * running a closure and committing its advance re-delivers that batch to the
 * next process, because the alternative — advancing first — loses it instead.
 */
export interface TelemetryExportPort {
  /** Fires when the sidecar commits new rows, so a consumer can wake. */
  onPersist(listener: () => void): () => void;
  batch(name: string, limit: number): Promise<TelemetryConsumerBatch>;
  advance(
    name: string,
    cursor: bigint,
    advance: TelemetryConsumerAdvance,
  ): Promise<TelemetryConsumerSnapshot>;
  failure(name: string, timedOut: boolean): Promise<TelemetryConsumerSnapshot>;
}

export interface TelemetrySidecarWriter {
  /**
   * Accept one record. Total and non-blocking: a full ring drops the newest and
   * counts it, which is the sanctioned degradation — an unbounded queue converts
   * loss into unbounded memory growth, a worse failure on a 4 GiB envelope.
   */
  accept(kind: TelemetryRecordKind, record: unknown): boolean;
  snapshot(): TelemetrySidecarSnapshot;
  /** Resolves once the sidecar has committed everything accepted before the seal. */
  seal(terminal: unknown | undefined, deadlineAtMs: number): Promise<TelemetrySidecarSeal>;
  /** Fires when the sidecar's connection is proven unusable. */
  onFailure(listener: (error: unknown) => void): () => void;
  readonly exports: TelemetryExportPort;
}

/** The ring in front of the sidecar; the only queue any signal waits in. */
export interface TelemetrySidecarQueueLimits {
  /** Records the ring may hold before it drops the newest. */
  readonly maxQueuedRecords: number;
  readonly maxQueuedBytes: number;
  /**
   * One record's serialized size on the handoff; a larger one is an accounted
   * drop. It bounds the ring's strings, so it applies to the worker writer
   * alone: the inline writer queues object references the producer already
   * holds, where a byte cap would mean serializing every record purely to
   * measure it. What both engines share is the store's own disk guard.
   */
  readonly maxRecordBytes: number;
  /** Records the serving thread accumulates before one handoff. */
  readonly handoffBatch: number;
  /** Rows the sidecar accumulates before it opens a transaction. */
  readonly commitBatch: number;
  /** Bound on how long a below-threshold record waits for a handoff. */
  readonly maxHandoffDelayMs: number;
  /** Bound on how long the sidecar holds a below-threshold batch uncommitted. */
  readonly commitDelayMs: number;
}

export const DEFAULT_SIDECAR_QUEUE_LIMITS: TelemetrySidecarQueueLimits = Object.freeze({
  maxQueuedRecords: 65_536,
  maxQueuedBytes: 64 * 1_024 * 1_024,
  maxRecordBytes: 512 * 1_024,
  // Count OR time, never count alone. A count-only threshold makes durability
  // lag inversely proportional to traffic: at ten operations a second, a
  // 1,400-record handoff plus a 512-row commit is minutes of lag on a record the
  // application already considers accepted.
  handoffBatch: 1_400,
  commitBatch: 512,
  maxHandoffDelayMs: 5,
  commitDelayMs: 25,
});
