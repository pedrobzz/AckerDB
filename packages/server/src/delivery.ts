import {
  PROTOCOL_VERSION,
  encode,
  type Outcome,
} from "@dbzz/core";
import { DbzzError, isDbzzError } from "./errors.ts";
import type { ServiceLimits } from "./limits.ts";
import { outcomeFromError, outcomeWebSocketClose } from "./outcome.ts";
import type {
  SessionApplicationMessage,
  SessionControlMessage,
  SessionSink,
} from "./session.ts";

export type OutboundLane = "application" | "control";

export interface OutboundBudgetSnapshot {
  readonly bytes: number;
  readonly applicationBytes: number;
  readonly controlBytes: number;
  readonly maxBytes: number;
  readonly reservedControlBytes: number;
}

export interface OutboundReservation {
  readonly lane: OutboundLane;
  readonly remainingBytes: number;
  release(bytes?: number): void;
}

function byteCount(value: number, name: string, allowZero = false): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new RangeError(`${name} must be ${allowZero ? "a non-negative" : "a positive"} safe integer`);
  }
}

class BudgetReservation implements OutboundReservation {
  private remaining: number;

  constructor(
    private readonly owner: OutboundBudget,
    readonly lane: OutboundLane,
    bytes: number,
  ) {
    this.remaining = bytes;
  }

  get remainingBytes(): number {
    return this.remaining;
  }

  release(bytes = this.remaining): void {
    byteCount(bytes, "released bytes", true);
    if (bytes > this.remaining) throw new RangeError("cannot release more bytes than the reservation owns");
    if (bytes === 0) return;
    this.remaining -= bytes;
    this.owner.release(this.lane, bytes);
  }
}

/** Shared exact-byte budget. Application traffic cannot consume the control reserve. */
export class OutboundBudget {
  readonly maxBytes: number;
  readonly reservedControlBytes: number;

  private applicationBytes = 0;
  private controlBytes = 0;

  constructor(maxBytes: number, reservedControlBytes = 0) {
    byteCount(maxBytes, "maxBytes");
    byteCount(reservedControlBytes, "reservedControlBytes", true);
    if (reservedControlBytes >= maxBytes) {
      throw new RangeError("reservedControlBytes must be smaller than maxBytes");
    }
    this.maxBytes = maxBytes;
    this.reservedControlBytes = reservedControlBytes;
  }

  reserve(bytes: number, lane: OutboundLane): OutboundReservation | null {
    byteCount(bytes, "reserved bytes");
    const total = this.applicationBytes + this.controlBytes;
    if (total + bytes > this.maxBytes) return null;
    if (
      lane === "application" &&
      this.applicationBytes + bytes > this.maxBytes - this.reservedControlBytes
    ) {
      return null;
    }
    if (lane === "application") this.applicationBytes += bytes;
    else this.controlBytes += bytes;
    return new BudgetReservation(this, lane, bytes);
  }

  snapshot(): OutboundBudgetSnapshot {
    return Object.freeze({
      bytes: this.applicationBytes + this.controlBytes,
      applicationBytes: this.applicationBytes,
      controlBytes: this.controlBytes,
      maxBytes: this.maxBytes,
      reservedControlBytes: this.reservedControlBytes,
    });
  }

  release(lane: OutboundLane, bytes: number): void {
    if (lane === "application") {
      if (bytes > this.applicationBytes) throw new Error("application budget underflow");
      this.applicationBytes -= bytes;
    } else {
      if (bytes > this.controlBytes) throw new Error("control budget underflow");
      this.controlBytes -= bytes;
    }
  }
}

export interface DeliveryClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const SYSTEM_CLOCK: DeliveryClock = Object.freeze({
  now: Date.now,
  setTimeout: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
  clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
});

export interface WebSocketDeliverySocket {
  send(data: string): number;
  getBufferedAmount(): number;
  close(code: number, reason: string): void;
}

export interface WebSocketSessionSinkOptions {
  readonly socket: WebSocketDeliverySocket;
  readonly budget: OutboundBudget;
  readonly limits: ServiceLimits;
  readonly clock?: DeliveryClock;
}

