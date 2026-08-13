import {
  parseApplicationError,
  parseOutcome,
  type Outcome,
} from "../protocol.ts";
import {
  boundedString,
  exactFields as exact,
  frameVersion,
  malformed,
  protocolObject as object,
  type FrameSender,
  type ProtocolObject as ObjectValue,
} from "../protocol-validation.ts";
import { ACKERDB_VERSION } from "../version.ts";
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

export interface RealtimePrepareRequest {
  readonly v: typeof ACKERDB_VERSION;
  readonly t: "realtime_prepare";
  readonly ref: string;
  readonly args: unknown;
  /** Low-cardinality generation-replacement observation; never application state. */
  readonly recovery?: true;
}

export interface RealtimePreparedMessage {
  readonly v: typeof ACKERDB_VERSION;
  readonly t: "realtime_prepared";
  /** One 256-bit opaque capability, encoded as unpadded base64url. */
  readonly ticket: string;
  readonly configuration: NativeRTCConfiguration;
}

export interface RealtimeOfferRequest {
  readonly v: typeof ACKERDB_VERSION;
  readonly t: "realtime_offer";
  readonly ticket: string;
  readonly offer: RealtimeSessionDescription;
}

export interface RealtimeAnswerMessage extends RealtimeCandidateBatch {
  readonly v: typeof ACKERDB_VERSION;
  readonly t: "realtime_answer";
  readonly sessionId: string;
  readonly answer: RealtimeSessionDescription;
  readonly streamLimits: RealtimeStreamLimits;
}

export interface RealtimeRejectedMessage {
  readonly v: typeof ACKERDB_VERSION;
  readonly t: "realtime_rejected";
  readonly error: ApplicationError;
}

export type RealtimeOfferResponse =
  | RealtimeAnswerMessage
  | RealtimeRejectedMessage;

export type RealtimePrepareResponse =
  | RealtimePreparedMessage
  | RealtimeRejectedMessage;

export interface RealtimeCandidatesMessage extends RealtimeCandidateBatch {
  readonly v: typeof ACKERDB_VERSION;
  readonly t: "realtime_candidates";
}

export interface RealtimeEndedMessage {
  readonly v: typeof ACKERDB_VERSION;
  readonly t: "realtime_ended";
  readonly outcome: Outcome;
}

export type RealtimePatchResponse =
  | RealtimeCandidatesMessage
  | RealtimeEndedMessage;

const SESSION_ID = /^[A-Za-z0-9_-]{32}$/;
const TICKET = /^[A-Za-z0-9_-]{43}$/;
const MAX_REFERENCE_LENGTH = 512;
const MAX_SDP_BYTES = 256 * 1024;
const MAX_CANDIDATES_PER_FRAME = 4_096;
const utf8 = new TextEncoder();

// Realtime signaling is HTTP, so it has no handshake of its own and its first
// frame is its greeting. The sender is the frame type's own direction: every
// shape here travels one way, except the candidate batch a client PATCHes and
// the one the answer to that PATCH carries back.
function frame(value: unknown, type: string, sender: FrameSender): ObjectValue {
  const result = object(value, "realtime signaling frame");
  frameVersion(result.v, sender);
  if (result.t !== type) {
    malformed(`realtime signaling frame must be ${type}`);
  }
  return result;
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

export function parseRealtimePrepareRequest(value: unknown): RealtimePrepareRequest {
  const result = frame(value, "realtime_prepare", "client");
  exact(result, ["v", "t", "ref", "args"], ["recovery"]);
  boundedString(result.ref, "realtime ref", MAX_REFERENCE_LENGTH);
  if (result.args === undefined) malformed("realtime args must be wire-representable");
  if (result.recovery !== undefined && result.recovery !== true) {
    malformed("realtime recovery must be true when present");
  }
  return result as unknown as RealtimePrepareRequest;
}

function ticket(value: unknown): string {
  if (typeof value !== "string" || !TICKET.test(value)) {
    malformed("realtime ticket is invalid");
  }
  return value;
}

export function parseRealtimeOfferRequest(value: unknown): RealtimeOfferRequest {
  const result = frame(value, "realtime_offer", "client");
  exact(result, ["v", "t", "ticket", "offer"]);
  ticket(result.ticket);
  parseRealtimeSessionDescription(result.offer, "offer");
  return result as unknown as RealtimeOfferRequest;
}

function rejected(result: ObjectValue): RealtimeRejectedMessage {
  frame(result, "realtime_rejected", "application");
  exact(result, ["v", "t", "error"]);
  parseApplicationError(result.error);
  return result as unknown as RealtimeRejectedMessage;
}

export function parseRealtimePrepareResponse(value: unknown): RealtimePrepareResponse {
  const result = object(value, "realtime prepare response");
  if (result.t === "realtime_prepared") {
    frame(result, "realtime_prepared", "application");
    exact(result, ["v", "t", "ticket", "configuration"]);
    ticket(result.ticket);
    object(result.configuration, "realtime configuration");
    return result as unknown as RealtimePreparedMessage;
  }
  if (result.t === "realtime_rejected") return rejected(result);
  return malformed("unknown realtime prepare response");
}

export function parseRealtimeOfferResponse(value: unknown): RealtimeOfferResponse {
  const result = object(value, "realtime offer response");
  switch (result.t) {
    case "realtime_answer": {
      frame(result, "realtime_answer", "application");
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
      return rejected(result);
    default:
      return malformed("unknown realtime offer response");
  }
}

export function parseRealtimeCandidatesMessage(
  value: unknown,
  sender: FrameSender,
): RealtimeCandidatesMessage {
  const result = frame(value, "realtime_candidates", sender);
  exact(result, ["v", "t", "candidates", "complete"]);
  candidateBatch(result);
  return result as unknown as RealtimeCandidatesMessage;
}

export function parseRealtimePatchResponse(value: unknown): RealtimePatchResponse {
  const result = object(value, "realtime patch response");
  if (result.t === "realtime_candidates") {
    return parseRealtimeCandidatesMessage(result, "application");
  }
  if (result.t === "realtime_ended") {
    frame(result, "realtime_ended", "application");
    exact(result, ["v", "t", "outcome"]);
    parseOutcome(result.outcome);
    return result as unknown as RealtimeEndedMessage;
  }
  return malformed("unknown realtime patch response");
}

export function isRealtimeSessionId(value: string): boolean {
  return SESSION_ID.test(value);
}
