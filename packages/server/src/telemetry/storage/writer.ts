/**
 * What the serving thread knows about durable telemetry: accept a record, look
 * at the accounting, seal.
 *
 * The bounded ring, the pre-serialized handoff, the sequence numbers and the
 * acknowledged watermark are all behind this. They are what let `drain()` claim
 * anything at all, and they are none of the Runtime's business.
 *
 * Two implementations, chosen once by whether there is a file to own. A
 * file-backed engine gets the worker, because that is where the incident
 * isolation lives — the retained fraction approaches 100% during an outage and
 * the serving thread must not be the one committing it. An in-memory engine has
 * no durable sidecar to isolate: a worker would open its own private `:memory:`
 * database that nothing on this thread could ever read, so it writes inline.
 */
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
  readonly containedFailures: number;
  readonly failed: boolean;
}

export interface TelemetrySidecarSeal {
  readonly snapshot: TelemetrySidecarSnapshot;
  /** True when the sidecar never acknowledged everything the drain sealed at. */
  readonly timedOut: boolean;
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
}