export interface WebSocketDeliverySnapshot {
  readonly queuedBytes: number;
  readonly bufferedBytes: number;
  readonly applicationBytes: number;
  readonly controlBytes: number;
  readonly blocked: boolean;
  readonly closed: boolean;
}

interface PendingFrame {
  readonly lane: OutboundLane;
  readonly authEpoch: number | null;
  readonly text: string;
  readonly bytes: number;
  readonly reservation: OutboundReservation;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

interface BufferedFrame {
  readonly lane: OutboundLane;
  readonly reservation: OutboundReservation;
}

const utf8 = new TextEncoder();

function slowConsumer(resource: "outbound" | "sse", message: string): DbzzError {
  return new DbzzError("slow_consumer", message, { retryable: true, resource });
}

function overloaded(resource: "outbound" | "sse", message: string): DbzzError {
  return new DbzzError("overloaded", message, { retryable: true, resource });
}

function unavailable(resource: "outbound" | "sse", message: string): DbzzError {
  return new DbzzError("unavailable", message, { retryable: true, resource });
}

function webSocketErrorText(error: DbzzError, maxBytes: number): string | null {
  const outcome = outcomeFromError(error);
  const encodeMessage = (message: string) =>
    encode({
      v: PROTOCOL_VERSION,
      t: "err",
      id: null,
      outcome: { ...outcome, message },
    } satisfies SessionControlMessage);
  let text = encodeMessage(outcome.message);
  if (utf8.encode(text).byteLength <= maxBytes) return text;
  const characters = [...outcome.message];
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (utf8.encode(encodeMessage(characters.slice(0, middle).join(""))).byteLength <= maxBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  text = encodeMessage(characters.slice(0, low).join(""));
  return utf8.encode(text).byteLength <= maxBytes ? text : null;
}

/** A FIFO Protocol-2 sink with one finite queue and Bun-aware drain ownership. */
export class WebSocketSessionSink implements SessionSink {
  readonly controlReserveBytes: number;

  private readonly socket: WebSocketDeliverySocket;
  private readonly budget: OutboundBudget;
  private readonly limits: ServiceLimits;
  private readonly clock: DeliveryClock;
  private readonly queue: PendingFrame[] = [];
  private readonly buffered: BufferedFrame[] = [];
  private applicationBytes = 0;
  private controlBytes = 0;
  private bufferedBytes = 0;
  private blocked = false;
  private closed = false;
  private pumping = false;
  private terminalError: DbzzError | null = null;
  private stallSince: number | null = null;
  private stallTimer: unknown;

  constructor(options: WebSocketSessionSinkOptions) {
    const { maxBytesPerConnection } = options.limits.webSocket;
    if (options.limits.maxFrameBytes >= maxBytesPerConnection) {
      throw new RangeError("maxFrameBytes must be smaller than webSocket.maxBytesPerConnection");
    }
    this.socket = options.socket;
    this.budget = options.budget;
    this.limits = options.limits;
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.controlReserveBytes = options.limits.maxFrameBytes;
  }

  sendControl(message: SessionControlMessage): Promise<void> {
    return this.enqueue("control", null, message);
  }

  sendApplication(authEpoch: number, message: SessionApplicationMessage): Promise<void> {
    return this.enqueue("application", authEpoch, message);
  }

  async dropApplicationFramesBefore(authEpoch: number): Promise<void> {
    if (!Number.isSafeInteger(authEpoch) || authEpoch < 0) {
      throw new RangeError("authEpoch must be a non-negative safe integer");
    }
    const retained: PendingFrame[] = [];
    for (const frame of this.queue) {
      if (frame.lane !== "application" || frame.authEpoch === null || frame.authEpoch >= authEpoch) {
        retained.push(frame);
        continue;
      }
      this.release(frame.reservation);
      frame.resolve();
    }
    this.queue.splice(0, this.queue.length, ...retained);
    this.pump();
  }

  async close(outcome: Outcome): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.clearStall();
    const error = unavailable("outbound", outcome.message);
    this.releasePending(error);
    this.releaseBuffered(this.bufferedBytes);
    this.socket.close(outcomeWebSocketClose(outcome), outcome.code);
  }

  /** Wire this to Bun's websocket `drain` callback. */
  onDrain(): void {
    if (this.closed) return;
    this.blocked = false;
    try {
      this.reconcileBuffered(true);
    } catch (error) {
      this.fail(unavailable("outbound", "WebSocket buffer accounting failed"), error);
      return;
    }
    this.pump();
  }

  snapshot(): WebSocketDeliverySnapshot {
    return Object.freeze({
      queuedBytes: this.applicationBytes + this.controlBytes - this.bufferedBytes,
      bufferedBytes: this.bufferedBytes,
      applicationBytes: this.applicationBytes,
      controlBytes: this.controlBytes,
      blocked: this.blocked,
      closed: this.closed,
    });
  }

  private enqueue(
    lane: OutboundLane,
    authEpoch: number | null,
    message: SessionControlMessage | SessionApplicationMessage,
  ): Promise<void> {
    if (this.closed) {
      return Promise.reject(this.terminalError ?? unavailable("outbound", "WebSocket is closed"));
    }
    let text: string;
    try {
      text = encode(message);
    } catch (error) {
      return Promise.reject(error);
    }
    const bytes = utf8.encode(text).byteLength;
    if (bytes > this.limits.maxFrameBytes) {
      const error = overloaded("outbound", "WebSocket frame exceeds maxFrameBytes");
      this.fail(error);
      return Promise.reject(error);
    }

    const total = this.applicationBytes + this.controlBytes;
    const localLimit =
      lane === "application"
        ? this.limits.webSocket.maxBytesPerConnection - this.controlReserveBytes
        : this.limits.webSocket.maxBytesPerConnection;
    const localUsed = lane === "application" ? this.applicationBytes : total;
    if (
      localUsed + bytes > localLimit ||
      total + bytes > this.limits.webSocket.maxBytesPerConnection
    ) {
      const error = slowConsumer("outbound", "WebSocket outbound byte limit exceeded");
      this.fail(error);
      return Promise.reject(error);
    }
    const reservation = this.budget.reserve(bytes, lane);
    if (reservation === null) {
      const error = overloaded("outbound", "global WebSocket outbound byte limit exceeded");
      this.fail(error);
      return Promise.reject(error);
    }
    if (lane === "application") this.applicationBytes += bytes;
    else this.controlBytes += bytes;

    return new Promise<void>((resolve, reject) => {
      this.queue.push({ lane, authEpoch, text, bytes, reservation, resolve, reject });
      this.pump();
    });
  }

  private pump(): void {
    if (this.pumping || this.closed || this.blocked) return;
    this.pumping = true;
    try {
      while (!this.closed && !this.blocked && this.queue.length > 0) {
        const observed = this.reconcileBuffered(true);
        const frame = this.queue[0]!;
        if (observed + frame.bytes > this.limits.webSocket.maxBytesPerConnection) {
          this.blocked = true;
          this.armStall();
          break;
        }

        const sent = this.socket.send(frame.text);
        if (sent === 0) {
          this.fail(unavailable("outbound", "WebSocket send failed"));
          break;
        }
        if (!Number.isSafeInteger(sent) || sent < -1) {
          this.fail(unavailable("outbound", "WebSocket send returned an invalid result"));
          break;
        }

        this.queue.shift();
        this.buffered.push({ lane: frame.lane, reservation: frame.reservation });
        this.bufferedBytes += frame.bytes;
        frame.resolve();
        if (sent === -1) {
          this.blocked = true;
          this.armStall();
        } else {
          this.reconcileBuffered(true);
          if (this.bufferedBytes > 0) this.armStall();
        }
      }
    } catch (error) {
      this.fail(unavailable("outbound", "WebSocket delivery failed"), error);
    } finally {
      this.pumping = false;
    }
  }

  private readBufferedAmount(): number {
    const value = this.socket.getBufferedAmount();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError("getBufferedAmount() must return a non-negative safe integer");
    }
    return value;
  }

