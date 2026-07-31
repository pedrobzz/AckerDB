import { Packr } from "msgpackr";
import { parseOutcome, type Outcome } from "../protocol.ts";
import {
  exactFields as exact,
  protocolObject as record,
} from "../protocol-validation.ts";
import {
  parseRealtimeIceCandidate,
  parseRealtimeSessionDescription,
  type RealtimeIceCandidate,
  type RealtimeSessionDescription,
} from "./signaling.ts";

export const REALTIME_PROTOCOL_VERSION = 1 as const;
export const REALTIME_EVENT_MAX_BYTES = 16 * 1024;
export const REALTIME_PACKET_MAX_BYTES = 16 * 1024;
export const REALTIME_STREAM_CHUNK_MAX_BYTES = 12 * 1024;
export const REALTIME_SIGNAL_DESCRIPTION_MAX_BYTES = 256 * 1024;

export type RealtimeSignalFrame =
  | {
      readonly v: typeof REALTIME_PROTOCOL_VERSION;
      readonly t: "signal_description";
      readonly description: RealtimeSessionDescription;
    }
  | {
      readonly v: typeof REALTIME_PROTOCOL_VERSION;
      readonly t: "signal_candidate";
      readonly candidate: RealtimeIceCandidate | null;
    };

export type RealtimeDataFrame =
  | {
      readonly v: typeof REALTIME_PROTOCOL_VERSION;
      readonly t: "event";
      readonly event: string;
      readonly payload: unknown;
    }
  | {
      readonly v: typeof REALTIME_PROTOCOL_VERSION;
      readonly t: "stream_open";
      readonly id: string;
      readonly stream: string;
      readonly metadata: unknown;
      readonly size?: number;
    }
  | {
      readonly v: typeof REALTIME_PROTOCOL_VERSION;
      readonly t: "stream_chunk";
      readonly id: string;
      readonly chunk: Uint8Array;
    }
  | {
      readonly v: typeof REALTIME_PROTOCOL_VERSION;
      readonly t: "stream_end";
      readonly id: string;
    }
  | {
      readonly v: typeof REALTIME_PROTOCOL_VERSION;
      readonly t: "stream_cancel";
      readonly id: string;
      readonly reason: string;
    }
  | {
      readonly v: typeof REALTIME_PROTOCOL_VERSION;
      readonly t: "session_error";
      readonly outcome: Outcome;
    }
  | RealtimeSignalFrame;

export class RealtimeProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RealtimeProtocolError";
  }
}

export class RealtimeEventTooLargeError extends RealtimeProtocolError {
  readonly encodedBytes: number;
  readonly maxBytes: number;

  constructor(encodedBytes: number, maxBytes = REALTIME_EVENT_MAX_BYTES) {
    super(`realtime event uses ${encodedBytes} encoded bytes; maximum is ${maxBytes}`);
    this.name = "RealtimeEventTooLargeError";
    this.encodedBytes = encodedBytes;
    this.maxBytes = maxBytes;
  }
}

const codec = new Packr({
  useRecords: false,
  mapsAsObjects: true,
  useBigIntExtension: true,
  writeFunction() {
    throw new RealtimeProtocolError("realtime values cannot contain functions");
  },
  onInvalidDate() {
    throw new RealtimeProtocolError("realtime values cannot contain invalid dates");
  },
});

const TRANSFER_ID = /^[cs]:[1-9][0-9]{0,15}$/;
const NAME = /^[\x21-\x7e]{1,128}$/;

function name(value: unknown, path: string): string {
  if (typeof value !== "string" || !NAME.test(value)) {
    throw new RealtimeProtocolError(`${path} must be 1-128 visible ASCII characters`);
  }
  return value;
}

function transferId(value: unknown): string {
  if (typeof value !== "string" || !TRANSFER_ID.test(value)) {
    throw new RealtimeProtocolError("realtime transfer id is invalid");
  }
  return value;
}

function finiteSize(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RealtimeProtocolError("realtime stream size must be a non-negative safe integer");
  }
  return value as number;
}

