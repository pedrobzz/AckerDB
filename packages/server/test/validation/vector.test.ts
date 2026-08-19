import { describe, expect, test } from "bun:test";
import { v } from "@ackerdb/server";

describe("v.vector", () => {
  test("normalizes coordinates once to canonical Float32 values", () => {
    const input = [1.1, -0, 16_777_217];
    const value = v.vector(3).parse(input, "embedding");

    expect(value).toEqual([1.100000023841858, 0, 16_777_216]);
    expect(value).not.toBe(input);
    expect(Object.is(value[1], -0)).toBe(false);
  });

  test("rejects invalid dimensions, coordinates, and Float32 overflow", () => {
    for (const dimensions of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity]) {
      expect(() => v.vector(dimensions)).toThrow("positive safe integer");
    }

    const vector = v.vector(2);
    expect(() => vector.parse([1], "embedding")).toThrow("got 1 dimensions");
    expect(() => vector.parse(new Float32Array([1, 2]), "embedding"))
      .toThrow("expected a 2-dimensional vector");
    expect(() => vector.parse([NaN, 2], "embedding")).toThrow("embedding[0]");
    expect(() => vector.parse([1, Infinity], "embedding")).toThrow("embedding[1]");
    const sparse = new Array<number>(2);
    sparse[0] = 1;
    expect(() => vector.parse(sparse, "embedding")).toThrow("embedding[1]");
    expect(() => vector.parse([Number.MAX_VALUE, 2], "embedding"))
      .toThrow("overflows Float32");
  });

  test("describes one fixed-length JSON number array to Standard Schema consumers", () => {
    const vector = v.vector(3).describe("A document embedding.");

    expect(vector.dimensions).toBe(3);
    expect(vector.tsType()).toBe("readonly number[]");
    expect(vector.descriptor()).toEqual({ k: "vector", dimensions: 3 });
    expect(vector["~standard"].jsonSchema.input({ target: "draft-2020-12" })).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "array",
      items: { type: "number" },
      minItems: 3,
      maxItems: 3,
      description: "A document embedding.",
    });
  });

  test("composes inside function arrays, objects, and discriminated unions", () => {
    const args = v.object({
      batches: v.array(v.vector(2)),
      choice: v.discriminatedUnion("type", [
        v.object({ type: v.literal("dense"), value: v.vector(2) }),
        v.object({ type: v.literal("none") }),
      ]),
    });

    expect(args["~standard"].validate({
      batches: [[1.1, 2]],
      choice: { type: "dense", value: [3, 4] },
    })).toEqual({
      value: {
        batches: [[1.100000023841858, 2]],
        choice: { type: "dense", value: [3, 4] },
      },
    });
    expect(args["~standard"].jsonSchema.input({ target: "draft-2020-12" }))
      .toMatchObject({
        properties: {
          batches: {
            type: "array",
            items: { type: "array", minItems: 2, maxItems: 2 },
          },
          choice: { oneOf: expect.any(Array) },
        },
      });
  });
});