  private reconcileBuffered(markProgress: boolean): number {
    const observed = this.readBufferedAmount();
    const target = Math.min(observed, this.bufferedBytes);
    const released = this.bufferedBytes - target;
    if (released > 0) {
      this.releaseBuffered(released);
      if (markProgress && (this.bufferedBytes > 0 || this.blocked)) this.restartStall();
    }
    if (this.bufferedBytes === 0 && !this.blocked) this.clearStall();
    return observed;
  }

  private releaseBuffered(bytes: number): void {
    let remaining = bytes;
    while (remaining > 0) {
      const frame = this.buffered[0];
      if (frame === undefined) throw new Error("buffered byte accounting underflow");
      const released = Math.min(remaining, frame.reservation.remainingBytes);
      this.release(frame.reservation, released);
      this.bufferedBytes -= released;
      remaining -= released;
      if (frame.reservation.remainingBytes === 0) this.buffered.shift();
    }
  }

  private release(reservation: OutboundReservation, bytes = reservation.remainingBytes): void {
    reservation.release(bytes);
    if (reservation.lane === "application") this.applicationBytes -= bytes;
    else this.controlBytes -= bytes;
  }

  private releasePending(error: DbzzError): void {
    for (const frame of this.queue.splice(0)) {
      this.release(frame.reservation);
      frame.reject(error);
    }
  }