function bytes(value: ArrayBuffer | Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function pack(frame: RealtimeDataFrame, limit: number): Uint8Array {
  let encoded: Uint8Array;
  try {
    encoded = codec.pack(frame);
  } catch (cause) {
    if (cause instanceof RealtimeProtocolError) throw cause;
    throw new RealtimeProtocolError("realtime frame could not be encoded", {
      cause,
    });
  }
  if (encoded.byteLength > limit) {
    if (frame.t === "event") {
      throw new RealtimeEventTooLargeError(encoded.byteLength, limit);
    }
    throw new RealtimeProtocolError(
      `realtime ${frame.t} frame uses ${encoded.byteLength} encoded bytes; maximum is ${limit}`,
    );
  }
  return encoded;
}

export function encodeRealtimeEvent(
  event: string,
  payload: unknown,
): Uint8Array {
  return pack({
    v: REALTIME_PROTOCOL_VERSION,
    t: "event",
    event: name(event, "event"),
    payload,
  }, REALTIME_EVENT_MAX_BYTES);
}

export function encodeRealtimeFrame(frame: RealtimeDataFrame): Uint8Array {
  if (frame.t === "event") return encodeRealtimeEvent(frame.event, frame.payload);
  if (frame.t === "signal_description") {
    parseRealtimeSessionDescription(frame.description);
    return pack(frame, REALTIME_SIGNAL_DESCRIPTION_MAX_BYTES);
  }
  if (frame.t === "signal_candidate") {
    if (frame.candidate !== null) parseRealtimeIceCandidate(frame.candidate);
    return pack(frame, REALTIME_PACKET_MAX_BYTES);
  }
  if (
    frame.t === "stream_chunk" &&
    frame.chunk.byteLength > REALTIME_STREAM_CHUNK_MAX_BYTES
  ) {
    throw new RealtimeProtocolError(
      `realtime stream chunk uses ${frame.chunk.byteLength} bytes; maximum is ${REALTIME_STREAM_CHUNK_MAX_BYTES}`,
    );
  }
  return pack(frame, REALTIME_PACKET_MAX_BYTES);
}

export function decodeRealtimeFrame(
  raw: ArrayBuffer | Uint8Array,
): RealtimeDataFrame {
  const packet = bytes(raw);
  if (
    packet.byteLength === 0 ||
    packet.byteLength > REALTIME_SIGNAL_DESCRIPTION_MAX_BYTES
  ) {
    throw new RealtimeProtocolError(
      `realtime packet must contain 1-${REALTIME_SIGNAL_DESCRIPTION_MAX_BYTES} bytes`,
    );
  }
  let decoded: unknown;
  try {
    decoded = codec.unpack(packet);
  } catch (cause) {
    throw new RealtimeProtocolError("realtime packet is malformed MessagePack", {
      cause,
    });
  }
  const frame = record(decoded, "realtime frame");
  if (frame.v !== REALTIME_PROTOCOL_VERSION) {
    throw new RealtimeProtocolError("unsupported realtime protocol version");
  }
  if (
    packet.byteLength > REALTIME_PACKET_MAX_BYTES &&
    frame.t !== "event" &&
    frame.t !== "signal_description"
  ) {
    throw new RealtimeProtocolError(
      `realtime ${String(frame.t)} packet is too large`,
    );
  }
  switch (frame.t) {
    case "event": {
      if (packet.byteLength > REALTIME_EVENT_MAX_BYTES) {
        throw new RealtimeEventTooLargeError(
          packet.byteLength,
          REALTIME_EVENT_MAX_BYTES,
        );
      }
      exact(frame, ["v", "t", "event", "payload"]);
      return Object.freeze({
        v: REALTIME_PROTOCOL_VERSION,
        t: "event",
        event: name(frame.event, "event"),
        payload: frame.payload,
      });
    }
    case "stream_open": {
      const hasSize = Object.hasOwn(frame, "size");
      exact(
        frame,
        hasSize
          ? ["v", "t", "id", "stream", "metadata", "size"]
          : ["v", "t", "id", "stream", "metadata"],
      );
      return Object.freeze({
        v: REALTIME_PROTOCOL_VERSION,
        t: "stream_open",
        id: transferId(frame.id),
        stream: name(frame.stream, "stream"),
        metadata: frame.metadata,
        ...(hasSize ? { size: finiteSize(frame.size) } : {}),
      });
    }
    case "stream_chunk": {
      exact(frame, ["v", "t", "id", "chunk"]);
      if (!(frame.chunk instanceof Uint8Array)) {
        throw new RealtimeProtocolError("realtime stream chunk must be bytes");
      }
      if (frame.chunk.byteLength > REALTIME_STREAM_CHUNK_MAX_BYTES) {
        throw new RealtimeProtocolError(
          `realtime stream chunk uses ${frame.chunk.byteLength} bytes; maximum is ${REALTIME_STREAM_CHUNK_MAX_BYTES}`,
        );
      }
      return Object.freeze({
        v: REALTIME_PROTOCOL_VERSION,
        t: "stream_chunk",
        id: transferId(frame.id),
        chunk: frame.chunk,
      });
    }
    case "stream_end": {
      exact(frame, ["v", "t", "id"]);
      return Object.freeze({
        v: REALTIME_PROTOCOL_VERSION,
        t: "stream_end",
        id: transferId(frame.id),
      });
    }
    case "stream_cancel": {
      exact(frame, ["v", "t", "id", "reason"]);
      const reason = frame.reason;
      if (typeof reason !== "string" || reason.length > 256) {
        throw new RealtimeProtocolError(
          "realtime stream cancellation reason must be at most 256 characters",
        );
      }
      return Object.freeze({
        v: REALTIME_PROTOCOL_VERSION,
        t: "stream_cancel",
        id: transferId(frame.id),
        reason,
      });
    }
    case "session_error": {
      exact(frame, ["v", "t", "outcome"]);
      return Object.freeze({
        v: REALTIME_PROTOCOL_VERSION,
        t: "session_error",
        outcome: parseOutcome(frame.outcome),
      });
    }
    case "signal_description": {
      exact(
        frame,
        ["v", "t", "description"],
      );
      return Object.freeze({
        v: REALTIME_PROTOCOL_VERSION,
        t: "signal_description",
        description: parseRealtimeSessionDescription(frame.description),
      });
    }
    case "signal_candidate": {
      exact(frame, ["v", "t", "candidate"]);
      return Object.freeze({
        v: REALTIME_PROTOCOL_VERSION,
        t: "signal_candidate",
        candidate: frame.candidate === null
          ? null
          : parseRealtimeIceCandidate(frame.candidate),
      });
    }
    default:
      throw new RealtimeProtocolError("unknown realtime frame type");
  }
}
