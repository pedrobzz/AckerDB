import { describe, expect, test } from "bun:test";
import {
  ACKERDB_VERSION,
  decodeSseEvent,
  encodeSseChunk,
  encodeSseControl,
} from "../src/index.ts";

const text = new TextDecoder();
// The envelope is literal JSON, so the version appears in it quoted.
const version = JSON.stringify(ACKERDB_VERSION);

describe("SSE framing", () => {
  test("owns the exact exposed-JSON chunk envelope", () => {
    expect(text.decode(encodeSseChunk(7, "proof", { $: "ordinary", n: 1 }))).toBe(
      `data: {"v":${version},"t":"sse_chunk","seq":7,"proof":"proof","value":{"$":"ordinary","n":1}}\n\n`,
    );
  });

  test("round-trips terminal control and message events", () => {
    const done = { v: ACKERDB_VERSION, t: "sse_done" as const, seq: 2, proof: "p" };
    expect(text.decode(encodeSseControl(done))).toBe(
      `data: {"v":${version},"t":"sse_done","seq":2,"proof":"p"}\n\n`,
    );
    expect(
      decodeSseEvent(
        `{"v":${version},"t":"sse_chunk","seq":1,"proof":"p","value":{"$":"ordinary"}}`,
        undefined,
      ),
    ).toEqual({
      v: ACKERDB_VERSION,
      t: "sse_chunk",
      seq: 1,
      proof: "p",
      value: { $: "ordinary" },
    });
  });

  test("rejects named events outside the AckerDB stream contract", () => {
    expect(() => decodeSseEvent("{}", "other")).toThrow("unknown SSE event type");
  });
});