  private armStall(): void {
    if (this.stallSince === null) this.stallSince = this.clock.now();
    if (this.stallTimer !== undefined) return;
    const elapsed = Math.max(0, this.clock.now() - this.stallSince);
    this.stallTimer = this.clock.setTimeout(
      () => this.onStallTimer(),
      Math.max(1, this.limits.webSocket.maxStallMs - elapsed),
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
    if (this.closed || this.stallSince === null) return;
    const before = this.bufferedBytes;
    try {
      this.reconcileBuffered(false);
    } catch (error) {
      this.fail(unavailable("outbound", "WebSocket buffer accounting failed"), error);
      return;
    }
    if (this.bufferedBytes < before) {
      this.stallSince = this.clock.now();
      this.armStall();
      return;
    }
    if (this.bufferedBytes === 0 && !this.blocked) {
      this.clearStall();
      return;
    }
    const elapsed = Math.max(0, this.clock.now() - this.stallSince);
    if (elapsed < this.limits.webSocket.maxStallMs) {
      this.armStall();
      return;
    }
    this.fail(slowConsumer("outbound", "WebSocket consumer stalled"));
  }

  private fail(error: DbzzError, cause?: unknown): void {
    if (this.closed) return;
    const terminal =
      cause === undefined
        ? error
        : new DbzzError(error.code, error.message, {
            retryable: error.retryable,
            resource: error.resource,
            cause,
          });
    this.closed = true;
    this.terminalError = terminal;
    this.clearStall();
    this.releasePending(terminal);
    this.releaseBuffered(this.bufferedBytes);

    const text = webSocketErrorText(terminal, this.limits.maxFrameBytes);
    const bytes = text === null ? 0 : utf8.encode(text).byteLength;
    const reservation = text === null ? null : this.budget.reserve(bytes, "control");
    try {
      if (reservation !== null && text !== null) this.socket.send(text);
    } catch {
      // The authoritative close below does not depend on the best-effort frame.
    } finally {
      reservation?.release();
      const outcome = outcomeFromError(terminal);
      try {
        this.socket.close(outcomeWebSocketClose(outcome), outcome.code);
      } catch {
        // The sink is already terminal and all owned capacity has been released.
      }
    }
  }
}

export interface BoundedSseProducerOptions {
  readonly budget: OutboundBudget;
  readonly limits: ServiceLimits;
  readonly signal?: AbortSignal;
  readonly clock?: DeliveryClock;
}

export interface SseDeliverySnapshot {
  readonly queuedBytes: number;
  readonly state: "open" | "ending" | "closed";
  readonly mergeActive: boolean;
}

interface StreamReservation {
  readonly reservation: OutboundReservation;
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

function sseBytes(data: unknown): Uint8Array {
  return utf8.encode(`data: ${encode(data)}\n\n`);
}

function sseDoneBytes(): Uint8Array {
  return utf8.encode("data: [DONE]\n\n");
}

function sseErrorBytes(error: DbzzError, maxBytes: number): Uint8Array {
  const outcome = outcomeFromError(error);
  const encodeOutcome = (message: string) =>
    utf8.encode(`event: dbzz-error\ndata: ${encode({ ...outcome, message })}\n\n`);
  let result = encodeOutcome(outcome.message);
  if (result.byteLength <= maxBytes) return result;
  const characters = [...outcome.message];
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (encodeOutcome(characters.slice(0, middle).join("")).byteLength <= maxBytes) low = middle;
    else high = middle - 1;
  }
  result = encodeOutcome(characters.slice(0, low).join(""));
  if (result.byteLength > maxBytes) {
    throw new RangeError("SSE control reserve cannot encode a terminal outcome");
  }
  return result;
}

const MINIMUM_SSE_CONTROL_BYTES = Math.max(
  sseErrorBytes(slowConsumer("sse", "SSE consumer stalled"), Number.MAX_SAFE_INTEGER).byteLength,
  sseErrorBytes(overloaded("sse", "SSE delivery overloaded"), Number.MAX_SAFE_INTEGER).byteLength,
  sseDoneBytes().byteLength,
);

interface SseSourceReader {
  read(): Promise<{ readonly done: boolean; readonly value?: unknown }>;
  cancel(reason?: unknown): Promise<void>;
  releaseLock(): void;
}

/**
 * A byte-strategy SSE source. Direct writes are finite; one merge may pull at a
 * time and waits for stream credit instead of creating detached reader tails.
 */
export class BoundedSseProducer {
  readonly stream: ReadableStream<Uint8Array>;
  readonly signal: AbortSignal;
  readonly controlReserveBytes: number;

