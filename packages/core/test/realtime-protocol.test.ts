import { describe, expect, test } from "bun:test";
import { Packr } from "msgpackr";
import {
  REALTIME_EVENT_MAX_BYTES,
  ACKERDB_VERSION,
  REALTIME_STREAM_CHUNK_MAX_BYTES,
  RealtimeEventTooLargeError,
  ProtocolError,
  RealtimeProtocolError,
  decodeRealtimeFrame,
  encodeRealtimeEvent,
  encodeRealtimeFrame,
} from "@ackerdb/core";

describe("realtime binary protocol", () => {
  test("round-trips typed event values and nested bytes without base64", () => {
    const encoded = encodeRealtimeEvent("audio.delta", {
      sequence: 2n ** 80n,
      audio: new Uint8Array([0, 1, 2, 255]),
      nested: [{ bytes: new Uint8Array([9, 8]) }],
    });
    expect(encoded).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(encoded)).not.toContain("AAEC");
    const decoded = decodeRealtimeFrame(encoded, "client");
    expect(decoded).toEqual({
      v: ACKERDB_VERSION,
      t: "event",
      event: "audio.delta",
      payload: {
        sequence: 2n ** 80n,
        audio: new Uint8Array([0, 1, 2, 255]),
        nested: [{ bytes: new Uint8Array([9, 8]) }],
      },
    });
  });

  test("round-trips independently decodable stream packets", () => {
    const open = encodeRealtimeFrame({
      v: ACKERDB_VERSION,
      t: "stream_open",
      id: "c:1",
      stream: "camera.snapshot",
      metadata: { contentType: "image/jpeg" },
      size: 3,
    });
    const chunk = encodeRealtimeFrame({
      v: ACKERDB_VERSION,
      t: "stream_chunk",
      id: "c:1",
      chunk: new Uint8Array([1, 2, 3]),
    });
    const end = encodeRealtimeFrame({
      v: ACKERDB_VERSION,
      t: "stream_end",
      id: "c:1",
    });
    expect(decodeRealtimeFrame(open, "client")).toMatchObject({
      t: "stream_open",
      id: "c:1",
      size: 3,
    });
    expect(decodeRealtimeFrame(chunk, "client")).toMatchObject({
      t: "stream_chunk",
      id: "c:1",
      chunk: new Uint8Array([1, 2, 3]),
    });
    expect(decodeRealtimeFrame(end, "client")).toEqual({
      v: ACKERDB_VERSION,
      t: "stream_end",
      id: "c:1",
    });
  });

  test("enforces atomic event and bounded stream-chunk limits", () => {
    expect(() => encodeRealtimeEvent("large", {
      bytes: new Uint8Array(REALTIME_EVENT_MAX_BYTES),
    })).toThrow(RealtimeEventTooLargeError);
    expect(() => encodeRealtimeFrame({
      v: ACKERDB_VERSION,
      t: "stream_chunk",
      id: "c:1",
      chunk: new Uint8Array(REALTIME_STREAM_CHUNK_MAX_BYTES + 1),
    })).toThrow("maximum");
  });

  test("rejects malformed, non-exact, and unsupported frames", () => {
    expect(() => decodeRealtimeFrame(new Uint8Array(), "client")).toThrow(
      RealtimeProtocolError,
    );
    expect(() => decodeRealtimeFrame(new Uint8Array([0xd9]), "client")).toThrow(
      "malformed MessagePack",
    );
    const encoded = encodeRealtimeFrame({
      v: ACKERDB_VERSION,
      t: "stream_end",
      id: "c:1",
    });
    encoded[0] = 0xc1;
    expect(() => decodeRealtimeFrame(encoded, "client")).toThrow();
  });

  test("refuses a data frame from another build as a mixed install", () => {
    // The data channel is reached through signaling, not through the socket
    // handshake, so it carries the same version as every other frame and
    // refuses another build's on arrival. The refusal is the shared
    // ProtocolError, so a realtime session reports the same outcome code an
    // ordinary connection would.
    const foreign = new Packr({
      useRecords: false,
      mapsAsObjects: true,
      useBigIntExtension: true,
    }).pack({ v: "0.0.1", t: "stream_end", id: "s:1" });
    try {
      decodeRealtimeFrame(foreign, "application");
      throw new Error("expected a ProtocolError");
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolError);
      expect((error as ProtocolError).code).toBe("version_mismatch");
      expect((error as ProtocolError).message).toBe(
        `this application runs AckerDB 0.0.1 and this client is ${ACKERDB_VERSION}` +
          " — install matching versions",
      );
    }
  });

  test("carries large renegotiation SDP without relaxing application event limits", () => {
    const sdp = `v=0\r\n${"a=x\r\n".repeat(8_000)}`;
    const signal = encodeRealtimeFrame({
      v: ACKERDB_VERSION,
      t: "signal_description",
      description: { type: "offer", sdp },
    });
    expect(signal.byteLength).toBeGreaterThan(REALTIME_EVENT_MAX_BYTES);
    expect(decodeRealtimeFrame(signal, "client")).toEqual({
      v: ACKERDB_VERSION,
      t: "signal_description",
      description: { type: "offer", sdp },
    });
  });
});
