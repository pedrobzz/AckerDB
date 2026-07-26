import { describe, expect, test } from "bun:test";
import { decode, encode, stableEncode, WireError } from "@ackerdb/core";

const roundtrip = (value: unknown) => decode(encode(value));

describe("wire codec", () => {
  test("primitives round-trip", () => {
    expect(roundtrip(null)).toBe(null);
    expect(roundtrip(true)).toBe(true);
    expect(roundtrip(false)).toBe(false);
    expect(roundtrip(42.5)).toBe(42.5);
    expect(roundtrip(-0)).toBe(0);
    expect(roundtrip("hello")).toBe("hello");
    expect(roundtrip("")).toBe("");
  });

  test("bigints round-trip, including beyond MAX_SAFE_INTEGER", () => {
    expect(roundtrip(0n)).toBe(0n);
    expect(roundtrip(-1n)).toBe(-1n);
    expect(roundtrip(9007199254740993n)).toBe(9007199254740993n);
    expect(roundtrip(-(2n ** 63n))).toBe(-(2n ** 63n));
  });

  test("bytes round-trip", () => {
    const bytes = new Uint8Array([0, 1, 2, 255, 128]);
    expect(roundtrip(bytes)).toEqual(bytes);
    expect(roundtrip(new Uint8Array(0))).toEqual(new Uint8Array(0));
  });

  test("nested structures round-trip", () => {
    const value = {
      id: 7n,
      tags: ["a", "b"],
      inner: { list: [{ n: 1n }, { n: 2n }], blob: new Uint8Array([9]) },
      nil: null,
    };
    expect(roundtrip(value)).toEqual(value);
  });

  test("objects with a literal $ key are escaped, at any depth", () => {
    const value = { $: "b", v: "not a bigint" };
    expect(roundtrip(value)).toEqual(value);
    const nested = { deep: [{ $: "x", other: 1 }] };
    expect(roundtrip(nested)).toEqual(nested);
    // and does not collide with a real bigint next to it
    expect(roundtrip({ $: "o", n: 5n })).toEqual({ $: "o", n: 5n });
  });

  test("undefined object fields are dropped", () => {
    expect(roundtrip({ a: 1, b: undefined })).toEqual({ a: 1 });
  });

  test("undefined array elements become null", () => {
    expect(roundtrip([1, undefined, 3])).toEqual([1, null, 3]);
  });

  test("top-level undefined encodes as null", () => {
    expect(encode(undefined)).toBe("null");
  });

  test("non-finite numbers are rejected", () => {
    expect(() => encode(NaN)).toThrow(WireError);
    expect(() => encode(Infinity)).toThrow(WireError);
    expect(() => encode({ x: -Infinity })).toThrow(WireError);
  });

  test("functions and symbols are rejected", () => {
    expect(() => encode(() => 1)).toThrow(WireError);
    expect(() => encode(Symbol("nope"))).toThrow(WireError);
  });
});

describe("stableEncode", () => {
  test("is insensitive to key insertion order, deeply", () => {
    const a = { x: 1, y: { b: 2n, a: [{ q: 1, p: 2 }] } };
    const b = { y: { a: [{ p: 2, q: 1 }], b: 2n }, x: 1 };
    expect(stableEncode(a)).toBe(stableEncode(b));
    expect(stableEncode(a)).not.toBe(stableEncode({ ...a, x: 2 }));
  });

  test("stable output still decodes to the same value", () => {
    const value = { z: 1n, a: new Uint8Array([1, 2]), m: { k: null } };
    expect(decode(stableEncode(value))).toEqual(value);
  });
});
