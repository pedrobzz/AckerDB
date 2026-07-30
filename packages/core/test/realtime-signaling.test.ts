import { describe, expect, test } from "bun:test";
import {
  PROTOCOL_VERSION,
  ProtocolError,
  parseRealtimeCandidatesMessage,
  parseRealtimeConfigurationMessage,
  parseRealtimeOfferRequest,
  parseRealtimeOfferResponse,
  parseRealtimePatchResponse,
} from "@ackerdb/core";

describe("realtime signaling protocol", () => {
  test("parses configuration, offer, answer, and trickled candidates", () => {
    expect(parseRealtimeConfigurationMessage({
      v: PROTOCOL_VERSION,
      t: "realtime_config",
      configuration: {
        iceServers: [{ urls: "turn:relay.example.test", username: "u", credential: "p" }],
      },
    })).toMatchObject({ t: "realtime_config" });
    expect(parseRealtimeOfferRequest({
      v: PROTOCOL_VERSION,
      t: "realtime_offer",
      ref: "assistant.voice",
      args: { id: 1n },
      offer: { type: "offer", sdp: "v=0\r\n" },
      recovery: true,
    })).toMatchObject({
      t: "realtime_offer",
      ref: "assistant.voice",
      recovery: true,
    });
    expect(parseRealtimeOfferResponse({
      v: PROTOCOL_VERSION,
      t: "realtime_answer",
      sessionId: "abcdefghijklmnopqrstuvwxyzABCDEF",
      answer: { type: "answer", sdp: "v=0\r\n" },
      streamLimits: {
        client: { photo: 1_000_000 },
        server: { transcript: 65_536 },
      },
      candidates: [{
        candidate: "candidate:1 1 UDP 1 127.0.0.1 9 typ host",
        sdpMid: "0",
        sdpMLineIndex: 0,
      }],
      complete: false,
    })).toMatchObject({ t: "realtime_answer", complete: false });
    expect(parseRealtimeCandidatesMessage({
      v: PROTOCOL_VERSION,
      t: "realtime_candidates",
      candidates: [],
      complete: true,
    })).toMatchObject({ t: "realtime_candidates", complete: true });
  });

  test("parses typed rejection and terminal generation outcomes", () => {
    expect(parseRealtimeOfferResponse({
      v: PROTOCOL_VERSION,
      t: "realtime_rejected",
      error: {
        kind: "application",
        code: "not_ready",
        body: { wait: true },
        status: 409,
      },
    })).toMatchObject({ t: "realtime_rejected" });
    expect(parseRealtimePatchResponse({
      v: PROTOCOL_VERSION,
      t: "realtime_ended",
      outcome: {
        code: "unavailable",
        retryable: true,
        message: "peer ended",
        resource: "connection",
      },
    })).toMatchObject({ t: "realtime_ended" });
  });

  test("rejects wrong SDP roles, unknown fields, and invalid session IDs", () => {
    expect(() => parseRealtimeOfferRequest({
      v: PROTOCOL_VERSION,
      t: "realtime_offer",
      ref: "assistant.voice",
      args: {},
      offer: { type: "answer", sdp: "v=0\r\n" },
    })).toThrow(ProtocolError);
    expect(() => parseRealtimeOfferRequest({
      v: PROTOCOL_VERSION,
      t: "realtime_offer",
      ref: "assistant.voice",
      args: {},
      offer: { type: "offer", sdp: "v=0\r\n" },
      recovery: false,
    })).toThrow("recovery must be true");
    expect(() => parseRealtimeCandidatesMessage({
      v: PROTOCOL_VERSION,
      t: "realtime_candidates",
      candidates: [],
      complete: true,
      extra: true,
    })).toThrow("unknown field extra");
    expect(() => parseRealtimeOfferResponse({
      v: PROTOCOL_VERSION,
      t: "realtime_answer",
      sessionId: "../not-a-capability",
      answer: { type: "answer", sdp: "v=0\r\n" },
      streamLimits: { client: {}, server: {} },
      candidates: [],
      complete: true,
    })).toThrow("sessionId");
  });
});
