import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  ACKERDB_VERSION,
  OUTCOME_CODES,
  RESOURCE_CLASSES,
  encodeSseChunk,
  encodeSseControl,
  type Outcome,
} from "@ackerdb/core";
import { AckerDBError, isAckerDBError } from "../../shared/errors.ts";
import type { ServiceLimits } from "../../runtime/limits.ts";
import { PUBLIC_ERROR_FALLBACK, fitOutcome, outcomeFromError } from "../../runtime/outcome.ts";
import type { OutboundBudget, OutboundReservation } from "./budget.ts";
import { overloaded, slowConsumer, unavailable } from "./failure.ts";
import {
  SYSTEM_CLOCK,
  captureDeliveryObserver,
  deliveryInstrumentation,
  deliveryTiming,
  observationNow,
  observeEncoding,
  observeTiming,
  safeDeliveryOutcome,
  type DeliveryClock,
  type DeliveryInstrumentation,
  type DeliveryObserver,
  type DeliveryOutcome,
  type DeliverySource,
  type DeliveryTiming,
} from "./observation.ts";

export interface BoundedSseProducerOptions {
  readonly budget: OutboundBudget;
  readonly limits: ServiceLimits;
  readonly signal?: AbortSignal;
  readonly clock?: DeliveryClock;
  readonly observer?: DeliveryObserver;
}

export interface SseDeliverySnapshot {
  readonly unackedBytes: number;
  readonly unackedFrames: number;
  readonly state: "open" | "ending" | "closed";
  readonly mergeActive: boolean;
}

interface StreamReservation {
  readonly seq: number;
  readonly proof: string;
  readonly reservation: OutboundReservation;
  readonly timing?: DeliveryTiming;
}

interface ObservedSseFrame {
  readonly seq: number;
  readonly proof: string;
  readonly bytes: Uint8Array;
  readonly timing: DeliveryTiming | undefined;
}

interface PreparedSseChunk {
  readonly source: Extract<DeliverySource, "write" | "merge">;
  readonly seq: number;
  readonly proof: string;
  readonly bytes: Uint8Array;
  readonly observer: DeliveryObserver | undefined;
  readonly encodingStartedAt: number | undefined;
  readonly encodingFinishedAt: number | undefined;
}