  private readonly budget: OutboundBudget;
  private readonly limits: ServiceLimits;
  private readonly clock: DeliveryClock;
  private readonly controller: ReadableStreamDefaultController<Uint8Array>;
  private readonly abortController = new AbortController();
  private readonly reservations: StreamReservation[] = [];
  private readonly externalSignal: AbortSignal | undefined;
  private readonly externalAbort: (() => void) | undefined;
  private queuedBytes = 0;
  private state: "open" | "ending" | "closed" = "open";
  private failure: DbzzError | null = null;
  private activeMerge: Promise<void> | null = null;
  private activeReader: SseSourceReader | null = null;
  private capacityWaiter: Waiter | null = null;
  private emptyWaiter: Waiter | null = null;
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
    this.externalSignal = options.signal;
    this.signal = this.abortController.signal;

    let controller!: ReadableStreamDefaultController<Uint8Array>;
    this.stream = new ReadableStream<Uint8Array>(
      {
        start: (value) => {
          controller = value;
        },
        pull: () => {
          this.reconcileQueue(true);
        },
        cancel: (reason) => {
          this.cancel(reason, false);
        },
      },
      new ByteLengthQueuingStrategy({ highWaterMark: maxBytes }),
    );
    this.controller = controller;

    if (options.signal !== undefined) {
      this.externalAbort = () => this.cancel(options.signal!.reason, true);
      if (options.signal.aborted) this.externalAbort();
      else options.signal.addEventListener("abort", this.externalAbort, { once: true });
    } else {
      this.externalAbort = undefined;
    }
  }

  write(chunk: unknown): void {
    const bytes = sseBytes(chunk);
    try {
      this.enqueueApplication(bytes);
    } catch (error) {
      const terminal = isDbzzError(error)
        ? error
        : new DbzzError("internal", "SSE producer failed", { cause: error });
      this.terminate(terminal);
      throw terminal;
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
      isDbzzError(error) ? error : new DbzzError("internal", "SSE producer failed", { cause: error }),
    );
  }

  snapshot(): SseDeliverySnapshot {
    this.reconcileQueue(false);
    return Object.freeze({
      queuedBytes: this.queuedBytes,
      state: this.state,
      mergeActive: this.activeMerge !== null,
    });
  }

