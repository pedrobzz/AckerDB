import {
  REALTIME_PROTOCOL_VERSION,
  REALTIME_STREAM_CHUNK_MAX_BYTES,
  RealtimeProtocolError,
  decodeRealtimeFrame,
  encodeRealtimeEvent,
  encodeRealtimeFrame,
  type RealtimeDataFrame,
  type RealtimeSignalFrame,
} from "./protocol.ts";
import type { Outcome } from "../protocol.ts";
import type { PortableRTCDataChannel } from "./webrtc.ts";

export class RealtimeStreamInterruptedError extends Error {
  readonly transferId: string;

  constructor(transferId: string, message = "realtime stream was interrupted") {
    super(message);
    this.name = "RealtimeStreamInterruptedError";
    this.transferId = transferId;
  }
}

export class RealtimeStreamOverrunError extends Error {
  readonly transferId: string;
  readonly maxBufferedBytes: number;

  constructor(transferId: string, maxBufferedBytes: number) {
    super(
      `realtime stream "${transferId}" exceeded its ${maxBufferedBytes}-byte receive buffer`,
    );
    this.name = "RealtimeStreamOverrunError";
    this.transferId = transferId;
    this.maxBufferedBytes = maxBufferedBytes;
  }
}

export class RealtimeStreamLimitError extends Error {
  readonly transferId: string;
  readonly maxBytes: number;

  constructor(transferId: string, maxBytes: number) {
    super(`realtime stream "${transferId}" exceeded its ${maxBytes}-byte limit`);
    this.name = "RealtimeStreamLimitError";
    this.transferId = transferId;
    this.maxBytes = maxBytes;
  }
}

