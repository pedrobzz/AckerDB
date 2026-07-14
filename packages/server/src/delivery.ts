import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  PROTOCOL_VERSION,
  RESOURCE_CLASSES,
  encode,
  type Outcome,
  type SseDoneMessage,
  type SseErrorMessage,
} from "@dbzz/core";
import { DbzzError, isDbzzError } from "./errors.ts";
import type { ServiceLimits } from "./limits.ts";
import {
  PUBLIC_ERROR_FALLBACK,
  fitOutcome,
  outcomeFromError,
  outcomeWebSocketClose,
} from "./outcome.ts";
import {
  assertRuntimePublication,
  type RuntimePublication,
  type SessionControlMessage,
  type SessionSink,
} from "./session.ts";

export type OutboundLane = "application" | "control";
export type DeliveryTransport = "websocket" | "sse";
export type DeliveryStage = "encoding" | "queue" | "delivery";
export type DeliverySource = "send" | "write" | "merge" | "terminal";
export type DeliveryOutcome = "ok" | "dropped" | Outcome["code"];

export interface DeliveryObservation {
  readonly transport: DeliveryTransport;
  readonly stage: DeliveryStage;
  readonly lane: OutboundLane;
  readonly source: DeliverySource;
  readonly bytes: number;
  readonly durationMs: number;
  readonly outcome: DeliveryOutcome;
  readonly terminalOutcome?: Outcome["code"];
  /** Records omitted from this bounded observer batch before it was drained. */
  readonly droppedObservations?: number;
}

/** Metadata-only hook. Delivery never awaits it and ignores callback failures. */
export type DeliveryObserver = (observation: DeliveryObservation) => unknown;

/** Package-private terminal ownership released even when diagnostics are dropped. */
export const FINALIZE_DELIVERY_OBSERVER = Symbol("dbzz.finalizeDeliveryObserver");

/** Captures the observer that owns one frame before any delivery work begins. */
export type DeliveryObserverCapture = (lane: OutboundLane) => DeliveryObserver | undefined;

