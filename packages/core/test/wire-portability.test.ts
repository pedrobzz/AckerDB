import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as ambientWire from "@dbzz/core";

// The wire codec must run identically on every runtime: engines with the ES
// Uint8Array base64 API (Bun, modern browsers) take the native path, and
// engines without it (React Native's Hermes) take the pure-ECMAScript
// fallback. Both implementations are exercised here with the same matrix:
// the ambient module uses whatever this runtime provides, and a second,
// cache-busted copy of the module is loaded with the native API removed so
// its feature detection selects the fallback. Node `Buffer` is poisoned with
// a proxy that throws on any use, so the slightest dependence fails loudly
// rather than passing by accident on Bun.

type WireModule = Pick<
  typeof import("../src/wire.ts"),
  "encode" | "decode" | "stableEncode" | "WireError"
>;

const uint8Proto = Uint8Array.prototype as unknown as { toBase64?: unknown };
const uint8Ctor = Uint8Array as unknown as { fromBase64?: unknown };
const savedToBase64 = uint8Proto.toBase64;
const savedFromBase64 = uint8Ctor.fromBase64;
delete uint8Proto.toBase64;
delete uint8Ctor.fromBase64;
if (typeof uint8Ctor.fromBase64 !== "undefined") {
  throw new Error("could not remove the native base64 API to load the fallback");
}
let fallbackWire: WireModule;
try {
  // The query string defeats the module cache, so this copy runs feature
  // detection against the stripped Uint8Array and keeps the fallback path.
  fallbackWire = (await import(("../src/wire.ts" + "?js-fallback") as string)) as WireModule;
} finally {
  uint8Proto.toBase64 = savedToBase64;
  uint8Ctor.fromBase64 = savedFromBase64;
}

test("this runtime exercises the native base64 path", () => {
  // If Bun ever drops the API this turns the silent double-testing of the
  // fallback into an explicit failure to re-evaluate.
  expect(typeof Uint8Array.fromBase64).toBe("function");
});

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

const implementations: readonly (readonly [string, WireModule])[] = [
  ["native base64 API", ambientWire],
  ["pure ECMAScript fallback", fallbackWire],
];

for (const [label, wire] of implementations) {
  const { encode, decode, stableEncode, WireError } = wire;
  const roundtrip = (value: unknown) => decode(encode(value));

  describe(`wire codec via ${label}, without Node Buffer`, () => {
    const realBuffer = globalThis.Buffer;

    beforeEach(() => {
      (globalThis as Record<string, unknown>)["Buffer"] = poisonedBuffer();
    });

    afterEach(() => {
      globalThis.Buffer = realBuffer;
    });

    test("bytes round-trip", () => {
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

    test("large byte payloads round-trip at every length remainder", () => {
      for (const length of [3 * 1000, 3 * 1000 + 1, 3 * 1000 + 2, 65_536]) {
        const bytes = new Uint8Array(length);
        for (let i = 0; i < length; i++) bytes[i] = (i * 7 + (i >> 3)) & 0xff;
        expect(roundtrip(bytes)).toEqual(bytes);
      }
    });

    test("byte views honor their offset and length", () => {
      const backing = new Uint8Array([9, 9, 1, 2, 3, 9]);
      const view = new Uint8Array(backing.buffer, 2, 3);
      expect(roundtrip(view)).toEqual(new Uint8Array([1, 2, 3]));
    });

    test("mixed structures round-trip, including stableEncode", () => {
      const value = {
        id: 7n,
        blob: new Uint8Array([4, 5, 6]),
        inner: { list: [new Uint8Array([7])], text: "hi" },
      };
      expect(roundtrip(value)).toEqual(value);
      expect(decode(stableEncode(value))).toEqual(value);
    });

    test("malformed base64 is rejected", () => {
      const wireText = (v: unknown) => JSON.stringify({ $: "x", v });
      expect(() => decode(wireText("AQI"))).toThrow(WireError); // not a 4-char group
      expect(() => decode(wireText("AQ=!"))).toThrow(WireError); // invalid character
      expect(() => decode(wireText("AQ ="))).toThrow(WireError); // whitespace
      expect(() => decode(wireText("AQID\n\n\n\n"))).toThrow(WireError); // 4-aligned whitespace
      expect(() => decode(wireText("A==="))).toThrow(WireError); // over-padded group
      expect(() => decode(wireText("=AAA"))).toThrow(WireError); // pad inside data
      expect(() => decode(wireText("AAAAÿÿÿÿ"))).toThrow(WireError); // non-ASCII
      expect(() => decode(wireText("AR=="))).toThrow(WireError); // non-canonical bits, 2-char tail
      expect(() => decode(wireText("AAB="))).toThrow(WireError); // non-canonical bits, 3-char tail
      expect(() => decode(wireText(42))).toThrow(WireError); // non-string payload
    });
  });

  describe(`wire base64 via ${label} matches the reference encoding`, () => {
    test("encoding equals Buffer's base64 for exhaustive short and random long inputs", () => {
      const expected = (bytes: Uint8Array) =>
        JSON.stringify({ $: "x", v: Buffer.from(bytes).toString("base64") });
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
      const wireText = JSON.stringify({ $: "x", v: Buffer.from(bytes).toString("base64") });
      expect(decode(wireText)).toEqual(bytes);
    });
  });
}

describe("native and fallback implementations agree", () => {
  test("byte-identical encodings across implementations", () => {
    for (const length of [0, 1, 2, 3, 31, 256, 4_097]) {
      const bytes = new Uint8Array(length);
      crypto.getRandomValues(bytes);
      expect(ambientWire.encode(bytes)).toBe(fallbackWire.encode(bytes));
      expect(fallbackWire.decode(ambientWire.encode(bytes))).toEqual(bytes);
    }
  });
});
