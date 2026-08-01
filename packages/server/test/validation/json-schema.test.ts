import { describe, expect, test } from "bun:test";
import { v } from "@ackerdb/server";
import { argsJsonSchema, validatorJsonSchema } from "../../src/validation/json-schema.ts";

const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";
const DECIMAL_PATTERN = "^(?:0|-?[1-9][0-9]*)$";
const BASE64_PATTERN = "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$";

describe("args schemas", () => {
  test("emits one draft-2020-12 object document from a shape", () => {
    expect(argsJsonSchema({
      channel: v.string().min(1).max(64).describe("The channel to read."),
      limit: v.int().max(100),
      cursor: v.string().optional(),
    })).toEqual({
      $schema: DRAFT_2020_12,
      type: "object",
      properties: {
        channel: {
          type: "string",
          minLength: 1,
          maxLength: 64,
          description: "The channel to read.",
        },
        limit: {
          type: "integer",
          minimum: Number.MIN_SAFE_INTEGER,
          maximum: 100,
        },
        cursor: { type: "string" },
      },
      required: ["channel", "limit"],
      additionalProperties: false,
    });
  });

  test("omits `required` entirely when every argument is omissible", () => {
    const schema = argsJsonSchema({ cursor: v.string().optional() });

    expect(schema).not.toHaveProperty("required");
    expect(schema.additionalProperties).toBe(false);
  });

  test("keeps prototype-named arguments as own properties", () => {
    const properties = argsJsonSchema({ ["__proto__"]: v.string() }).properties;

    expect(Object.getPrototypeOf(properties)).toBeNull();
    expect(Object.hasOwn(properties, "__proto__")).toBe(true);
  });

  test("agrees with the same shape compiled into an object validator", () => {
    const shape = { body: v.string(), tags: v.array(v.string()).optional() };

    expect(argsJsonSchema(shape)).toEqual(validatorJsonSchema(v.object(shape)));
  });
});

