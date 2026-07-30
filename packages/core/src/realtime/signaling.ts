import {
  PROTOCOL_VERSION,
  ProtocolError,
  parseApplicationError,
  parseOutcome,
  type Outcome,
} from "../protocol.ts";
import type { ApplicationError } from "../result.ts";
import type { NativeRTCConfiguration } from "./webrtc.ts";

export interface RealtimeSessionDescription {
  readonly type: "offer" | "answer";
  readonly sdp: string;
}

export interface RealtimeIceCandidate {
  readonly candidate: string;
  readonly sdpMid?: string | null;
  readonly sdpMLineIndex?: number | null;
  readonly usernameFragment?: string | null;
}

export interface RealtimeCandidateBatch {
  readonly candidates: readonly RealtimeIceCandidate[];
  readonly complete: boolean;
}

export interface RealtimeStreamLimits {
  readonly client: Readonly<Record<string, number>>;
  readonly server: Readonly<Record<string, number>>;
}

export interface RealtimeConfigurationMessage {
  readonly v: typeof PROTOCOL_VERSION;
  readonly t: "realtime_config";
  readonly configuration: NativeRTCConfiguration;
}

export interface RealtimeOfferRequest {
  readonly v: typeof PROTOCOL_VERSION;
  readonly t: "realtime_offer";
  readonly ref: string;
  readonly args: unknown;
  readonly offer: RealtimeSessionDescription;
  /** Low-cardinality generation-replacement observation; never application state. */
  readonly recovery?: true;
}

export interface RealtimeAnswerMessage extends RealtimeCandidateBatch {
  readonly v: typeof PROTOCOL_VERSION;
  readonly t: "realtime_answer";
  readonly sessionId: string;
  readonly answer: RealtimeSessionDescription;
  readonly streamLimits: RealtimeStreamLimits;
}

export interface RealtimeRejectedMessage {
  readonly v: typeof PROTOCOL_VERSION;
  readonly t: "realtime_rejected";
  readonly error: ApplicationError;
}

export type RealtimeOfferResponse =
  | RealtimeAnswerMessage
  | RealtimeRejectedMessage;

export interface RealtimeCandidatesMessage extends RealtimeCandidateBatch {
  readonly v: typeof PROTOCOL_VERSION;
  readonly t: "realtime_candidates";
}

export interface RealtimeEndedMessage {
  readonly v: typeof PROTOCOL_VERSION;
  readonly t: "realtime_ended";
  readonly outcome: Outcome;
}

export type RealtimePatchResponse =
  | RealtimeCandidatesMessage
  | RealtimeEndedMessage;

type ObjectValue = Record<string, unknown>;

const SESSION_ID = /^[A-Za-z0-9_-]{32}$/;
const MAX_REFERENCE_LENGTH = 512;
const MAX_SDP_BYTES = 256 * 1024;
const MAX_CANDIDATES_PER_FRAME = 4_096;
const utf8 = new TextEncoder();

function malformed(message: string): never {
  throw new ProtocolError("malformed", message);
}

function object(value: unknown, name: string): ObjectValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    malformed(`${name} must be an object`);
  }
  return value as ObjectValue;
}

function exact(
  value: ObjectValue,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  for (const key of required) {
    if (!Object.hasOwn(value, key)) malformed(`missing field ${key}`);
  }
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) {
      malformed(`unknown field ${key}`);
    }
  }
}

function frame(value: unknown, type: string): ObjectValue {
  const result = object(value, "realtime signaling frame");
  if (!Object.hasOwn(result, "v")) malformed("missing field v");
  if (result.v !== PROTOCOL_VERSION) {
    if (Number.isInteger(result.v)) {
      throw new ProtocolError(
        "unsupported_protocol",
        "unsupported protocol version",
      );
    }
    malformed("v must be an integer protocol version");
  }
  if (result.t !== type) {
    malformed(`realtime signaling frame must be ${type}`);
  }
  return result;
}

function boundedString(value: unknown, name: string, maxLength: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength
  ) {
    malformed(`${name} must be a non-empty bounded string`);
  }
  return value;
}

export function parseRealtimeSessionDescription(
  value: unknown,
  expected?: "offer" | "answer",
): RealtimeSessionDescription {
  const name = expected === undefined ? "realtime description" : `realtime ${expected}`;
  const result = object(value, name);
  exact(result, ["type", "sdp"]);
  if (
    result.type !== "offer" &&
    result.type !== "answer"
  ) {
    malformed("realtime SDP type must be offer or answer");
  }
  if (expected !== undefined && result.type !== expected) {
    malformed(`realtime SDP type must be ${expected}`);
  }
  const sdp = boundedString(result.sdp, `${name} SDP`, MAX_SDP_BYTES);
  if (utf8.encode(sdp).byteLength > MAX_SDP_BYTES) {
    malformed(`${name} SDP exceeds ${MAX_SDP_BYTES} bytes`);
  }
  return result as unknown as RealtimeSessionDescription;
}