export interface OutboundBudgetSnapshot {
  readonly bytes: number;
  readonly applicationBytes: number;
  readonly controlBytes: number;
  /** Lifetime maximum simultaneous total ownership since construction. */
  readonly peakBytes: number;
  /** Independent lifetime maximum for the application lane. */
  readonly peakApplicationBytes: number;
  /** Independent lifetime maximum for the control lane. */
  readonly peakControlBytes: number;
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
  private peakBytes = 0;
  private peakApplicationBytes = 0;
  private peakControlBytes = 0;

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
    if (bytes > this.availableBytes(lane)) return null;
    if (lane === "application") {
      this.applicationBytes += bytes;
      this.peakApplicationBytes = Math.max(this.peakApplicationBytes, this.applicationBytes);
    } else {
      this.controlBytes += bytes;
      this.peakControlBytes = Math.max(this.peakControlBytes, this.controlBytes);
    }
    this.peakBytes = Math.max(this.peakBytes, this.applicationBytes + this.controlBytes);
    return new BudgetReservation(this, lane, bytes);
  }

  availableBytes(lane: OutboundLane): number {
    const total = this.applicationBytes + this.controlBytes;
    const available = this.maxBytes - total;
    return lane === "control"
      ? available
      : Math.min(available, this.maxBytes - this.reservedControlBytes - this.applicationBytes);
  }

  snapshot(): OutboundBudgetSnapshot {
    return Object.freeze({
      bytes: this.applicationBytes + this.controlBytes,
      applicationBytes: this.applicationBytes,
      controlBytes: this.controlBytes,
      peakBytes: this.peakBytes,
      peakApplicationBytes: this.peakApplicationBytes,
      peakControlBytes: this.peakControlBytes,
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

interface DeliveryTiming {
  readonly observer: DeliveryObserver;
  readonly source: DeliverySource;
  readonly bytes: number;
  readonly queueStartedAt: number;
  readonly terminalOutcome?: Outcome["code"];
  deliveryStartedAt?: number;
}

interface PendingDeliveryObservation {
  readonly observer: DeliveryObserver;
  readonly record: DeliveryObservation;
  readonly terminal: boolean;
}

interface DeliveryInstrumentation {
  readonly captureObserver: DeliveryObserverCapture;
  readonly clock: DeliveryClock;
  readonly transport: DeliveryTransport;
  readonly pending: PendingDeliveryObservation[];
  scheduled: boolean;
  dropped: number;
}

const MAX_PENDING_DELIVERY_OBSERVATIONS = 256;

const SYSTEM_CLOCK: DeliveryClock = Object.freeze({
  now: Date.now,
  setTimeout: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
  clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
});

function safeDeliveryOutcome(error: unknown): Outcome["code"] {
  try {
    return outcomeFromError(error).code;
  } catch {
    return "internal";
  }
}

function promiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function terminalObservation(
  observation: Pick<DeliveryObservation, "stage" | "source" | "outcome">,
): boolean {
  return observation.stage === "delivery" ||
    (observation.stage === "queue" && observation.outcome !== "ok") ||
    (observation.stage === "encoding" &&
      observation.source === "send" &&
      observation.outcome !== "ok");
}

function finalizeDeliveryObserver(observer: DeliveryObserver): void {
  try {
    (observer as DeliveryObserver & {
      readonly [FINALIZE_DELIVERY_OBSERVER]?: () => void;
    })[FINALIZE_DELIVERY_OBSERVER]?.();
  } catch {
    // Instrumentation ownership is fail-open.
  }
}

function observeDelivery(
  instrumentation: DeliveryInstrumentation | undefined,
  observer: DeliveryObserver | undefined,
  observation: Omit<DeliveryObservation, "durationMs"> & {
    readonly startedAt: number;
    readonly endedAt?: number;
  },
): void {
  if (instrumentation === undefined || observer === undefined) return;
  const terminal = terminalObservation(observation);
  if (instrumentation.pending.length >= MAX_PENDING_DELIVERY_OBSERVATIONS) {
    instrumentation.dropped = Math.min(Number.MAX_SAFE_INTEGER, instrumentation.dropped + 1);
    if (terminal) finalizeDeliveryObserver(observer);
    return;
  }
  let record: DeliveryObservation;
  try {
    const { startedAt, endedAt, ...fields } = observation;
    const elapsed = (endedAt ?? instrumentation.clock.now()) - startedAt;
    if (!Number.isFinite(elapsed)) {
      if (terminal) finalizeDeliveryObserver(observer);
      return;
    }
    record = Object.freeze({
      ...fields,
      durationMs: Math.max(0, elapsed),
    });
  } catch {
    if (terminal) finalizeDeliveryObserver(observer);
    return;
  }
  instrumentation.pending.push({ observer, record, terminal });
  scheduleDeliveryObservations(instrumentation);
}

function scheduleDeliveryObservations(instrumentation: DeliveryInstrumentation): void {
  if (instrumentation.scheduled) return;
  instrumentation.scheduled = true;
  try {
    queueMicrotask(() => drainDeliveryObservations(instrumentation));
  } catch {
    instrumentation.scheduled = false;
    for (const pending of instrumentation.pending.splice(0)) {
      if (pending.terminal) finalizeDeliveryObserver(pending.observer);
    }
    instrumentation.dropped = 0;
  }
}

function drainDeliveryObservations(instrumentation: DeliveryInstrumentation): void {
  instrumentation.scheduled = false;
  const batch = instrumentation.pending.splice(0);
  const dropped = instrumentation.dropped;
  instrumentation.dropped = 0;
  for (let index = 0; index < batch.length; index++) {
    const pending = batch[index]!;
    const record = index === 0 && dropped > 0
      ? Object.freeze({ ...pending.record, droppedObservations: dropped })
      : pending.record;
    try {
      const result = pending.observer(record);
      if (promiseLike(result)) void Promise.resolve(result).catch(() => {});
    } catch {
      // Delivery instrumentation is diagnostic and always fail-open.
    } finally {
      if (pending.terminal) finalizeDeliveryObserver(pending.observer);
    }
  }
  if (instrumentation.pending.length > 0) {
    scheduleDeliveryObservations(instrumentation);
  }
}

function captureDeliveryObserver(
  instrumentation: DeliveryInstrumentation | undefined,
  lane: OutboundLane,
): DeliveryObserver | undefined {
  if (instrumentation === undefined) return undefined;
  try {
    return instrumentation.captureObserver(lane);
  } catch {
    return undefined;
  }
}

function observationNow(
  instrumentation: DeliveryInstrumentation | undefined,
): number | undefined {
  if (instrumentation === undefined) return undefined;
  try {
    const now = instrumentation.clock.now();
    return Number.isFinite(now) ? now : undefined;
  } catch {
    return undefined;
  }
}

function deliveryTiming(
  instrumentation: DeliveryInstrumentation | undefined,
  observer: DeliveryObserver | undefined,
  source: DeliverySource,
  bytes: number,
  terminalOutcome?: Outcome["code"],
): DeliveryTiming | undefined {
  if (observer === undefined) return undefined;
  const queueStartedAt = observationNow(instrumentation);
  if (queueStartedAt === undefined) {
    finalizeDeliveryObserver(observer);
    return undefined;
  }
  return {
    observer,
    source,
    bytes,
    queueStartedAt,
    ...(terminalOutcome === undefined ? {} : { terminalOutcome }),
  };
}

function observeTiming(
  instrumentation: DeliveryInstrumentation | undefined,
  lane: OutboundLane,
  timing: DeliveryTiming | undefined,
  stage: "queue" | "delivery",
  outcome: DeliveryOutcome,
): void {
  if (instrumentation === undefined || timing === undefined) return;
  const startedAt = stage === "queue" ? timing.queueStartedAt : timing.deliveryStartedAt;
  if (startedAt === undefined) {
    if (stage === "delivery" || outcome !== "ok") finalizeDeliveryObserver(timing.observer);
    return;
  }
  observeDelivery(instrumentation, timing.observer, {
    transport: instrumentation.transport,
    stage,
    lane,
    source: timing.source,
    bytes: timing.bytes,
    outcome,
    ...(timing.terminalOutcome === undefined ? {} : { terminalOutcome: timing.terminalOutcome }),
    startedAt,
  });
}

function observeEncoding(
  instrumentation: DeliveryInstrumentation | undefined,
  observer: DeliveryObserver | undefined,
  lane: OutboundLane,
  source: DeliverySource,
  startedAt: number | undefined,
  bytes: number,
  outcome: DeliveryOutcome,
  terminalOutcome?: Outcome["code"],
  endedAt?: number,
): void {
  if (instrumentation === undefined || startedAt === undefined) {
    if (source === "send" && outcome !== "ok" && observer !== undefined) {
      finalizeDeliveryObserver(observer);
    }
    return;
  }
  observeDelivery(instrumentation, observer, {
    transport: instrumentation.transport,
    stage: "encoding",
    lane,
    source,
    bytes,
    outcome,
    ...(terminalOutcome === undefined ? {} : { terminalOutcome }),
    startedAt,
    ...(endedAt === undefined ? {} : { endedAt }),
  });
}

function deliveryInstrumentation(
  observer: DeliveryObserver | undefined,
  clock: DeliveryClock,
  transport: DeliveryTransport,
  captureObserver?: DeliveryObserverCapture,
): DeliveryInstrumentation | undefined {
  const capture = captureObserver ?? (observer === undefined ? undefined : () => observer);
  return capture === undefined
    ? undefined
    : { captureObserver: capture, clock, transport, pending: [], scheduled: false, dropped: 0 };
}

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
  readonly observer?: DeliveryObserver;
  readonly captureObserver?: DeliveryObserverCapture;
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
  readonly timing?: DeliveryTiming;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

interface BufferedFrame {
  readonly lane: OutboundLane;
  readonly reservation: OutboundReservation;
  readonly timing?: DeliveryTiming;
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
  return fitOutcome(outcome, maxBytes, (candidate) => {
    const value = encode({
      v: PROTOCOL_VERSION,
      t: "err",
      id: null,
      outcome: candidate,
    } satisfies SessionControlMessage);
    return { value, bytes: utf8.encode(value).byteLength };
  })?.value ?? null;
}

/** A FIFO Protocol-2 sink with one finite queue and Bun-aware drain ownership. */
export class WebSocketSessionSink implements SessionSink {
  readonly controlReserveBytes: number;

  private readonly socket: WebSocketDeliverySocket;
  private readonly budget: OutboundBudget;
  private readonly limits: ServiceLimits;
  private readonly clock: DeliveryClock;
  private readonly delivery: DeliveryInstrumentation | undefined;
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
    this.delivery = deliveryInstrumentation(
      options.observer,
      this.clock,
      "websocket",
      options.captureObserver,
    );
    this.controlReserveBytes = options.limits.maxFrameBytes;
  }

  sendControl(message: SessionControlMessage): Promise<void> {
    return this.enqueue("control", null, message);
  }

  sendApplication(authEpoch: number, publication: RuntimePublication): Promise<void> {
    return this.enqueue("application", authEpoch, publication);
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
      if (frame.timing !== undefined) {
        observeTiming(this.delivery, frame.lane, frame.timing, "queue", "dropped");
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
    this.releasePending(error, outcome.code);
    this.releaseBuffered(this.bufferedBytes, outcome.code);
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
    frame: SessionControlMessage | RuntimePublication,
  ): Promise<void> {
    const observer = captureDeliveryObserver(this.delivery, lane);
    if (this.closed) {
      const error = this.terminalError ?? unavailable("outbound", "WebSocket is closed");
      if (this.delivery !== undefined) {
        const timing = deliveryTiming(this.delivery, observer, "send", 0);
        observeTiming(this.delivery, lane, timing, "queue", safeDeliveryOutcome(error));
      }
      return Promise.reject(error);
    }
    let text: string;
    let bytes: number;
    if (lane === "application") {
      const publication = frame as RuntimePublication;
      try {
        assertRuntimePublication(publication);
      } catch (error) {
        const timing = this.delivery === undefined
          ? undefined
          : deliveryTiming(this.delivery, observer, "send", 0);
        observeTiming(this.delivery, lane, timing, "queue", safeDeliveryOutcome(error));
        return Promise.reject(error);
      }
      text = publication.text;
      bytes = publication.bytes;
    } else {
      const encodingStartedAt = observer === undefined ? undefined : observationNow(this.delivery);
      try {
        text = encode(frame);
      } catch (error) {
        if (this.delivery !== undefined) {
          observeEncoding(
            this.delivery,
            observer,
            lane,
            "send",
            encodingStartedAt,
            0,
            safeDeliveryOutcome(error),
          );
        }
        return Promise.reject(error);
      }
      bytes = utf8.encode(text).byteLength;
      if (this.delivery !== undefined) {
        observeEncoding(this.delivery, observer, lane, "send", encodingStartedAt, bytes, "ok");
      }
    }
    const timing = this.delivery === undefined
      ? undefined
      : deliveryTiming(this.delivery, observer, "send", bytes);
    if (bytes > this.limits.maxFrameBytes) {
      const error = overloaded("outbound", "WebSocket frame exceeds maxFrameBytes");
      observeTiming(this.delivery, lane, timing, "queue", error.code);
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
      observeTiming(this.delivery, lane, timing, "queue", error.code);
      this.fail(error);
      return Promise.reject(error);
    }
    const reservation = this.budget.reserve(bytes, lane);
    if (reservation === null) {
      const error = overloaded("outbound", "global WebSocket outbound byte limit exceeded");
      observeTiming(this.delivery, lane, timing, "queue", error.code);
      this.fail(error);
      return Promise.reject(error);
    }
    if (lane === "application") this.applicationBytes += bytes;
    else this.controlBytes += bytes;

    return new Promise<void>((resolve, reject) => {
      if (timing === undefined) {
        this.queue.push({ lane, authEpoch, text, bytes, reservation, resolve, reject });
      } else {
        this.queue.push({ lane, authEpoch, text, bytes, reservation, timing, resolve, reject });
      }
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

        let sent: number;
        try {
          sent = this.socket.send(frame.text);
        } catch (cause) {
          this.fail(unavailable("outbound", "WebSocket delivery failed"), cause);
          break;
        }
        if (sent === 0) {
          this.fail(unavailable("outbound", "WebSocket send failed"));
          break;
        }
        if (!Number.isSafeInteger(sent) || sent < -1) {
          this.fail(unavailable("outbound", "WebSocket send returned an invalid result"));
          break;
        }

        if (frame.timing !== undefined) {
          observeTiming(this.delivery, frame.lane, frame.timing, "queue", "ok");
        }
        if (frame.timing !== undefined) {
          frame.timing.deliveryStartedAt = observationNow(this.delivery);
        }
        this.queue.shift();
        if (frame.timing === undefined) {
          this.buffered.push({ lane: frame.lane, reservation: frame.reservation });
        } else {
          this.buffered.push({
            lane: frame.lane,
            reservation: frame.reservation,
            timing: frame.timing,
          });
        }
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

  private releaseBuffered(bytes: number, outcome: DeliveryOutcome = "ok"): void {
    let remaining = bytes;
    while (remaining > 0) {
      const frame = this.buffered[0];
      if (frame === undefined) throw new Error("buffered byte accounting underflow");
      const released = Math.min(remaining, frame.reservation.remainingBytes);
      this.release(frame.reservation, released);
      this.bufferedBytes -= released;
      remaining -= released;
      if (frame.reservation.remainingBytes === 0) {
        this.buffered.shift();
        if (frame.timing !== undefined) {
          observeTiming(this.delivery, frame.lane, frame.timing, "delivery", outcome);
        }
      }
    }
  }

  private release(reservation: OutboundReservation, bytes = reservation.remainingBytes): void {
    reservation.release(bytes);
    if (reservation.lane === "application") this.applicationBytes -= bytes;
    else this.controlBytes -= bytes;
  }

  private releasePending(
    error: DbzzError,
    outcome: DeliveryOutcome = safeDeliveryOutcome(error),
  ): void {
    for (const frame of this.queue.splice(0)) {
      if (frame.timing !== undefined) {
        observeTiming(this.delivery, frame.lane, frame.timing, "queue", outcome);
      }
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
    this.releasePending(terminal, terminal.code);
    this.releaseBuffered(this.bufferedBytes, terminal.code);

    const terminalOutcome = outcomeFromError(terminal).code;
    const observer = captureDeliveryObserver(this.delivery, "control");
    const encodingStartedAt = observer === undefined ? undefined : observationNow(this.delivery);
    const text = webSocketErrorText(terminal, this.limits.maxFrameBytes);
    const bytes = text === null ? 0 : utf8.encode(text).byteLength;
    observeEncoding(
      this.delivery,
      observer,
      "control",
      "terminal",
      encodingStartedAt,
      bytes,
      text === null ? "overloaded" : "ok",
      terminalOutcome,
    );
    const timing = deliveryTiming(
      this.delivery,
      observer,
      "terminal",
      bytes,
      terminalOutcome,
    );
    const reservation = text === null ? null : this.budget.reserve(bytes, "control");
    observeTiming(
      this.delivery,
      "control",
      timing,
      "queue",
      reservation === null ? "overloaded" : "ok",
    );
    try {
      if (reservation !== null && text !== null) {
        if (timing !== undefined) {
          timing.deliveryStartedAt = observationNow(this.delivery);
        }
        let outcome: DeliveryOutcome = "ok";
        try {
          const sent = this.socket.send(text);
          if (sent === 0 || !Number.isSafeInteger(sent) || sent < -1) outcome = "unavailable";
        } catch {
          outcome = "unavailable";
        }
        observeTiming(
          this.delivery,
          "control",
          timing,
          "delivery",
          outcome,
        );
      }
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
  readonly encodedValue: string;
  readonly encodedValueBytes: number;
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

function sseFrameBytes(message: SseDoneMessage | SseErrorMessage): Uint8Array {
  return utf8.encode(`data: ${encode(message)}\n\n`);
}

function sseChunkBytes(seq: number, proof: string, encodedValue: string): Uint8Array {
  return utf8.encode(
    `data: {"v":${PROTOCOL_VERSION},"t":"sse_chunk","seq":${seq},"proof":${JSON.stringify(proof)},"value":${encodedValue}}\n\n`,
  );
}

const SSE_PROOF_LENGTH = 22;
const SSE_CHUNK_FIXED_BYTES =
  Buffer.byteLength(`data: {"v":${PROTOCOL_VERSION},"t":"sse_chunk","seq":`) +
  Buffer.byteLength(`,"proof":"","value":}\n\n`) +
  SSE_PROOF_LENGTH;
const MINIMUM_SSE_VALUE_BYTES = Buffer.byteLength("0");

function sseProof(): string {
  return randomBytes(16).toString("base64url");
}

function sameProof(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

function sseDoneBytes(seq: number, proof: string): Uint8Array {
  return sseFrameBytes({ v: PROTOCOL_VERSION, t: "sse_done", seq, proof });
}

function sseErrorBytes(error: DbzzError, maxBytes: number, seq: number, proof: string): Uint8Array {
  const outcome = outcomeFromError(error);
  const fitted = fitOutcome(outcome, maxBytes, (candidate) => {
    const value = sseFrameBytes({
      v: PROTOCOL_VERSION,
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
const MAXIMUM_SSE_RESOURCE = RESOURCE_CLASSES.reduce(
  (longest, resource) => resource.length > longest.length ? resource : longest,
);
const MINIMUM_SSE_CONTROL_BYTES = Math.max(
  sseErrorBytes(new DbzzError("unsupported_protocol", PUBLIC_ERROR_FALLBACK, {
    retryable: true,
    retryAfterMs: 30_000,
    resource: MAXIMUM_SSE_RESOURCE,
  }), Number.MAX_SAFE_INTEGER, MAXIMUM_SSE_SEQUENCE, MAXIMUM_SSE_PROOF).byteLength,
  sseErrorBytes(new DbzzError("convergence_unavailable", PUBLIC_ERROR_FALLBACK, {
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
  private failure: DbzzError | null = null;
  private closureError: DbzzError | null = null;
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
      isDbzzError(error) ? error : new DbzzError("internal", "SSE producer failed", { cause: error }),
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

  private prepareApplicationFrame(
    source: Extract<DeliverySource, "write" | "merge">,
    value: unknown,
  ): PreparedSseChunk {
    const observer = captureDeliveryObserver(this.delivery, "application");
    const encodingStartedAt = observer === undefined ? undefined : observationNow(this.delivery);
    try {
      const encodedValue = encode(value);
      return {
        source,
        encodedValue,
        encodedValueBytes: Buffer.byteLength(encodedValue),
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
    return SSE_CHUNK_FIXED_BYTES + String(this.nextSequence).length + frame.encodedValueBytes;
  }

  private materializeApplicationFrame(frame: PreparedSseChunk): ObservedSseFrame {
    const expectedBytes = this.candidateApplicationBytes(frame);
    const seq = this.nextSequence;
    const proof = sseProof();
    const bytes = sseChunkBytes(seq, proof, frame.encodedValue);
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
    const minimumBytes =
      SSE_CHUNK_FIXED_BYTES + String(this.nextSequence).length + MINIMUM_SSE_VALUE_BYTES;
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
    const terminal = isDbzzError(error)
      ? error
      : new DbzzError("internal", "SSE producer failed", { cause: error });
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
      const terminal = isDbzzError(error)
        ? error
        : new DbzzError("internal", "SSE producer failed", { cause: error });
      this.forceClose(terminal, "internal");
      throw terminal;
    }
    await this.waitForClosed();
  }

  private terminate(error: DbzzError): void {
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
      const canceledRequest = isDbzzError(reason) &&
        reason.code === "unavailable" &&
        reason.resource === "operation";
      if (canceledRequest) this.controller.close();
      else this.controller.error(reason ?? error);
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

  private forceClose(error: DbzzError, outcome: DeliveryOutcome): void {
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
