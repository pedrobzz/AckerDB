import { describe, expect, test } from "bun:test";
import {
  REALTIME_EVENT_MAX_BYTES,
  REALTIME_PROTOCOL_VERSION,
  REALTIME_STREAM_CHUNK_MAX_BYTES,
  RealtimeEventTooLargeError,
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
    const decoded = decodeRealtimeFrame(encoded);
    expect(decoded).toEqual({
      v: REALTIME_PROTOCOL_VERSION,
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
      v: REALTIME_PROTOCOL_VERSION,
      t: "stream_open",
      id: "c:1",
      stream: "camera.snapshot",
      metadata: { contentType: "image/jpeg" },
      size: 3,
    });
    const chunk = encodeRealtimeFrame({
      v: REALTIME_PROTOCOL_VERSION,
      t: "stream_chunk",
      id: "c:1",
      chunk: new Uint8Array([1, 2, 3]),
    });
    const end = encodeRealtimeFrame({
      v: REALTIME_PROTOCOL_VERSION,
      t: "stream_end",
      id: "c:1",
    });
    expect(decodeRealtimeFrame(open)).toMatchObject({
      t: "stream_open",
      id: "c:1",
      size: 3,
    });
    expect(decodeRealtimeFrame(chunk)).toMatchObject({
      t: "stream_chunk",
      id: "c:1",
      chunk: new Uint8Array([1, 2, 3]),
    });
    expect(decodeRealtimeFrame(end)).toEqual({
      v: REALTIME_PROTOCOL_VERSION,
      t: "stream_end",
      id: "c:1",
    });
  });

  test("enforces atomic event and bounded stream-chunk limits", () => {
    expect(() => encodeRealtimeEvent("large", {
      bytes: new Uint8Array(REALTIME_EVENT_MAX_BYTES),
    })).toThrow(RealtimeEventTooLargeError);
    expect(() => encodeRealtimeFrame({
      v: REALTIME_PROTOCOL_VERSION,
      t: "stream_chunk",
      id: "c:1",
      chunk: new Uint8Array(REALTIME_STREAM_CHUNK_MAX_BYTES + 1),
    })).toThrow("maximum");
  });

  test("rejects malformed, non-exact, and unsupported frames", () => {
    expect(() => decodeRealtimeFrame(new Uint8Array())).toThrow(
      RealtimeProtocolError,
    );
    expect(() => decodeRealtimeFrame(new Uint8Array([0xd9]))).toThrow(
      "malformed MessagePack",
    );
    const encoded = encodeRealtimeFrame({
      v: REALTIME_PROTOCOL_VERSION,
      t: "stream_end",
      id: "c:1",
    });
    encoded[0] = 0xc1;
    expect(() => decodeRealtimeFrame(encoded)).toThrow();
  });

  test("carries large renegotiation SDP without relaxing application event limits", () => {
    const sdp = `v=0\r\n${"a=x\r\n".repeat(8_000)}`;
    const signal = encodeRealtimeFrame({
      v: REALTIME_PROTOCOL_VERSION,
      t: "signal_description",
      description: { type: "offer", sdp },
    });
    expect(signal.byteLength).toBeGreaterThan(REALTIME_EVENT_MAX_BYTES);
    expect(decodeRealtimeFrame(signal)).toEqual({
      v: REALTIME_PROTOCOL_VERSION,
      t: "signal_description",
      description: { type: "offer", sdp },
    });
  });
});
