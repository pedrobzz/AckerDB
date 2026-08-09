import { describe, expect, test } from "bun:test";
import {
  ACKERDB_VERSION,
  ProtocolError,
  parseRealtimeCandidatesMessage,
  parseRealtimeOfferRequest,
  parseRealtimeOfferResponse,
  parseRealtimePatchResponse,
  parseRealtimePrepareRequest,
  parseRealtimePrepareResponse,
} from "@ackerdb/core";

describe("realtime signaling protocol", () => {
  test("parses preparation, ticketed offer, answer, and trickled candidates", () => {
    expect(parseRealtimePrepareRequest({
      v: ACKERDB_VERSION,
      t: "realtime_prepare",
      ref: "assistant.voice",
      args: { id: 1n },
      recovery: true,
    })).toMatchObject({
      t: "realtime_prepare",
      ref: "assistant.voice",
      recovery: true,
    });
    expect(parseRealtimePrepareResponse({
      v: ACKERDB_VERSION,
      t: "realtime_prepared",
      ticket: "A".repeat(43),
      configuration: {
        iceServers: [{ urls: "turn:relay.example.test", username: "u", credential: "p" }],
      },
    })).toMatchObject({ t: "realtime_prepared" });
    expect(parseRealtimeOfferRequest({
      v: ACKERDB_VERSION,
      t: "realtime_offer",
      ticket: "A".repeat(43),
      offer: { type: "offer", sdp: "v=0\r\n" },
    })).toMatchObject({ t: "realtime_offer" });
    expect(parseRealtimeOfferResponse({
      v: ACKERDB_VERSION,
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
      v: ACKERDB_VERSION,
      t: "realtime_candidates",
      candidates: [],
      complete: true,
    }, "client")).toMatchObject({ t: "realtime_candidates", complete: true });
  });

  test("parses typed rejection and terminal generation outcomes", () => {
    expect(parseRealtimeOfferResponse({
      v: ACKERDB_VERSION,
      t: "realtime_rejected",
      error: {
        kind: "application",
        code: "not_ready",
        body: { wait: true },
        status: 409,
      },
    })).toMatchObject({ t: "realtime_rejected" });
    expect(parseRealtimePatchResponse({
      v: ACKERDB_VERSION,
      t: "realtime_ended",
      outcome: {
        code: "unavailable",
        retryable: true,
        message: "peer ended",
        resource: "connection",
      },
    })).toMatchObject({ t: "realtime_ended" });
  });

  test("refuses a signaling frame from another build as a mixed install", () => {
    // Signaling is HTTP and has no handshake, so its first frame is its
    // greeting and the version on it is the whole guard. The sender is the
    // frame's own direction, so a prepare names the client and a prepared
    // names the application.
    try {
      parseRealtimePrepareRequest({
        v: "0.0.1",
        t: "realtime_prepare",
        ref: "api.assistant.voice",
        args: {},
      });
      throw new Error("expected a ProtocolError");
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolError);
      expect((error as ProtocolError).code).toBe("version_mismatch");
      expect((error as ProtocolError).message).toBe(
        `this application runs AckerDB ${ACKERDB_VERSION} and this client is 0.0.1` +
          " — install matching versions",
      );
    }
    try {
      parseRealtimePrepareResponse({
        v: "0.0.1",
        t: "realtime_prepared",
        ticket: "A".repeat(43),
        configuration: {},
      });
      throw new Error("expected a ProtocolError");
    } catch (error) {
      expect((error as ProtocolError).message).toBe(
        `this application runs AckerDB 0.0.1 and this client is ${ACKERDB_VERSION}` +
          " — install matching versions",
      );
    }
  });

  test("rejects legacy configuration fields, malformed tickets, and invalid session IDs", () => {
    expect(() => parseRealtimePrepareRequest({
      v: ACKERDB_VERSION,
      t: "realtime_config",
      configuration: {},
    })).toThrow(ProtocolError);
    expect(() => parseRealtimePrepareResponse({
      v: ACKERDB_VERSION,
      t: "realtime_prepared",
      ticket: "too-short",
      configuration: {},
    })).toThrow("ticket");
    expect(() => parseRealtimeOfferRequest({
      v: ACKERDB_VERSION,
      t: "realtime_offer",
      ticket: "A".repeat(43),
      offer: { type: "answer", sdp: "v=0\r\n" },
    })).toThrow(ProtocolError);
    expect(() => parseRealtimeOfferRequest({
      v: ACKERDB_VERSION,
      t: "realtime_offer",
      ticket: "A".repeat(43),
      offer: { type: "offer", sdp: "v=0\r\n" },
      ref: "assistant.voice",
    })).toThrow("unknown field ref");
    expect(() => parseRealtimeCandidatesMessage({
      v: ACKERDB_VERSION,
      t: "realtime_candidates",
      candidates: [],
      complete: true,
      extra: true,
    }, "client")).toThrow("unknown field extra");
    expect(() => parseRealtimeOfferResponse({
      v: ACKERDB_VERSION,
      t: "realtime_answer",
      sessionId: "../not-a-capability",
      answer: { type: "answer", sdp: "v=0\r\n" },
      streamLimits: { client: {}, server: {} },
      candidates: [],
      complete: true,
    })).toThrow("sessionId");
  });
});