  private async consume(source: ReadableStream<unknown>): Promise<void> {
    const reader = source.getReader();
    this.activeReader = reader;
    try {
      for (;;) {
        if (this.state !== "open") throw this.failure ?? unavailable("sse", "SSE stream is closed");
        const part = await reader.read();
        if (part.done) return;
        const bytes = sseBytes(part.value);
        await this.enqueueMerged(bytes);
      }
    } catch (error) {
      const terminal = isDbzzError(error)
        ? error
        : new DbzzError("internal", "SSE merge failed", { cause: error });
      this.terminate(terminal);
      throw terminal;
    } finally {
      if (this.activeReader === reader) this.activeReader = null;
      reader.releaseLock();
      this.activeMerge = null;
    }
  }

  private async enqueueMerged(bytes: Uint8Array): Promise<void> {
    this.validateApplicationFrame(bytes.byteLength);
    for (;;) {
      if (this.state !== "open") throw this.failure ?? unavailable("sse", "SSE stream is closed");
      this.reconcileQueue(true);
      if (this.queuedBytes + bytes.byteLength <= this.applicationLimit()) break;
      await this.waitForCapacity();
    }
    const reservation = this.budget.reserve(bytes.byteLength, "application");
    if (reservation === null) {
      throw overloaded("sse", "global SSE outbound byte limit exceeded");
    }
    this.enqueue(bytes, reservation);
  }

  private enqueueApplication(bytes: Uint8Array): void {
    if (this.state !== "open") throw this.failure ?? unavailable("sse", "SSE stream is closed");
    this.validateApplicationFrame(bytes.byteLength);
    this.reconcileQueue(true);
    if (this.queuedBytes + bytes.byteLength > this.applicationLimit()) {
      throw slowConsumer("sse", "SSE producer exceeded the consumer byte budget");
    }
    const reservation = this.budget.reserve(bytes.byteLength, "application");
    if (reservation === null) {
      throw overloaded("sse", "global SSE outbound byte limit exceeded");
    }
    this.enqueue(bytes, reservation);
  }

  private validateApplicationFrame(bytes: number): void {
    if (bytes > this.limits.maxFrameBytes || bytes > this.applicationLimit()) {
      throw overloaded("sse", "SSE event exceeds maxFrameBytes");
    }
  }

  private enqueue(bytes: Uint8Array, reservation: OutboundReservation): void {
    this.reservations.push({ reservation });
    this.queuedBytes += bytes.byteLength;
    try {
      this.controller.enqueue(bytes);
    } catch (error) {
      this.reservations.pop();
      this.queuedBytes -= bytes.byteLength;
      reservation.release();
      throw error;
    }
    this.reconcileQueue(true);
    if (this.queuedBytes > 0) this.armStall();
  }

  private applicationLimit(): number {
    return this.limits.sse.maxBytesPerStream - this.controlReserveBytes;
  }

  private reconcileQueue(markProgress: boolean): void {
    if (this.state === "closed") return;
    const desired = this.controller.desiredSize;
    if (desired === null) return;
    const observed = Math.max(
      0,
      Math.min(this.limits.sse.maxBytesPerStream, Math.ceil(this.limits.sse.maxBytesPerStream - desired)),
    );
    const released = this.queuedBytes - Math.min(this.queuedBytes, observed);
    if (released > 0) {
      this.releaseQueue(released);
      if (markProgress && this.queuedBytes > 0) this.restartStall();
      this.capacityWaiter?.resolve();
      this.capacityWaiter = null;
    }
    if (this.queuedBytes === 0) {
      this.clearStall();
      this.emptyWaiter?.resolve();
      this.emptyWaiter = null;
      if (this.state === "ending") this.finishClose();
    }
  }

  private releaseQueue(bytes: number): void {
    let remaining = bytes;
    while (remaining > 0) {
      const item = this.reservations[0];
      if (item === undefined) throw new Error("SSE byte accounting underflow");
      const released = Math.min(remaining, item.reservation.remainingBytes);
      item.reservation.release(released);
      this.queuedBytes -= released;
      remaining -= released;
      if (item.reservation.remainingBytes === 0) this.reservations.shift();
    }
  }

  private releaseAll(): void {
    for (const item of this.reservations.splice(0)) item.reservation.release();
    this.queuedBytes = 0;
  }

