import {
  ACKERDB_VERSION,
  encode,
  type Outcome,
} from "@ackerdb/core";
import { AckerDBError } from "../../shared/errors.ts";
import type { ServiceLimits } from "../../runtime/limits.ts";
import { fitOutcome, outcomeFromError, outcomeWebSocketClose } from "../../runtime/outcome.ts";
import {
  assertRuntimePublication,
  type RuntimePublication,
  type SessionControlMessage,
  type SessionSink,
} from "../session/contract.ts";
import type { OutboundBudget, OutboundLane, OutboundReservation } from "./budget.ts";
import { finiteClock, SYSTEM_CLOCK, type Clock } from "../../shared/clock.ts";
import { overloaded, slowConsumer, unavailable } from "./failure.ts";
import { utf8ByteLength } from "../../shared/bytes.ts";

export interface WebSocketDeliverySocket {
  send(data: string): number;
  getBufferedAmount(): number;
  close(code: number, reason: string): void;
}

export interface WebSocketSessionSinkOptions {
  readonly socket: WebSocketDeliverySocket;
  readonly budget: OutboundBudget;
  readonly limits: ServiceLimits;
  readonly clock?: Clock;
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

function webSocketErrorText(error: AckerDBError, maxBytes: number): string | null {
  const outcome = outcomeFromError(error);
  return fitOutcome(outcome, maxBytes, (candidate) => {
    const value = encode({
      v: ACKERDB_VERSION,
      t: "err",
      id: null,
      outcome: candidate,
    } satisfies SessionControlMessage);
    return { value, bytes: utf8ByteLength(value) };
  })?.value ?? null;
}

/** A FIFO Protocol-2 sink with one finite queue and Bun-aware drain ownership. */
export class WebSocketSessionSink implements SessionSink {
  readonly controlReserveBytes: number;

  private readonly socket: WebSocketDeliverySocket;
  private readonly budget: OutboundBudget;
  private readonly limits: ServiceLimits;
  private readonly clock: Clock;
  private readonly now: () => number;
  private readonly queue: PendingFrame[] = [];
  private readonly buffered: BufferedFrame[] = [];
  private applicationBytes = 0;
  private controlBytes = 0;
  private bufferedBytes = 0;
  private blocked = false;
  private closed = false;
  private pumping = false;
  private terminalError: AckerDBError | null = null;
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
    this.now = finiteClock(() => this.clock.now(), "delivery clock");
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
    frame: SessionControlMessage | RuntimePublication,
  ): Promise<void> {
    if (this.closed) {
      const error = this.terminalError ?? unavailable("outbound", "WebSocket is closed");
      return Promise.reject(error);
    }
    let text: string;
    let bytes: number;
    if (lane === "application") {
      const publication = frame as RuntimePublication;
      try {
        assertRuntimePublication(publication);
      } catch (error) {
        return Promise.reject(error);
      }
      text = publication.text;
      bytes = publication.bytes;
    } else {
      try {
        text = encode(frame);
      } catch (error) {
        return Promise.reject(error);
      }
      bytes = utf8ByteLength(text);
    }
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
      if (frame.reservation.remainingBytes === 0) {
        this.buffered.shift();
      }
    }
  }

  private release(reservation: OutboundReservation, bytes = reservation.remainingBytes): void {
    reservation.release(bytes);
    if (reservation.lane === "application") this.applicationBytes -= bytes;
    else this.controlBytes -= bytes;
  }

  private releasePending(error: AckerDBError): void {
    for (const frame of this.queue.splice(0)) {
      this.release(frame.reservation);
      frame.reject(error);
    }
  }

  private armStall(): void {
    if (this.stallSince === null) this.stallSince = this.now();
    if (this.stallTimer !== undefined) return;
    const elapsed = Math.max(0, this.now() - this.stallSince);
    this.stallTimer = this.clock.setTimeout(
      () => this.onStallTimer(),
      Math.max(1, this.limits.webSocket.maxStallMs - elapsed),
    );
  }

  private restartStall(): void {
    if (this.stallTimer !== undefined) this.clock.clearTimeout(this.stallTimer);
    this.stallTimer = undefined;
    this.stallSince = this.now();
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
      this.stallSince = this.now();
      this.armStall();
      return;
    }
    if (this.bufferedBytes === 0 && !this.blocked) {
      this.clearStall();
      return;
    }
    const elapsed = Math.max(0, this.now() - this.stallSince);
    if (elapsed < this.limits.webSocket.maxStallMs) {
      this.armStall();
      return;
    }
    this.fail(slowConsumer("outbound", "WebSocket consumer stalled"));
  }

  private fail(error: AckerDBError, cause?: unknown): void {
    if (this.closed) return;
    const terminal =
      cause === undefined
        ? error
        : new AckerDBError(error.code, error.message, {
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
    const bytes = text === null ? 0 : utf8ByteLength(text);
    const reservation = text === null ? null : this.budget.reserve(bytes, "control");
    try {
      if (reservation !== null && text !== null) {
        try {
          const sent = this.socket.send(text);
          if (sent === 0 || !Number.isSafeInteger(sent) || sent < -1) {
            throw new Error("WebSocket terminal send failed");
          }
        } catch {
          // The authoritative close below does not depend on the best-effort frame.
        }
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