export interface RealtimeDataPlaneClock {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface RealtimeDataPlaneIncomingStream {
  readonly id: string;
  readonly stream: string;
  readonly metadata: unknown;
  readonly size?: number;
  readonly readable: ReadableStream<Uint8Array>;
  readonly abortSignal: AbortSignal;
}

export interface RealtimeDataPlaneOutgoingStream {
  readonly id: string;
  readonly writable: WritableStream<Uint8Array>;
}

export interface RealtimeIncomingStreamDecision {
  readonly maxBytes: number;
  readonly accept: (
    input: RealtimeDataPlaneIncomingStream,
  ) => unknown;
}

export interface RealtimeDataPlaneOptions {
  readonly channel: PortableRTCDataChannel;
  readonly localPrefix: "c" | "s";
  readonly maxBufferedAmount: number;
  readonly maxConcurrentStreams: number;
  readonly maxIncomingBufferedBytes: number;
  readonly streamIdleMs: number;
  readonly clock?: RealtimeDataPlaneClock;
  readonly onEvent: (event: string, payload: unknown) => unknown;
  readonly onIncomingStream: (
    stream: string,
    metadata: unknown,
    size: number | undefined,
  ) => RealtimeIncomingStreamDecision | undefined;
  readonly onSessionError: (outcome: Outcome) => void;
  readonly onSignal: (frame: RealtimeSignalFrame) => unknown;
  readonly onFatalError: (error: unknown) => void;
  readonly onPressure?: (pressure: RealtimeDataPlanePressure) => void;
}

export type RealtimeDataPlanePressure =
  | "data-channel-buffer"
  | "stream-capacity"
  | "stream-buffer";

interface IncomingTransfer {
  readonly id: string;
  readonly maxBytes: number;
  readonly controller: AbortController;
  readonly readable: ReadableStream<Uint8Array>;
  streamController?: ReadableStreamDefaultController<Uint8Array>;
  idle?: unknown;
  bytes: number;
  ended: boolean;
}

interface OutgoingTransfer {
  readonly id: string;
  readonly maxBytes: number;
  streamController?: WritableStreamDefaultController;
  idle?: unknown;
  bytes: number;
  ended: boolean;
}

const SYSTEM_CLOCK: RealtimeDataPlaneClock = {
  setTimeout(callback, delayMs) {
    const handle = setTimeout(callback, delayMs);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function packetData(value: unknown): Promise<ArrayBuffer | Uint8Array> {
  if (value instanceof ArrayBuffer || value instanceof Uint8Array) {
    return Promise.resolve(value);
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return value.arrayBuffer();
  }
  return Promise.reject(
    new RealtimeProtocolError("realtime data channel received a non-binary message"),
  );
}

/**
 * One reliable ordered AckerDB data channel. It owns only typed events and
 * finite byte streams; native media tracks and user-created data channels
 * remain entirely outside this object.
 */
export class RealtimeDataPlane {
  private readonly channel: PortableRTCDataChannel;
  private readonly localPrefix: "c" | "s";
  private readonly remotePrefix: "c" | "s";
  private readonly maxBufferedAmount: number;
  private readonly maxConcurrentStreams: number;
  private readonly maxIncomingBufferedBytes: number;
  private readonly streamIdleMs: number;
  private readonly clock: RealtimeDataPlaneClock;
  private readonly onEvent: RealtimeDataPlaneOptions["onEvent"];
  private readonly onIncomingStream: RealtimeDataPlaneOptions["onIncomingStream"];
  private readonly onSessionError: RealtimeDataPlaneOptions["onSessionError"];
  private readonly onSignal: RealtimeDataPlaneOptions["onSignal"];
  private readonly onFatalError: RealtimeDataPlaneOptions["onFatalError"];
  private readonly onPressure: NonNullable<
    RealtimeDataPlaneOptions["onPressure"]
  >;
  private readonly incoming = new Map<string, IncomingTransfer>();
  private readonly outgoing = new Map<string, OutgoingTransfer>();
  private readonly ignoredTransfers = new Set<string>();
  private readonly ignoredTransferOrder: string[] = [];
  private readonly capacityWaiters = new Set<() => void>();
  private receiveTail = Promise.resolve();
  private nextTransfer = 0;
  private closed = false;

  constructor(options: RealtimeDataPlaneOptions) {
    this.channel = options.channel;
    this.localPrefix = options.localPrefix;
    this.remotePrefix = options.localPrefix === "c" ? "s" : "c";
    this.maxBufferedAmount = positiveInteger(
      options.maxBufferedAmount,
      "maxBufferedAmount",
    );
    this.maxConcurrentStreams = positiveInteger(
      options.maxConcurrentStreams,
      "maxConcurrentStreams",
    );
    this.maxIncomingBufferedBytes = positiveInteger(
      options.maxIncomingBufferedBytes,
      "maxIncomingBufferedBytes",
    );
    this.streamIdleMs = positiveInteger(options.streamIdleMs, "streamIdleMs");
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.onEvent = options.onEvent;
    this.onIncomingStream = options.onIncomingStream;
    this.onSessionError = options.onSessionError;
    this.onSignal = options.onSignal;
    this.onFatalError = options.onFatalError;
    this.onPressure = options.onPressure ?? (() => {});
    this.channel.binaryType = "arraybuffer";
    this.channel.bufferedAmountLowThreshold = Math.max(
      1,
      Math.floor(this.maxBufferedAmount / 2),
    );
    this.channel.addEventListener("message", this.receive);
    this.channel.addEventListener("bufferedamountlow", this.releaseCapacity);
    this.channel.addEventListener("close", this.criticalChannelFailed);
    this.channel.addEventListener("error", this.criticalChannelFailed);
  }

  send(event: string, payload: unknown): boolean {
    return this.trySend(encodeRealtimeEvent(event, payload));
  }

  sendSessionError(outcome: Outcome): boolean {
    return this.trySend(encodeRealtimeFrame({
      v: REALTIME_PROTOCOL_VERSION,
      t: "session_error",
      outcome,
    }));
  }

  async sendSignal(frame: RealtimeSignalFrame): Promise<void> {
    await this.waitAndSendPacket(encodeRealtimeFrame(frame), "signaling");
  }

  openStream(
    stream: string,
    metadata: unknown,
    maxBytes: number,
    size?: number,
  ): RealtimeDataPlaneOutgoingStream {
    if (this.closed || this.channel.readyState !== "open") {
      throw new RealtimeStreamInterruptedError("unopened", "realtime session is not connected");
    }
    positiveInteger(maxBytes, "maxBytes");
    if (
      size !== undefined &&
      (!Number.isSafeInteger(size) || size < 0 || size > maxBytes)
    ) {
      throw new RangeError(`size must be a non-negative safe integer no greater than ${maxBytes}`);
    }
    if (this.outgoing.size >= this.maxConcurrentStreams) {
      this.onPressure("stream-capacity");
      throw new RealtimeProtocolError("outgoing realtime stream capacity is full");
    }
    const id = `${this.localPrefix}:${++this.nextTransfer}`;
    const transfer: OutgoingTransfer = {
      id,
      maxBytes,
      bytes: 0,
      ended: false,
    };
    this.outgoing.set(id, transfer);
    this.touchOutgoing(transfer);
    try {
      this.sendControl({
        v: REALTIME_PROTOCOL_VERSION,
        t: "stream_open",
        id,
        stream,
        metadata,
        ...(size === undefined ? {} : { size }),
      });
    } catch (error) {
      this.finishOutgoing(transfer);
      throw error;
    }

    const writable = new WritableStream<Uint8Array>({
      start: (streamController) => {
        transfer.streamController = streamController;
      },
      write: (chunk) => this.writeStream(transfer, chunk),
      close: async () => {
        if (transfer.ended) return;
        await this.waitAndSend({
          v: REALTIME_PROTOCOL_VERSION,
          t: "stream_end",
          id,
        }, transfer);
        this.finishOutgoing(transfer);
      },
      abort: async () => {
        if (transfer.ended) return;
        this.bestEffortCancel(id);
        this.finishOutgoing(transfer);
      },
    });
    return Object.freeze({ id, writable });
  }

  close(reason: unknown = new RealtimeStreamInterruptedError("session")): void {
    if (this.closed) return;
    this.closed = true;
    this.channel.removeEventListener("message", this.receive);
    this.channel.removeEventListener("bufferedamountlow", this.releaseCapacity);
    this.channel.removeEventListener("close", this.criticalChannelFailed);
    this.channel.removeEventListener("error", this.criticalChannelFailed);
    for (const wake of [...this.capacityWaiters]) wake();
    this.capacityWaiters.clear();
    for (const transfer of [...this.incoming.values()]) {
      this.failIncoming(
        transfer,
        streamInterruption(transfer.id, reason),
      );
    }
    for (const transfer of [...this.outgoing.values()]) {
      this.failOutgoing(
        transfer,
        streamInterruption(transfer.id, reason),
      );
    }
  }

  private readonly receive = (event: MessageEvent): void => {
    const work = this.receiveTail.then(async () => {
      const data = await packetData(event.data);
      await this.accept(decodeRealtimeFrame(data));
    });
    this.receiveTail = work.catch((error) => {
      if (this.closed) return;
      try {
        this.onFatalError(error);
      } catch {
        // The data plane is already handing ownership to its fatal boundary.
      }
    });
  };

  private async accept(frame: RealtimeDataFrame): Promise<void> {
    switch (frame.t) {
      case "event": {
        const result = this.onEvent(frame.event, frame.payload);
        if (
          typeof result === "object" &&
          result !== null &&
          typeof (result as PromiseLike<unknown>).then === "function"
        ) {
          void Promise.resolve(result).catch((error) => {
            try {
              this.onFatalError(error);
            } catch {
              // The data plane is already handing ownership to its fatal boundary.
            }
          });
        }
        return;
      }
      case "stream_open":
        this.acceptStream(frame);
        return;
      case "stream_chunk":
        this.acceptChunk(frame.id, frame.chunk);
        return;
      case "stream_end":
        this.acceptEnd(frame.id);
        return;
      case "stream_cancel":
        this.acceptCancel(frame.id, frame.reason);
        return;
      case "session_error":
        this.onSessionError(frame.outcome);
        return;
      case "signal_description":
      case "signal_candidate":
        await this.onSignal(frame);
    }
  }

  private acceptStream(
    frame: Extract<RealtimeDataFrame, { readonly t: "stream_open" }>,
  ): void {
    if (!frame.id.startsWith(`${this.remotePrefix}:`)) {
      throw new RealtimeProtocolError("realtime stream uses the wrong transfer-id direction");
    }
    if (this.incoming.has(frame.id) || this.outgoing.has(frame.id)) {
      throw new RealtimeProtocolError("realtime transfer id is already active");
    }
    if (this.incoming.size >= this.maxConcurrentStreams) {
      this.onPressure("stream-capacity");
      this.bestEffortCancel(frame.id, "incoming realtime stream capacity is full");
      this.ignoreTransfer(frame.id);
      return;
    }
    let decision: RealtimeIncomingStreamDecision | undefined;
    try {
      decision = this.onIncomingStream(frame.stream, frame.metadata, frame.size);
    } catch {
      this.bestEffortCancel(frame.id);
      this.ignoreTransfer(frame.id);
      return;
    }
    if (decision === undefined) {
      this.bestEffortCancel(frame.id, "no handler accepts this realtime stream");
      this.ignoreTransfer(frame.id);
      return;
    }
    positiveInteger(decision.maxBytes, "incoming stream maxBytes");
    if (frame.size !== undefined && frame.size > decision.maxBytes) {
      this.bestEffortCancel(frame.id, "declared realtime stream size exceeds its limit");
      this.ignoreTransfer(frame.id);
      return;
    }

    const controller = new AbortController();
    const transfer: IncomingTransfer = {
      id: frame.id,
      maxBytes: decision.maxBytes,
      controller,
      readable: undefined as unknown as ReadableStream<Uint8Array>,
      bytes: 0,
      ended: false,
    };
    const readable = new ReadableStream<Uint8Array>({
      start: (streamController) => {
        transfer.streamController = streamController;
      },
      pull: () => {
        this.touchIncoming(transfer);
      },
      cancel: (reason) => {
        this.bestEffortCancel(frame.id);
        this.finishIncoming(transfer, reason);
      },
    }, new ByteLengthQueuingStrategy({
      highWaterMark: this.maxIncomingBufferedBytes,
    }));
    Object.defineProperty(transfer, "readable", {
      value: readable,
      enumerable: true,
    });
    this.incoming.set(frame.id, transfer);
    this.touchIncoming(transfer);
    try {
      const result = decision.accept(Object.freeze({
        id: frame.id,
        stream: frame.stream,
        metadata: frame.metadata,
        ...(frame.size === undefined ? {} : { size: frame.size }),
        readable,
        abortSignal: controller.signal,
      }));
      if (
        typeof result === "object" &&
        result !== null &&
        typeof (result as PromiseLike<unknown>).then === "function"
      ) {
        void Promise.resolve(result).catch((error) => {
          this.bestEffortCancel(frame.id);
          this.failIncoming(transfer, error);
        });
      }
    } catch (error) {
      this.bestEffortCancel(frame.id);
      this.failIncoming(transfer, error);
    }
  }

  private acceptChunk(id: string, chunk: Uint8Array): void {
    const transfer = this.incoming.get(id);
    if (transfer === undefined || transfer.ended) {
      if (this.ignoredTransfers.has(id)) return;
      throw new RealtimeProtocolError("realtime stream chunk has no active transfer");
    }
    const bytes = transfer.bytes + chunk.byteLength;
    if (bytes > transfer.maxBytes) {
      const error = new RealtimeStreamLimitError(id, transfer.maxBytes);
      this.bestEffortCancel(id, "realtime stream exceeded its byte limit");
      this.failIncoming(transfer, error);
      return;
    }
    const desired = transfer.streamController?.desiredSize ?? 0;
    if (desired < chunk.byteLength) {
      this.onPressure("stream-buffer");
      const error = new RealtimeStreamOverrunError(
        id,
        this.maxIncomingBufferedBytes,
      );
      this.bestEffortCancel(id, "realtime stream receive buffer is full");
      this.failIncoming(transfer, error);
      return;
    }
    transfer.bytes = bytes;
    transfer.streamController!.enqueue(chunk);
    this.touchIncoming(transfer);
  }

  private acceptEnd(id: string): void {
    const transfer = this.incoming.get(id);
    if (transfer === undefined || transfer.ended) {
      if (this.ignoredTransfers.delete(id)) return;
      throw new RealtimeProtocolError("realtime stream end has no active transfer");
    }
    transfer.streamController!.close();
    this.finishIncoming(transfer);
  }

  private acceptCancel(id: string, reason: string): void {
    const incoming = this.incoming.get(id);
    if (incoming !== undefined) {
      this.failIncoming(
        incoming,
        new RealtimeStreamInterruptedError(id, reason),
      );
      return;
    }
    const outgoing = this.outgoing.get(id);
    if (outgoing !== undefined) {
      this.failOutgoing(
        outgoing,
        new RealtimeStreamInterruptedError(id, reason),
      );
      return;
    }
    if (this.ignoredTransfers.delete(id)) return;
    throw new RealtimeProtocolError("realtime stream cancellation has no active transfer");
  }

  private async writeStream(
    transfer: OutgoingTransfer,
    rawChunk: Uint8Array,
  ): Promise<void> {
    if (!(rawChunk instanceof Uint8Array)) {
      throw new TypeError("realtime stream writes must be Uint8Array");
    }
    if (transfer.ended || this.closed) {
      throw new RealtimeStreamInterruptedError(transfer.id);
    }
    const total = transfer.bytes + rawChunk.byteLength;
    if (total > transfer.maxBytes) {
      const error = new RealtimeStreamLimitError(transfer.id, transfer.maxBytes);
      this.bestEffortCancel(
        transfer.id,
        "realtime stream exceeded its byte limit",
      );
      this.finishOutgoing(transfer);
      throw error;
    }
    for (
      let offset = 0;
      offset < rawChunk.byteLength;
      offset += REALTIME_STREAM_CHUNK_MAX_BYTES
    ) {
      const chunk = rawChunk.subarray(
        offset,
        Math.min(rawChunk.byteLength, offset + REALTIME_STREAM_CHUNK_MAX_BYTES),
      );
      await this.waitAndSend({
        v: REALTIME_PROTOCOL_VERSION,
        t: "stream_chunk",
        id: transfer.id,
        chunk,
      }, transfer);
    }
    transfer.bytes = total;
    this.touchOutgoing(transfer);
  }

  private sendControl(frame: RealtimeDataFrame): void {
    if (this.closed || this.channel.readyState !== "open") {
      throw new RealtimeStreamInterruptedError(
        "session",
        "realtime data channel is not open",
      );
    }
    const packet = encodeRealtimeFrame(frame);
    if (this.channel.bufferedAmount + packet.byteLength > this.maxBufferedAmount) {
      this.onPressure("data-channel-buffer");
      throw new RealtimeProtocolError("realtime data channel is backpressured");
    }
    this.channel.send(packet as Uint8Array<ArrayBuffer>);
  }

  private async waitAndSend(
    frame: RealtimeDataFrame,
    transfer: OutgoingTransfer,
  ): Promise<void> {
    await this.waitAndSendPacket(
      encodeRealtimeFrame(frame),
      transfer.id,
      transfer,
    );
  }

  private trySend(packet: Uint8Array): boolean {
    if (this.closed || this.channel.readyState !== "open") return false;
    if (this.channel.bufferedAmount + packet.byteLength > this.maxBufferedAmount) {
      this.onPressure("data-channel-buffer");
      return false;
    }
    try {
      this.channel.send(packet as Uint8Array<ArrayBuffer>);
      return true;
    } catch {
      return false;
    }
  }

  private async waitAndSendPacket(
    packet: Uint8Array,
    transferId: string,
    transfer?: OutgoingTransfer,
  ): Promise<void> {
    const active = () =>
      !transfer?.ended &&
      !this.closed &&
      this.channel.readyState === "open";
    if (
      active() &&
      this.channel.bufferedAmount + packet.byteLength > this.maxBufferedAmount
    ) {
      this.onPressure("data-channel-buffer");
    }
    while (
      active() &&
      this.channel.bufferedAmount + packet.byteLength > this.maxBufferedAmount
    ) {
      await new Promise<void>((resolve) => {
        this.capacityWaiters.add(resolve);
      });
    }
    if (!active()) {
      throw new RealtimeStreamInterruptedError(transferId);
    }
    this.channel.send(packet as Uint8Array<ArrayBuffer>);
  }

  private readonly releaseCapacity = (): void => {
    for (const wake of [...this.capacityWaiters]) wake();
    this.capacityWaiters.clear();
  };

  private readonly criticalChannelFailed = (): void => {
    if (this.closed) return;
    const error = new RealtimeStreamInterruptedError(
      "session",
      "realtime data channel closed",
    );
    this.close(error);
    try {
      this.onFatalError(error);
    } catch {
      // The data plane has already closed every resource it owns.
    }
  };

  private bestEffortCancel(
    id: string,
    reason = "realtime stream was cancelled",
  ): void {
    if (this.closed || this.channel.readyState !== "open") return;
    try {
      this.sendControl({
        v: REALTIME_PROTOCOL_VERSION,
        t: "stream_cancel",
        id,
        reason,
      });
    } catch {
      // The owning transfer already has a precise local failure.
    }
  }

  private touchIncoming(transfer: IncomingTransfer): void {
    if (transfer.idle !== undefined) this.clock.clearTimeout(transfer.idle);
    transfer.idle = this.clock.setTimeout(() => {
      const error = new RealtimeStreamInterruptedError(
        transfer.id,
        "realtime stream stopped making progress",
      );
      this.bestEffortCancel(
        transfer.id,
        "realtime stream stopped making progress",
      );
      this.failIncoming(transfer, error);
    }, this.streamIdleMs);
  }

  private touchOutgoing(transfer: OutgoingTransfer): void {
    if (transfer.idle !== undefined) this.clock.clearTimeout(transfer.idle);
    transfer.idle = this.clock.setTimeout(() => {
      const error = new RealtimeStreamInterruptedError(
        transfer.id,
        "realtime stream stopped making progress",
      );
      this.bestEffortCancel(
        transfer.id,
        "realtime stream stopped making progress",
      );
      this.failOutgoing(transfer, error);
    }, this.streamIdleMs);
  }

  private finishIncoming(
    transfer: IncomingTransfer,
    abortReason?: unknown,
  ): void {
    if (transfer.ended) return;
    transfer.ended = true;
    if (transfer.idle !== undefined) this.clock.clearTimeout(transfer.idle);
    this.incoming.delete(transfer.id);
    if (abortReason !== undefined && !transfer.controller.signal.aborted) {
      transfer.controller.abort(abortReason);
      this.ignoreTransfer(transfer.id);
    }
  }

  private failIncoming(
    transfer: IncomingTransfer,
    error: unknown,
  ): void {
    if (transfer.ended) return;
    try {
      transfer.streamController?.error(error);
    } finally {
      this.finishIncoming(transfer, error);
    }
  }

  private finishOutgoing(transfer: OutgoingTransfer): void {
    if (transfer.ended) return;
    transfer.ended = true;
    if (transfer.idle !== undefined) this.clock.clearTimeout(transfer.idle);
    this.outgoing.delete(transfer.id);
    this.ignoreTransfer(transfer.id);
    this.releaseCapacity();
  }

  private failOutgoing(transfer: OutgoingTransfer, error: unknown): void {
    if (transfer.ended) return;
    try {
      transfer.streamController?.error(error);
    } finally {
      this.finishOutgoing(transfer);
    }
  }

  private ignoreTransfer(id: string): void {
    if (this.ignoredTransfers.has(id)) return;
    this.ignoredTransfers.add(id);
    this.ignoredTransferOrder.push(id);
    const max = this.maxConcurrentStreams * 2;
    while (this.ignoredTransferOrder.length > max) {
      const oldest = this.ignoredTransferOrder.shift();
      if (oldest !== undefined) this.ignoredTransfers.delete(oldest);
    }
  }
}

function streamInterruption(
  transferId: string,
  reason: unknown,
): RealtimeStreamInterruptedError {
  const message = reason instanceof Error
    ? reason.message
    : typeof reason === "string" && reason.length > 0
    ? reason
    : undefined;
  return new RealtimeStreamInterruptedError(transferId, message);
}