  private waitForCapacity(): Promise<void> {
    if (this.capacityWaiter === null) this.capacityWaiter = waiter();
    return this.capacityWaiter.promise;
  }

  private waitForEmpty(): Promise<void> {
    this.reconcileQueue(true);
    if (this.queuedBytes === 0) return Promise.resolve();
    if (this.emptyWaiter === null) this.emptyWaiter = waiter();
    return this.emptyWaiter.promise;
  }

  private async completeOpenStream(): Promise<void> {
    const merge = this.activeMerge;
    if (merge !== null) await merge;
    if (this.state !== "open") throw this.failure ?? unavailable("sse", "SSE stream is closed");
    await this.waitForEmpty();
    if (this.state !== "open") throw this.failure ?? unavailable("sse", "SSE stream is closed");
    const bytes = sseDoneBytes();
    const reservation = this.budget.reserve(bytes.byteLength, "control");
    if (reservation === null) {
      const error = overloaded("sse", "global SSE control byte limit exceeded");
      this.terminate(error);
      throw error;
    }
    this.state = "ending";
    this.enqueue(bytes, reservation);
    if (this.queuedBytes === 0) this.finishClose();
  }

  private terminate(error: DbzzError): void {
    if (this.state !== "open") return;
    this.failure = error;
    this.state = "ending";
    if (!this.abortController.signal.aborted) this.abortController.abort(error);
    const reader = this.activeReader;
    if (reader !== null) void reader.cancel(error).then(undefined, () => {});
    this.capacityWaiter?.reject(error);
    this.capacityWaiter = null;
    this.emptyWaiter?.reject(error);
    this.emptyWaiter = null;
    this.clearStall();

    const bytes = sseErrorBytes(error, this.controlReserveBytes);
    const reservation =
      this.queuedBytes + bytes.byteLength <= this.limits.sse.maxBytesPerStream
        ? this.budget.reserve(bytes.byteLength, "control")
        : null;
    if (reservation === null) {
      this.controller.error(error);
      this.releaseAll();
      this.finishClosedState();
      return;
    }
    try {
      this.enqueue(bytes, reservation);
    } catch {
      this.controller.error(error);
      this.releaseAll();
      this.finishClosedState();
      return;
    }
    if (this.queuedBytes === 0) this.finishClose();
  }

  private cancel(reason: unknown, terminateStream: boolean): void {
    if (this.state === "closed") return;
    const error = unavailable("sse", "SSE consumer canceled the stream");
    this.failure = error;
    if (!this.abortController.signal.aborted) this.abortController.abort(reason ?? error);
    const reader = this.activeReader;
    if (reader !== null) void reader.cancel(reason).then(undefined, () => {});
    this.capacityWaiter?.reject(error);
    this.emptyWaiter?.reject(error);
    this.capacityWaiter = null;
    this.emptyWaiter = null;
    this.clearStall();
    if (terminateStream) this.controller.error(reason ?? error);
    this.releaseAll();
    this.finishClosedState();
  }

  private finishClose(): void {
    if (this.state === "closed") return;
    try {
      this.controller.close();
    } finally {
      this.finishClosedState();
    }
  }

  private finishClosedState(): void {
    this.state = "closed";
    this.clearStall();
    if (this.externalSignal !== undefined && this.externalAbort !== undefined) {
      this.externalSignal.removeEventListener("abort", this.externalAbort);
    }
  }

  private armStall(): void {
    if (this.state !== "open" || this.queuedBytes === 0) return;
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
    if (this.state !== "open" || this.stallSince === null) return;
    const before = this.queuedBytes;
    this.reconcileQueue(false);
    if (this.queuedBytes < before) {
      this.stallSince = this.clock.now();
      this.armStall();
      return;
    }
    if (this.queuedBytes === 0) return;
    const elapsed = Math.max(0, this.clock.now() - this.stallSince);
    if (elapsed < this.limits.sse.maxStallMs) {
      this.armStall();
      return;
    }
    this.terminate(slowConsumer("sse", "SSE consumer stalled"));
  }
}