describe("validator schemas", () => {
  test("nests objects, arrays, and their constraints", () => {
    expect(validatorJsonSchema(v.object({
      author: v.object({ name: v.string(), verified: v.boolean() }),
      lines: v.array(v.string().regex(/^[a-z]+$/)).min(1).max(10),
    }))).toEqual({
      $schema: DRAFT_2020_12,
      type: "object",
      properties: {
        author: {
          type: "object",
          properties: { name: { type: "string" }, verified: { type: "boolean" } },
          required: ["name", "verified"],
          additionalProperties: false,
        },
        lines: {
          type: "array",
          items: { type: "string", pattern: "^[a-z]+$" },
          minItems: 1,
          maxItems: 10,
        },
      },
      required: ["author", "lines"],
      additionalProperties: false,
    });
  });

  test("emits one oneOf branch per union member, tags included", () => {
    const payload = v.union("Payload", {
      text: v.string(),
      count: v.int().optional(),
      none: v.tag(),
    });

    expect(validatorJsonSchema(payload)).toEqual({
      $schema: DRAFT_2020_12,
      oneOf: [
        {
          type: "object",
          properties: { tag: { const: "text" }, value: { type: "string" } },
          required: ["tag", "value"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            tag: { const: "count" },
            value: {
              type: "integer",
              minimum: Number.MIN_SAFE_INTEGER,
              maximum: Number.MAX_SAFE_INTEGER,
            },
          },
          required: ["tag"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: { tag: { const: "none" }, value: { type: "null" } },
          required: ["tag"],
          additionalProperties: false,
        },
      ],
    });
  });

  test("requires the payload-less variant's null value on the way out", () => {
    const schema = validatorJsonSchema(
      v.union("Payload", { none: v.tag() }),
      { mode: "output" },
    ) as { readonly oneOf: readonly { readonly required: readonly string[] }[] };

    expect(schema.oneOf[0]!.required).toEqual(["tag", "value"]);
  });

  test("describes enums and literals as constrained strings", () => {
    expect(validatorJsonSchema(v.enum("Role", ["admin", "member"])))
      .toEqual({ $schema: DRAFT_2020_12, type: "string", enum: ["admin", "member"] });
    expect(validatorJsonSchema(v.literal("ready")))
      .toEqual({ $schema: DRAFT_2020_12, const: "ready" });
    expect(validatorJsonSchema(v.literal(7)))
      .toEqual({ $schema: DRAFT_2020_12, const: 7 });
    expect(validatorJsonSchema(v.literal(true)))
      .toEqual({ $schema: DRAFT_2020_12, const: true });
  });

  test("emits a fixed-length number array for a vector", () => {
    expect(validatorJsonSchema(v.vector(3))).toEqual({
      $schema: DRAFT_2020_12,
      type: "array",
      items: { type: "number" },
      minItems: 3,
      maxItems: 3,
    });
  });

  test("leaves opaque JSON unconstrained", () => {
    expect(validatorJsonSchema(v.jsonb<Record<string, unknown>>().describe("Filters.")))
      .toEqual({ $schema: DRAFT_2020_12, description: "Filters." });
  });

  test("every call owns a fresh graph consumers may normalize in place", () => {
    const validator = v.object({ body: v.string() });
    const first = validatorJsonSchema(validator);

    expect(first).not.toBe(validatorJsonSchema(validator));
    expect(Object.isFrozen(first)).toBe(false);
  });
});

describe("optional, nullable, and nullish", () => {
  test("widens the inner type keyword instead of wrapping it in anyOf", () => {
    expect(validatorJsonSchema(v.string().nullable()))
      .toEqual({ $schema: DRAFT_2020_12, type: ["string", "null"] });
    expect(validatorJsonSchema(v.string().nullish()))
      .toEqual({ $schema: DRAFT_2020_12, type: ["string", "null"] });
    expect(validatorJsonSchema(v.string().optional()))
      .toEqual({ $schema: DRAFT_2020_12, type: "string" });
  });

  test("keeps the union form when widening `type` would change meaning", () => {
    expect(validatorJsonSchema(v.enum("Role", ["admin"]).nullable())).toEqual({
      $schema: DRAFT_2020_12,
      anyOf: [{ type: "string", enum: ["admin"] }, { type: "null" }],
    });
    expect(validatorJsonSchema(v.literal("ready").nullable())).toEqual({
      $schema: DRAFT_2020_12,
      anyOf: [{ const: "ready" }, { type: "null" }],
    });
  });

  test("separates omissible fields from present-but-null ones", () => {
    expect(argsJsonSchema({
      required: v.string(),
      nullable: v.string().nullable(),
      optional: v.string().optional(),
      nullish: v.string().nullish(),
    }).required).toEqual(["required", "nullable"]);
  });
});

describe("standard-JSON protocol constraints", () => {
  test("maps bigint and Identity to the canonical decimal string", () => {
    for (const validator of [v.bigint(), v.identity()]) {
      expect(validatorJsonSchema(validator))
        .toEqual({ $schema: DRAFT_2020_12, type: ["integer", "string"], pattern: DECIMAL_PATTERN });
      expect(validatorJsonSchema(validator, { mode: "output" }))
        .toEqual({ $schema: DRAFT_2020_12, type: "string", pattern: DECIMAL_PATTERN });
    }
    expect(validatorJsonSchema(v.literal(7n)))
      .toEqual({ $schema: DRAFT_2020_12, const: "7" });
  });

  test("documents bigint bounds as prose instead of numeric keywords", () => {
    const schema = validatorJsonSchema(v.bigint().min(-5n).max(10n).describe("A counter."));

    expect(schema).toEqual({
      $schema: DRAFT_2020_12,
      type: ["integer", "string"],
      pattern: DECIMAL_PATTERN,
      description:
        "A counter. Minimum bigint value (inclusive): -5. Maximum bigint value (inclusive): 10.",
    });
  });

  test("maps bytes to canonical base64", () => {
    expect(validatorJsonSchema(v.bytes())).toEqual({
      $schema: DRAFT_2020_12,
      type: "string",
      pattern: BASE64_PATTERN,
      contentEncoding: "base64",
    });
    expect(validatorJsonSchema(v.bytes().nullable())).toEqual({
      $schema: DRAFT_2020_12,
      type: ["string", "null"],
      pattern: BASE64_PATTERN,
      contentEncoding: "base64",
    });
  });

  test("refuses the lossless kinds when no protocol codec carries them", () => {
    const plain = { protocol: false } as const;

    expect(() => validatorJsonSchema(v.bigint(), plain))
      .toThrow("$: v.bigint() requires a standard-JSON protocol codec");
    expect(() => validatorJsonSchema(v.identity(), plain))
      .toThrow("requires a standard-JSON protocol codec");
    expect(() => validatorJsonSchema(v.bytes(), plain))
      .toThrow("requires a standard-JSON protocol codec");
    expect(() => validatorJsonSchema(v.literal(1n), plain))
      .toThrow("v.literal(bigint) requires a standard-JSON protocol codec");
  });
});

describe("targets and refusals", () => {
  test("defaults to draft 2020-12 and supports draft-07 explicitly", () => {
    expect(validatorJsonSchema(v.string(), { target: "draft-07" })).toEqual({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "string",
    });
    expect(() => validatorJsonSchema(v.string(), { target: "openapi-3.0" }))
      .toThrow("draft-2020-12 and draft-07");
  });

  test("names the path of every kind no JSON boundary can carry", () => {
    expect(() => argsJsonSchema({ value: v.array(v.primaryKey()) }))
      .toThrow("$.value[]: v.primaryKey() is not a standard-JSON value");
    expect(() => argsJsonSchema({ value: v.scheduleAt() }))
      .toThrow("$.value: v.scheduleAt() is not a standard-JSON value");
    expect(() => argsJsonSchema({ value: v.array(v.tag()) }))
      .toThrow("$.value[]: v.tag() is valid only as a direct v.union() member");
    expect(() => validatorJsonSchema({ ...v.string(), kind: "custom" } as never))
      .toThrow("$: v.custom() has no lossless standard-JSON protocol representation");
  });

  test("refuses contradictory validator shapes at the emitting node", () => {
    expect(() => argsJsonSchema({ value: { ...v.string(), kind: "array" } as never }))
      .toThrow("$.value: v.array() has no element validator");
    expect(() => argsJsonSchema({ value: { ...v.string(), kind: "nullable" } as never }))
      .toThrow("$.value: .nullable() has no inner validator");
    expect(() => argsJsonSchema({ value: { ...v.string(), kind: "enum", values: [1] } as never }))
      .toThrow("$.value: v.enum() has invalid string values");
    expect(() => argsJsonSchema({ value: { ...v.string(), kind: "union" } as never }))
      .toThrow("$.value: v.union() has invalid members");
    expect(() => argsJsonSchema(null as never))
      .toThrow("$: an object shape must be a plain object of validators");
  });
});
