import { describe, expect, test } from "bun:test";
import { ACKERDB_VERSION } from "@ackerdb/core";
import { SseEventDecoder } from "../../src/sse/event-decoder.ts";

const utf8 = new TextEncoder();
// The frames are literal SSE bytes, so the version appears in them quoted.
const version = JSON.stringify(ACKERDB_VERSION);
const chunk = (seq: number): string =>
  `data: {"v":${version},"t":"sse_chunk","seq":${seq},"proof":"p","value":${seq}}`;

describe("SseEventDecoder", () => {
  test("decodes fragmented LF, CRLF, and bare-CR event boundaries", () => {
    const decoder = new SseEventDecoder(1_024);
    expect(decoder.push(utf8.encode(`\uFEFF${chunk(1)}\n`))).toEqual([]);
    expect(decoder.push(utf8.encode(`\n${chunk(2)}\r\n\r`))).toEqual([
      { v: ACKERDB_VERSION, t: "sse_chunk", seq: 1, proof: "p", value: 1 },
    ]);
    expect(decoder.push(utf8.encode(`\n${chunk(3)}\r\r`))).toEqual([
      { v: ACKERDB_VERSION, t: "sse_chunk", seq: 2, proof: "p", value: 2 },
    ]);
    expect(decoder.push(utf8.encode("\n"))).toEqual([
      { v: ACKERDB_VERSION, t: "sse_chunk", seq: 3, proof: "p", value: 3 },
    ]);
    expect(decoder.hasPendingEvent).toBe(false);
  });

  test("bounds the unfinished event by transport bytes", () => {
    const decoder = new SseEventDecoder(8);
    expect(() => decoder.push(utf8.encode("data: 123"))).toThrow(
      "SSE input exceeds the client buffer limit",
    );
  });

  test("reports an unfinished final event", () => {
    const decoder = new SseEventDecoder(1_024);
    decoder.push(utf8.encode(chunk(1)));
    expect(decoder.finish()).toEqual([]);
    expect(decoder.hasPendingEvent).toBe(true);
  });
});
