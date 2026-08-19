import { describe, expect, test } from "bun:test";
import { v } from "@ackerdb/server";
import { validatorJsonSchema } from "../../src/validation/json-schema.ts";

const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";
const DECIMAL_PATTERN = "^(?:0|-?[1-9][0-9]*)$";
const BASE64_PATTERN = "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$";

describe("args schemas", () => {
  test("emits one draft-2020-12 object document from a shape", () => {
    expect(validatorJsonSchema(v.object({
      channel: v.string().min(1).max(64).describe("The channel to read."),
      limit: v.int().max(100),
      cursor: v.string().optional(),
    }))).toEqual({
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
    const schema = validatorJsonSchema(v.object({ cursor: v.string().optional() }));

    expect(schema).not.toHaveProperty("required");
    expect(schema.additionalProperties).toBe(false);
  });

  test("keeps prototype-named arguments as own properties", () => {
    const properties = validatorJsonSchema(v.object({ ["__proto__"]: v.string() })).properties;

    expect(Object.getPrototypeOf(properties)).toBeNull();
    expect(Object.hasOwn(properties, "__proto__")).toBe(true);
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

  test("emits one object schema per discriminated union member", () => {
    const payload = v.discriminatedUnion("type", [
      v.object({ type: v.literal("text"), value: v.string() }),
      v.object({ type: v.literal("count"), value: v.int().optional() }),
      v.object({ type: v.literal("none") }),
    ]);

    expect(validatorJsonSchema(payload)).toEqual({
      $schema: DRAFT_2020_12,
      oneOf: [
        {
          type: "object",
          properties: { type: { const: "text" }, value: { type: "string" } },
          required: ["type", "value"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            type: { const: "count" },
            value: {
              type: "integer",
              minimum: Number.MIN_SAFE_INTEGER,
              maximum: Number.MAX_SAFE_INTEGER,
            },
          },
          required: ["type"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: { type: { const: "none" } },
          required: ["type"],
          additionalProperties: false,
        },
      ],
    });
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

  test("every call owns a fresh graph consumers may normalize in place", () => {
    const validator = v.object({ body: v.string() });
    const first = validatorJsonSchema(validator);

    expect(validator.toJsonSchema()).toEqual({
      type: "object",
      properties: { body: { type: "string" } },
      required: ["body"],
      additionalProperties: false,
    });
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
    expect(validatorJsonSchema(v.object({
      required: v.string(),
      nullable: v.string().nullable(),
      optional: v.string().optional(),
      nullish: v.string().nullish(),
    })).required).toEqual(["required", "nullable"]);
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
});

describe("targets and validator-owned refusals", () => {
  test("defaults to draft 2020-12 and supports draft-07 explicitly", () => {
    expect(validatorJsonSchema(v.string(), { target: "draft-07" })).toEqual({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "string",
    });
    expect(() => validatorJsonSchema(v.string(), { target: "openapi-3.0" }))
      .toThrow("draft-2020-12 and draft-07");
  });

  test("lets primary keys and schedule timestamps own ordinary JSON representations", () => {
    expect(validatorJsonSchema(v.object({ id: v.primaryKey(), at: v.scheduleAt() })))
      .toEqual({
        $schema: DRAFT_2020_12,
        type: "object",
        properties: {
          id: { type: ["integer", "string"], pattern: DECIMAL_PATTERN },
          at: { type: "number" },
        },
        required: ["id", "at"],
        additionalProperties: false,
      });
  });

  test("uses the validator's behavior instead of reinterpreting its kind metadata", () => {
    const renamed = { ...v.string(), kind: "custom" };
    expect(validatorJsonSchema(renamed as typeof renamed & ReturnType<typeof v.string>)).toEqual({
      $schema: DRAFT_2020_12,
      type: "string",
    });
  });

  test("keeps an unsupported JSON value local to the validator that declares it", () => {
    const impossible = v.literal(Number.POSITIVE_INFINITY);
    expect(() => impossible.encode(Number.POSITIVE_INFINITY))
      .toThrow("v.literal(Infinity) has no Standard JSON value");
    expect(() => validatorJsonSchema(v.object({ value: impossible })))
      .toThrow("$.value: v.literal(Infinity) has no Standard JSON value");
  });
});