interface Waiter {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

function waiter(): Waiter {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

const SSE_PROOF_LENGTH = 22;

function sseProof(): string {
  return randomBytes(16).toString("base64url");
}

function sameProof(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

function sseDoneBytes(seq: number, proof: string): Uint8Array {
  return encodeSseControl({ v: ACKERDB_VERSION, t: "sse_done", seq, proof });
}

function sseErrorBytes(error: AckerDBError, maxBytes: number, seq: number, proof: string): Uint8Array {
  const outcome = outcomeFromError(error);
  const fitted = fitOutcome(outcome, maxBytes, (candidate) => {
    const value = encodeSseControl({
      v: ACKERDB_VERSION,
      t: "sse_error",
      seq,
      proof,
      outcome: candidate,
    });
    return { value, bytes: value.byteLength };
  });
  if (fitted === null) {
    throw new RangeError("SSE control reserve cannot encode a terminal outcome");
  }
  return fitted.value;
}

const MAXIMUM_SSE_SEQUENCE = Number.MAX_SAFE_INTEGER;
const MAXIMUM_SSE_PROOF = "x".repeat(SSE_PROOF_LENGTH);
const MINIMUM_SSE_CHUNK_FIXED_BYTES =
  encodeSseChunk(1, MAXIMUM_SSE_PROOF, 0).byteLength - 1;
const MAXIMUM_SSE_RESOURCE = RESOURCE_CLASSES.reduce(
  (longest, resource) => resource.length > longest.length ? resource : longest,
);
// The reserve has to hold the largest terminal frame this producer can emit,
// and which outcome that is must be read off the vocabulary rather than named:
// a code that is renamed or added would otherwise leave the reserve sized for a
// frame that no longer exists, and `fitOutcome` would have nowhere to put even
// the fallback message. `convergence_unavailable` is excluded here because it
// cannot be retryable and so cannot carry `retryAfterMs`; its own optional set
// is measured as the second shape below.
const MAXIMUM_RETRYABLE_SSE_CODE = OUTCOME_CODES
  .filter((code) => code !== "convergence_unavailable")
  .reduce((longest, code) => (code.length > longest.length ? code : longest));
const MINIMUM_SSE_CONTROL_BYTES = Math.max(
  sseErrorBytes(new AckerDBError(MAXIMUM_RETRYABLE_SSE_CODE, PUBLIC_ERROR_FALLBACK, {
    retryable: true,
    retryAfterMs: 30_000,
    resource: MAXIMUM_SSE_RESOURCE,
  }), Number.MAX_SAFE_INTEGER, MAXIMUM_SSE_SEQUENCE, MAXIMUM_SSE_PROOF).byteLength,
  sseErrorBytes(new AckerDBError("convergence_unavailable", PUBLIC_ERROR_FALLBACK, {
    committed: true,
    resource: "subscription",
  }), Number.MAX_SAFE_INTEGER, MAXIMUM_SSE_SEQUENCE, MAXIMUM_SSE_PROOF).byteLength,
  sseDoneBytes(MAXIMUM_SSE_SEQUENCE, MAXIMUM_SSE_PROOF).byteLength,
);

interface SseSourceReader {
  read(): Promise<{ readonly done: boolean; readonly value?: unknown }>;
  cancel(reason?: unknown): Promise<void>;
  releaseLock(): void;
}

/**
 * A receiver-credited SSE source. Direct writes are finite; a merge owns at
 * most one unacknowledged frame and never retains a pulled value while waiting.
 *
 * Chunk values are standard JSON: this producer serves the exposed HTTP
 * surface, whose wire format is the one the OpenAPI document publishes, and the
 * exposed function's codec has already converted every contract-typed value.
 * The `sse_chunk`/`sse_done`/`sse_error` envelope around them is unchanged
 * Protocol-2.
 */
export class BoundedSseProducer {
  readonly stream: ReadableStream<Uint8Array>;
  readonly signal: AbortSignal;
  readonly controlReserveBytes: number;
  private readonly finishedWaiter = waiter();
  readonly finished = this.finishedWaiter.promise;

  private readonly budget: OutboundBudget;
  private readonly limits: ServiceLimits;
  private readonly clock: DeliveryClock;
  private readonly delivery: DeliveryInstrumentation | undefined;
  private readonly controller: ReadableStreamDefaultController<Uint8Array>;
  private readonly abortController = new AbortController();
  private readonly reservations = new Map<number, StreamReservation>();
  private readonly externalSignal: AbortSignal | undefined;
  private readonly externalAbort: (() => void) | undefined;
  private terminalReservation: OutboundReservation | null = null;
  private unackedBytes = 0;
  private nextSequence = 1;
  private acknowledgedSequence = 0;
  private state: "open" | "ending" | "closed" = "open";
  private failure: AckerDBError | null = null;
  private closureError: AckerDBError | null = null;
  private activeMerge: Promise<void> | null = null;
  private activeReader: SseSourceReader | null = null;
  private emptyWaiter: Waiter | null = null;
  private closedWaiter: Waiter | null = null;
  private completion: Promise<void> | null = null;
  private stallSince: number | null = null;
  private stallTimer: unknown;

  constructor(options: BoundedSseProducerOptions) {
    const maxBytes = options.limits.sse.maxBytesPerStream;
    this.controlReserveBytes = Math.max(
      MINIMUM_SSE_CONTROL_BYTES,
      Math.min(1_024, Math.floor(maxBytes / 8)),
    );
    if (this.controlReserveBytes >= maxBytes) {
      throw new RangeError("sse.maxBytesPerStream is too small for a terminal outcome");
    }
    if (options.limits.maxFrameBytes > maxBytes) {
      throw new RangeError("maxFrameBytes cannot exceed sse.maxBytesPerStream");
    }
    this.budget = options.budget;
    this.limits = options.limits;
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.delivery = deliveryInstrumentation(options.observer, this.clock, "sse");
    this.externalSignal = options.signal;
    this.signal = this.abortController.signal;

    let controller!: ReadableStreamDefaultController<Uint8Array>;
    this.stream = new ReadableStream<Uint8Array>(
      {
        start: (value) => {
          controller = value;
        },
        cancel: (reason) => {
          this.cancel(reason, false);
        },
      },
      new ByteLengthQueuingStrategy({ highWaterMark: maxBytes }),
    );
    this.controller = controller;

    const terminalReservation = this.budget.reserve(this.controlReserveBytes, "control");
    if (terminalReservation === null) {
      throw overloaded("sse", "global SSE control byte limit exceeded");
    }
    this.terminalReservation = terminalReservation;

    if (options.signal !== undefined) {
      this.externalAbort = () => this.cancel(options.signal!.reason, true);
      if (options.signal.aborted) this.externalAbort();
      else options.signal.addEventListener("abort", this.externalAbort, { once: true });
    } else {
      this.externalAbort = undefined;
    }
  }

  write(chunk: unknown): void {
    try {
      this.preflightApplication();
    } catch (error) {
      this.failWrite(error);
    }
    const prepared = this.prepareApplicationFrame("write", chunk);
    try {
      this.preflightApplication();
      const frame = this.materializeApplicationFrame(prepared);
      this.enqueueApplication(frame);
    } catch (error) {
      this.failWrite(error);
    }
  }

  merge(source: ReadableStream<unknown>): Promise<void> {
    if (this.activeMerge !== null) {
      throw new TypeError("only one SSE merge may be active at a time");
    }
    if (this.state !== "open") throw this.failure ?? unavailable("sse", "SSE stream is closed");
    const run = this.consume(source);
    this.activeMerge = run;
    return run;
  }

  complete(): Promise<void> {
    if (this.completion !== null) return this.completion;
    this.completion = this.completeOpenStream();
    return this.completion;
  }

  fail(error: unknown): void {
    this.terminate(
      isAckerDBError(error) ? error : new AckerDBError("internal", "SSE producer failed", { cause: error }),
    );
  }

  snapshot(): SseDeliverySnapshot {
    return Object.freeze({
      unackedBytes: this.unackedBytes,
      unackedFrames: this.reservations.size,
      state: this.state,
      mergeActive: this.activeMerge !== null,
    });
  }

  ack(seq: number, proof: string): boolean {
    if (
      !Number.isSafeInteger(seq) ||
      seq < 1 ||
      typeof proof !== "string" ||
      proof.length !== SSE_PROOF_LENGTH
    ) {
      return false;
    }
    if (seq <= this.acknowledgedSequence || seq >= this.nextSequence) return false;
    const boundary = this.reservations.get(seq);
    if (boundary === undefined || !sameProof(boundary.proof, proof)) {
      return false;
    }

    this.releaseThrough(seq);
    this.acknowledgedSequence = seq;
    if (this.unackedBytes === 0) {
      this.clearStall();
      this.emptyWaiter?.resolve();
      this.emptyWaiter = null;
      if (this.state === "ending") this.finishClose();
    } else {
      this.restartStall();
    }
    return true;
  }

  private async consume(source: ReadableStream<unknown>): Promise<void> {
    const reader = source.getReader();
    this.activeReader = reader;
    try {
      for (;;) {
        if (this.state !== "open") throw this.failure ?? unavailable("sse", "SSE stream is closed");
        await this.waitForEmpty();
        this.preflightApplication();
        const part = await reader.read();
        this.preflightApplication();
        if (part.done) return;
        if (this.unackedBytes !== 0) {
          throw slowConsumer("sse", "SSE merge credit was consumed while awaiting its source");
        }
        const prepared = this.prepareApplicationFrame("merge", part.value);
        this.preflightApplication();
        if (this.unackedBytes !== 0) {
          throw slowConsumer("sse", "SSE merge credit was consumed while encoding its source");
        }
        const frame = this.materializeApplicationFrame(prepared);
        this.enqueueApplication(frame);
      }
    } catch (error) {
      const terminal = isAckerDBError(error)
        ? error
        : new AckerDBError("internal", "SSE merge failed", { cause: error });
      this.terminate(terminal);
      throw terminal;
    } finally {
      if (this.activeReader === reader) this.activeReader = null;
      reader.releaseLock();
      this.activeMerge = null;
    }
  }

  private prepareApplicationFrame(
    source: Extract<DeliverySource, "write" | "merge">,
    value: unknown,
  ): PreparedSseChunk {
    const observer = captureDeliveryObserver(this.delivery, "application");
    const encodingStartedAt = observer === undefined ? undefined : observationNow(this.delivery);
    try {
      const seq = this.nextSequence;
      const proof = sseProof();
      const bytes = encodeSseChunk(seq, proof, value);
      return {
        source,
        seq,
        proof,
        bytes,
        observer,
        encodingStartedAt,
        encodingFinishedAt: observer === undefined ? undefined : observationNow(this.delivery),
      };
    } catch (error) {
      observeEncoding(
        this.delivery,
        observer,
        "application",
        source,
        encodingStartedAt,
        0,
        safeDeliveryOutcome(error),
      );
      throw error;
    }
  }

  private candidateApplicationBytes(frame: PreparedSseChunk): number {
    if (this.nextSequence >= MAXIMUM_SSE_SEQUENCE) {
      throw overloaded("sse", "SSE sequence space exhausted");
    }
    if (frame.seq !== this.nextSequence) {
      throw new Error("SSE frame sequence changed while it was being prepared");
    }
    return frame.bytes.byteLength;
  }

  private materializeApplicationFrame(frame: PreparedSseChunk): ObservedSseFrame {
    const expectedBytes = this.candidateApplicationBytes(frame);
    const { seq, proof, bytes } = frame;
    if (bytes.byteLength !== expectedBytes) throw new Error("SSE frame byte accounting mismatch");
    observeEncoding(
      this.delivery,
      frame.observer,
      "application",
      frame.source,
      frame.encodingStartedAt,
      bytes.byteLength,
      "ok",
      undefined,
      frame.encodingFinishedAt,
    );
    const timing = frame.observer === undefined || frame.encodingFinishedAt === undefined
      ? undefined
      : {
          observer: frame.observer,
          source: frame.source,
          bytes: bytes.byteLength,
          queueStartedAt: frame.encodingFinishedAt,
        };
    return { seq, proof, bytes, timing };
  }

  private encodeTerminalFrame(
    encodeFrame: (seq: number, proof: string) => Uint8Array,
    terminalOutcome?: Outcome["code"],
  ): ObservedSseFrame {
    if (this.nextSequence > MAXIMUM_SSE_SEQUENCE) {
      throw overloaded("sse", "SSE sequence space exhausted");
    }
    const seq = this.nextSequence;
    const proof = sseProof();
    const observer = captureDeliveryObserver(this.delivery, "control");
    const startedAt = observer === undefined ? undefined : observationNow(this.delivery);
    let bytes: Uint8Array;
    try {
      bytes = encodeFrame(seq, proof);
    } catch (error) {
      observeEncoding(
        this.delivery,
        observer,
        "control",
        "terminal",
        startedAt,
        0,
        safeDeliveryOutcome(error),
        terminalOutcome,
      );
      throw error;
    }
    observeEncoding(
      this.delivery,
      observer,
      "control",
      "terminal",
      startedAt,
      bytes.byteLength,
      "ok",
      terminalOutcome,
    );
    const timing = deliveryTiming(
      this.delivery,
      observer,
      "terminal",
      bytes.byteLength,
      terminalOutcome,
    );
    return { seq, proof, bytes, timing };
  }

  private enqueueApplication(frame: ObservedSseFrame): void {
    const { bytes, timing } = frame;
    let reservation: OutboundReservation;
    try {
      if (this.state !== "open") throw this.failure ?? unavailable("sse", "SSE stream is closed");
      this.validateApplicationFrame(bytes.byteLength);
      if (this.unackedBytes + bytes.byteLength > this.applicationLimit()) {
        throw slowConsumer("sse", "SSE producer exceeded the consumer byte budget");
      }
      const admitted = this.budget.reserve(bytes.byteLength, "application");
      if (admitted === null) {
        throw overloaded("sse", "global SSE outbound byte limit exceeded");
      }
      reservation = admitted;
    } catch (error) {
      observeTiming(
        this.delivery,
        "application",
        timing,
        "queue",
        safeDeliveryOutcome(error),
      );
      throw error;
    }
    this.enqueue(frame, reservation);
  }

  private validateApplicationFrame(bytes: number): void {
    if (bytes > this.limits.maxFrameBytes || bytes > this.applicationLimit()) {
      throw overloaded("sse", "SSE event exceeds maxFrameBytes");
    }
  }

  private enqueue(
    frame: ObservedSseFrame,
    reservation: OutboundReservation,
  ): void {
    const { seq, proof, bytes, timing } = frame;
    if (seq !== this.nextSequence) {
      reservation.release();
      throw new Error("SSE frames must enqueue in sequence order");
    }
    const owned = timing === undefined
      ? { seq, proof, reservation }
      : { seq, proof, reservation, timing };
    this.reservations.set(seq, owned);
    this.unackedBytes += bytes.byteLength;
    try {
      this.controller.enqueue(bytes);
      this.nextSequence = seq + 1;
    } catch (error) {
      this.reservations.delete(seq);
      this.unackedBytes -= bytes.byteLength;
      reservation.release();
      observeTiming(
        this.delivery,
        reservation.lane,
        timing,
        "queue",
        safeDeliveryOutcome(error),
      );
      throw error;
    }
    if (timing !== undefined) {
      observeTiming(this.delivery, reservation.lane, timing, "queue", "ok");
      timing.deliveryStartedAt = observationNow(this.delivery);
    }
    this.armStall();
  }

  private applicationLimit(): number {
    return this.limits.sse.maxBytesPerStream - this.controlReserveBytes;
  }

  private preflightApplication(): void {
    if (this.state !== "open") throw this.failure ?? unavailable("sse", "SSE stream is closed");
    if (this.nextSequence >= MAXIMUM_SSE_SEQUENCE) {
      throw overloaded("sse", "SSE sequence space exhausted");
    }
    const minimumBytes = MINIMUM_SSE_CHUNK_FIXED_BYTES + String(this.nextSequence).length;
    if (minimumBytes > this.limits.maxFrameBytes || minimumBytes > this.applicationLimit()) {
      throw overloaded("sse", "SSE event envelope exceeds maxFrameBytes");
    }
    if (minimumBytes > this.applicationLimit() - this.unackedBytes) {
      throw slowConsumer("sse", "SSE producer exceeded the consumer byte budget");
    }
    if (minimumBytes > this.budget.availableBytes("application")) {
      throw overloaded("sse", "global SSE outbound byte limit exceeded");
    }
  }

  private failWrite(error: unknown): never {
    const terminal = isAckerDBError(error)
      ? error
      : new AckerDBError("internal", "SSE producer failed", { cause: error });
    this.terminate(terminal);
    throw terminal;
  }

  private releaseThrough(seq: number): void {
    let current = this.acknowledgedSequence + 1;
    for (;;) {
      const item = this.reservations.get(current);
      if (item === undefined) throw new Error("SSE acknowledgment range is not contiguous");
      this.reservations.delete(current);
      const bytes = item.reservation.remainingBytes;
      item.reservation.release();
      this.unackedBytes -= bytes;
      if (item.timing !== undefined) {
        observeTiming(this.delivery, item.reservation.lane, item.timing, "delivery", "ok");
      }
      if (current === seq) break;
      current++;
    }
    if (this.unackedBytes < 0) throw new Error("SSE byte accounting underflow");
  }

  private releaseAll(outcome: DeliveryOutcome = "unavailable"): void {
    this.terminalReservation?.release();
    this.terminalReservation = null;
    for (const item of this.reservations.values()) {
      item.reservation.release();
      if (item.timing !== undefined) {
        observeTiming(this.delivery, item.reservation.lane, item.timing, "delivery", outcome);
      }
    }
    this.reservations.clear();
    this.unackedBytes = 0;
  }

  private consumeTerminalReservation(bytes: number): OutboundReservation {
    const reservation = this.terminalReservation;
    if (reservation === null || bytes > reservation.remainingBytes) {
      throw new Error("SSE terminal reservation underflow");
    }
    this.terminalReservation = null;
    reservation.release(reservation.remainingBytes - bytes);
    return reservation;
  }

  private waitForEmpty(): Promise<void> {
    if (this.unackedBytes === 0) return Promise.resolve();
    if (this.emptyWaiter === null) this.emptyWaiter = waiter();
    return this.emptyWaiter.promise;
  }

  private waitForClosed(): Promise<void> {
    if (this.state === "closed") {
      return this.closureError === null ? Promise.resolve() : Promise.reject(this.closureError);
    }
    if (this.closedWaiter === null) this.closedWaiter = waiter();
    return this.closedWaiter.promise;
  }

  private async completeOpenStream(): Promise<void> {
    if (this.state === "ending") return this.waitForClosed();
    if (this.state === "closed") return this.waitForClosed();
    const merge = this.activeMerge;
    if (merge !== null) {
      try {
        await merge;
      } catch (error) {
        if ((this.state as SseDeliverySnapshot["state"]) !== "open") return this.waitForClosed();
        throw error;
      }
    }
    if ((this.state as SseDeliverySnapshot["state"]) !== "open") return this.waitForClosed();
    try {
      await this.waitForEmpty();
    } catch (error) {
      if ((this.state as SseDeliverySnapshot["state"]) !== "open") return this.waitForClosed();
      throw error;
    }
    if ((this.state as SseDeliverySnapshot["state"]) !== "open") return this.waitForClosed();
    const frame = this.encodeTerminalFrame(
      (seq, proof) => sseDoneBytes(seq, proof),
    );
    let reservation: OutboundReservation;
    try {
      reservation = this.consumeTerminalReservation(frame.bytes.byteLength);
    } catch (error) {
      observeTiming(
        this.delivery,
        "control",
        frame.timing,
        "queue",
        safeDeliveryOutcome(error),
      );
      throw error;
    }
    this.state = "ending";
    try {
      this.enqueue(frame, reservation);
    } catch (error) {
      const terminal = isAckerDBError(error)
        ? error
        : new AckerDBError("internal", "SSE producer failed", { cause: error });
      this.forceClose(terminal, "internal");
      throw terminal;
    }
    await this.waitForClosed();
  }

  private terminate(error: AckerDBError): void {
    if (this.state !== "open") return;
    this.failure = error;
    this.state = "ending";
    if (!this.abortController.signal.aborted) this.abortController.abort(error);
    const reader = this.activeReader;
    if (reader !== null) void reader.cancel(error).then(undefined, () => {});
    this.emptyWaiter?.reject(error);
    this.emptyWaiter = null;
    this.clearStall();

    const terminalOutcome = outcomeFromError(error).code;
    let frame: ObservedSseFrame;
    try {
      frame = this.encodeTerminalFrame(
        (seq, proof) => sseErrorBytes(error, this.controlReserveBytes, seq, proof),
        terminalOutcome,
      );
    } catch {
      this.forceClose(error, "internal");
      return;
    }
    let reservation: OutboundReservation;
    try {
      reservation = this.consumeTerminalReservation(frame.bytes.byteLength);
    } catch (cause) {
      observeTiming(
        this.delivery,
        "control",
        frame.timing,
        "queue",
        safeDeliveryOutcome(cause),
      );
      this.forceClose(error, "internal");
      return;
    }
    try {
      this.enqueue(frame, reservation);
    } catch {
      this.forceClose(error, "internal");
    }
  }

  private cancel(reason: unknown, terminateStream: boolean): void {
    if (this.state === "closed") return;
    const error = unavailable("sse", "SSE consumer canceled the stream");
    this.failure = error;
    this.closureError = error;
    if (!this.abortController.signal.aborted) this.abortController.abort(reason ?? error);
    const reader = this.activeReader;
    if (reader !== null) void reader.cancel(reason).then(undefined, () => {});
    this.emptyWaiter?.reject(error);
    this.closedWaiter?.reject(error);
    this.emptyWaiter = null;
    this.closedWaiter = null;
    this.clearStall();
    if (terminateStream) {
      // A AckerDBError reason (other than the caller canceling its own request)
      // is a server-decided outcome the consumer may still observe. Anything
      // else is the transport reporting that the consumer is already gone
      // (e.g. Bun aborts request.signal with a DOMException on disconnect);
      // erroring the detached response stream then only manufactures
      // unhandled rejections inside the HTTP server, so close it instead —
      // ackerdb clients treat a close without sse_done as truncation anyway.
      const canceledRequest = isAckerDBError(reason) &&
        reason.code === "unavailable" &&
        reason.resource === "operation";
      if (canceledRequest || !isAckerDBError(reason)) this.controller.close();
      else this.controller.error(reason);
    }
    this.releaseAll("unavailable");
    this.finishClosedState();
  }

  private finishClose(): void {
    if (this.state === "closed") return;
    try {
      this.controller.close();
    } finally {
      this.closedWaiter?.resolve();
      this.closedWaiter = null;
      this.finishClosedState();
    }
  }

  private forceClose(error: AckerDBError, outcome: DeliveryOutcome): void {
    if (this.state === "closed") return;
    this.failure ??= error;
    this.closureError = error;
    if (!this.abortController.signal.aborted) this.abortController.abort(error);
    try {
      this.controller.error(error);
    } catch {
      // Releasing the application-owned budget does not depend on stream state.
    }
    this.emptyWaiter?.reject(error);
    this.closedWaiter?.reject(error);
    this.emptyWaiter = null;
    this.closedWaiter = null;
    this.releaseAll(outcome);
    this.finishClosedState();
  }

  private finishClosedState(): void {
    this.state = "closed";
    this.clearStall();
    this.finishedWaiter.resolve();
    if (this.externalSignal !== undefined && this.externalAbort !== undefined) {
      this.externalSignal.removeEventListener("abort", this.externalAbort);
    }
  }

  private armStall(): void {
    if (this.state === "closed" || this.unackedBytes === 0) return;
    if (this.stallSince === null) this.stallSince = this.clock.now();
    if (this.stallTimer !== undefined) return;
    const elapsed = Math.max(0, this.clock.now() - this.stallSince);
    this.stallTimer = this.clock.setTimeout(
      () => this.onStallTimer(),
      Math.max(1, this.limits.sse.maxStallMs - elapsed),
    );
  }

  private restartStall(): void {
    if (this.stallTimer !== undefined) this.clock.clearTimeout(this.stallTimer);
    this.stallTimer = undefined;
    this.stallSince = this.clock.now();
    this.armStall();
  }

  private clearStall(): void {
    if (this.stallTimer !== undefined) this.clock.clearTimeout(this.stallTimer);
    this.stallTimer = undefined;
    this.stallSince = null;
  }

  private onStallTimer(): void {
    this.stallTimer = undefined;
    if (this.state === "closed" || this.stallSince === null || this.unackedBytes === 0) return;
    const elapsed = Math.max(0, this.clock.now() - this.stallSince);
    if (elapsed < this.limits.sse.maxStallMs) {
      this.armStall();
      return;
    }
    const error = this.failure ?? slowConsumer("sse", "SSE consumer stalled");
    if (this.state === "open") this.terminate(error);
    else this.forceClose(error, outcomeFromError(error).code);
  }
}