export function parseRealtimeIceCandidate(value: unknown): RealtimeIceCandidate {
  const result = object(value, "realtime ICE candidate");
  exact(
    result,
    ["candidate"],
    ["sdpMid", "sdpMLineIndex", "usernameFragment"],
  );
  boundedString(result.candidate, "ICE candidate", 4_096);
  if (
    Object.hasOwn(result, "sdpMid") &&
    result.sdpMid !== null &&
    (typeof result.sdpMid !== "string" || result.sdpMid.length > 256)
  ) {
    malformed("ICE candidate sdpMid must be null or a bounded string");
  }
  if (
    Object.hasOwn(result, "sdpMLineIndex") &&
    result.sdpMLineIndex !== null &&
    (
      !Number.isSafeInteger(result.sdpMLineIndex) ||
      (result.sdpMLineIndex as number) < 0
    )
  ) {
    malformed("ICE candidate sdpMLineIndex must be null or a non-negative integer");
  }
  if (
    Object.hasOwn(result, "usernameFragment") &&
    result.usernameFragment !== null &&
    (
      typeof result.usernameFragment !== "string" ||
      result.usernameFragment.length > 256
    )
  ) {
    malformed("ICE candidate usernameFragment must be null or a bounded string");
  }
  return result as unknown as RealtimeIceCandidate;
}

function candidateBatch(value: ObjectValue): RealtimeCandidateBatch {
  if (
    !Array.isArray(value.candidates) ||
    value.candidates.length > MAX_CANDIDATES_PER_FRAME
  ) {
    malformed("realtime candidates must be a bounded array");
  }
  if (typeof value.complete !== "boolean") {
    malformed("realtime candidate completion must be a boolean");
  }
  return Object.freeze({
    candidates: Object.freeze(value.candidates.map(parseRealtimeIceCandidate)),
    complete: value.complete,
  });
}

function streamLimitMap(value: unknown, name: string): Readonly<Record<string, number>> {
  const result = object(value, name);
  for (const [stream, limit] of Object.entries(result)) {
    boundedString(stream, `${name} name`, 128);
    if (!Number.isSafeInteger(limit) || (limit as number) <= 0) {
      malformed(`${name}.${stream} must be a positive safe integer`);
    }
  }
  return result as Readonly<Record<string, number>>;
}

function streamLimits(value: unknown): RealtimeStreamLimits {
  const result = object(value, "realtime stream limits");
  exact(result, ["client", "server"]);
  streamLimitMap(result.client, "client stream limits");
  streamLimitMap(result.server, "server stream limits");
  return result as unknown as RealtimeStreamLimits;
}

export function parseRealtimeConfigurationMessage(
  value: unknown,
): RealtimeConfigurationMessage {
  const result = frame(value, "realtime_config");
  exact(result, ["v", "t", "configuration"]);
  object(result.configuration, "realtime configuration");
  return result as unknown as RealtimeConfigurationMessage;
}

export function parseRealtimeOfferRequest(value: unknown): RealtimeOfferRequest {
  const result = frame(value, "realtime_offer");
  exact(result, ["v", "t", "ref", "args", "offer"], ["recovery"]);
  boundedString(result.ref, "realtime ref", MAX_REFERENCE_LENGTH);
  if (result.args === undefined) malformed("realtime args must be wire-representable");
  if (result.recovery !== undefined && result.recovery !== true) {
    malformed("realtime recovery must be true when present");
  }
  parseRealtimeSessionDescription(result.offer, "offer");
  return result as unknown as RealtimeOfferRequest;
}

export function parseRealtimeOfferResponse(value: unknown): RealtimeOfferResponse {
  const result = object(value, "realtime offer response");
  switch (result.t) {
    case "realtime_answer": {
      frame(result, "realtime_answer");
      exact(
        result,
        [
          "v",
          "t",
          "sessionId",
          "answer",
          "streamLimits",
          "candidates",
          "complete",
        ],
      );
      if (typeof result.sessionId !== "string" || !SESSION_ID.test(result.sessionId)) {
        malformed("realtime sessionId is invalid");
      }
      parseRealtimeSessionDescription(result.answer, "answer");
      streamLimits(result.streamLimits);
      candidateBatch(result);
      return result as unknown as RealtimeAnswerMessage;
    }
    case "realtime_rejected":
      frame(result, "realtime_rejected");
      exact(result, ["v", "t", "error"]);
      parseApplicationError(result.error);
      return result as unknown as RealtimeRejectedMessage;
    default:
      return malformed("unknown realtime offer response");
  }
}

export function parseRealtimeCandidatesMessage(
  value: unknown,
): RealtimeCandidatesMessage {
  const result = frame(value, "realtime_candidates");
  exact(result, ["v", "t", "candidates", "complete"]);
  candidateBatch(result);
  return result as unknown as RealtimeCandidatesMessage;
}

export function parseRealtimePatchResponse(value: unknown): RealtimePatchResponse {
  const result = object(value, "realtime patch response");
  if (result.t === "realtime_candidates") {
    return parseRealtimeCandidatesMessage(result);
  }
  if (result.t === "realtime_ended") {
    frame(result, "realtime_ended");
    exact(result, ["v", "t", "outcome"]);
    parseOutcome(result.outcome);
    return result as unknown as RealtimeEndedMessage;
  }
  return malformed("unknown realtime patch response");
}

export function isRealtimeSessionId(value: string): boolean {
  return SESSION_ID.test(value);
}
