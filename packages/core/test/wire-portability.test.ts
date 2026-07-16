import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { decode, encode, stableEncode, WireError } from "@dbzz/core";

// The wire codec must run identically on runtimes without Node globals
// (browsers, React Native's Hermes). These tests poison `Buffer` with a proxy
// that throws on any use — construction, `Buffer.from`, any property — so the
// slightest dependence fails loudly rather than passing by accident on Bun.

const roundtrip = (value: unknown) => decode(encode(value));

function poisonedBuffer(): unknown {
  const explode = (): never => {
    throw new Error("wire codec touched Node Buffer");
  };
  return new Proxy(function () {}, {
    apply: explode,
    construct: explode,
    get: explode,
    has: explode,
  });
}

describe("wire codec without Node Buffer", () => {
  const realBuffer = globalThis.Buffer;

  beforeEach(() => {
    (globalThis as Record<string, unknown>)["Buffer"] = poisonedBuffer();
  });

  afterEach(() => {
    globalThis.Buffer = realBuffer;
  });

  test("bytes round-trip with Buffer poisoned", () => {
    const cases = [
      new Uint8Array(0),
      new Uint8Array([0]),
      new Uint8Array([0, 1]),
      new Uint8Array([0, 1, 2]),
      new Uint8Array([0, 1, 2, 255, 128]),
      new Uint8Array(Array.from({ length: 256 }, (_, i) => i)),
    ];
    for (const bytes of cases) expect(roundtrip(bytes)).toEqual(bytes);
  });

  test("large random byte payloads round-trip with Buffer poisoned", () => {
    for (const length of [3 * 1000, 3 * 1000 + 1, 3 * 1000 + 2, 65_536]) {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i++) bytes[i] = (i * 7 + (i >> 3)) & 0xff;
      expect(roundtrip(bytes)).toEqual(bytes);
    }
  });

  test("byte views honor their offset and length with Buffer poisoned", () => {
    const backing = new Uint8Array([9, 9, 1, 2, 3, 9]);
    const view = new Uint8Array(backing.buffer, 2, 3);
    expect(roundtrip(view)).toEqual(new Uint8Array([1, 2, 3]));
  });

  test("mixed structures round-trip with Buffer poisoned", () => {
    const value = {
      id: 7n,
      blob: new Uint8Array([4, 5, 6]),
      inner: { list: [new Uint8Array([7])], text: "hi" },
    };
    expect(roundtrip(value)).toEqual(value);
    expect(decode(stableEncode(value))).toEqual(value);
  });

  test("malformed base64 is rejected with Buffer poisoned", () => {
    const wire = (v: unknown) => JSON.stringify({ $: "x", v });
    expect(() => decode(wire("AQI"))).toThrow(WireError); // not a 4-char group
    expect(() => decode(wire("AQ=!"))).toThrow(WireError); // invalid character
    expect(() => decode(wire("AQ ="))).toThrow(WireError); // whitespace
    expect(() => decode(wire("A==="))).toThrow(WireError); // over-padded group
    expect(() => decode(wire("=AAA"))).toThrow(WireError); // pad inside data
    expect(() => decode(wire("AAAAÿÿÿÿ"))).toThrow(WireError); // non-ASCII
    expect(() => decode(wire(42))).toThrow(WireError); // non-string payload
  });
});

describe("wire base64 matches the reference encoding", () => {
  test("encoding equals Buffer's base64 for exhaustive short and random long inputs", () => {
    const expected = (bytes: Uint8Array) => JSON.stringify({ $: "x", v: Buffer.from(bytes).toString("base64") });
    for (let length = 0; length <= 8; length++) {
      const bytes = new Uint8Array(Array.from({ length }, (_, i) => (i * 31 + 5) & 0xff));
      expect(encode(bytes)).toBe(expected(bytes));
    }
    for (const length of [255, 256, 257, 10_000]) {
      const bytes = new Uint8Array(length);
      crypto.getRandomValues(bytes);
      expect(encode(bytes)).toBe(expected(bytes));
    }
  });

  test("decoding accepts Buffer-produced padded base64", () => {
    const bytes = new Uint8Array([250, 251, 252, 253, 254, 255, 0]);
    const wire = JSON.stringify({ $: "x", v: Buffer.from(bytes).toString("base64") });
    expect(decode(wire)).toEqual(bytes);
  });
});
