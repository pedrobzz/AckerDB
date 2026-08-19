import { describe, expect, test } from "bun:test";
import { v, ValidationError, type Identity } from "@ackerdb/server";
import { makeValidator } from "../../src/validation/validator.ts";

const check = <T>(v: { parse(value: unknown, path: string): T }, value: unknown) =>
  v.parse(value, "t");

describe("scalar validators", () => {
  test("string / number / boolean / bigint / bytes accept and reject", () => {
    expect(check(v.string(), "a")).toBe("a");
    expect(() => check(v.string(), 1)).toThrow(ValidationError);
    expect(check(v.float(), 1.5)).toBe(1.5);
    expect(() => check(v.float(), NaN)).toThrow("finite");
    expect(() => check(v.float(), 1n)).toThrow(ValidationError);
    expect(check(v.boolean(), true)).toBe(true);
    expect(check(v.bigint(), 5n)).toBe(5n);
    expect(() => check(v.bigint(), 5)).toThrow(ValidationError);
    expect(() => check(v.bigint(), 2n ** 63n)).toThrow("64-bit");
    expect(check(v.bytes(), new Uint8Array([1]))).toEqual(new Uint8Array([1]));
  });

  test("identity validates as bigint and brands the type", () => {
    const id = check(v.identity(), 7n);
    const _typecheck: Identity = id;
    expect(id).toBe(7n as Identity);
    expect(() => check(v.identity(), "u1")).toThrow(ValidationError);
  });

  test("literal matches exact values including bigints", () => {
    expect(check(v.literal("image"), "image")).toBe("image");
    expect(() => check(v.literal("image"), "video")).toThrow(ValidationError);
    expect(check(v.literal(5n), 5n)).toBe(5n);
  });
});

describe("composite validators", () => {
  test("array validates elements with index in path", () => {
    const validator = v.array(v.float());
    expect(check(validator, [1, 2])).toEqual([1, 2]);
    expect(() => check(validator, [1, "x"])).toThrow("t[1]");
  });

  test("object is strict: unknown fields rejected, required enforced", () => {
    const validator = v.object({ x: v.float(), y: v.string().nullable() });
    expect(check(validator, { x: 1, y: "a" })).toEqual({ x: 1, y: "a" });
    expect(check(validator, { x: 1, y: null })).toEqual({ x: 1, y: null });
    expect(() => check(validator, { x: 1 })).toThrow("t.y");
    expect(() => check(validator, { x: 1, y: undefined })).toThrow("t.y");
    expect(() => check(validator, { x: 1, z: 2 })).toThrow('unknown field "z"');
    expect(() => check(validator, { y: "a" })).toThrow("t.x");
  });

  test("decode and encode traverse every composite child exactly once", () => {
    let parses = 0;
    let decodes = 0;
    let encodes = 0;
    const child = makeValidator("counted", {
      parse(value, path) {
        parses++;
        if (typeof value !== "string") throw new ValidationError(`${path}: expected string`);
        return value;
      },
      decode(value, path) {
        decodes++;
        return this.parse(value, path);
      },
      encode(value, path) {
        encodes++;
        return this.parse(value, path);
      },
      toJsonSchema: () => ({ type: "string" }),
      tsType: () => "string",
      descriptor: () => ({ k: "counted" }),
    });
    const validator = v.object({ items: v.array(child) });

    expect(validator.decode({ items: ["a", "b"] })).toEqual({ items: ["a", "b"] });
    expect({ parses, decodes, encodes }).toEqual({ parses: 2, decodes: 2, encodes: 0 });

    parses = 0;
    expect(validator.encode({ items: ["a", "b"] })).toEqual({ items: ["a", "b"] });
    expect({ parses, decodes, encodes }).toEqual({ parses: 2, decodes: 2, encodes: 2 });
  });

  test("nullable preserves null, rejects undefined, and is terminal", () => {
    const validator = v.float().nullable();
    expect(check(validator, null)).toBe(null);
    expect(() => check(validator, undefined)).toThrow(ValidationError);
    expect(check(validator, 3)).toBe(3);
    const redundant = validator as unknown as { nullable(): unknown };
    expect(() => redundant.nullable()).toThrow("redundant");
  });

  test("enum checks membership and keeps declaration metadata", () => {
    const role = v.enum("UserRole", ["admin", "member", "guest"]);
    expect(check(role, "admin")).toBe("admin");
    expect(() => check(role, "root")).toThrow('"admin" | "member" | "guest"');
    expect(role.name).toBe("UserRole");
    expect(role.values).toEqual(["admin", "member", "guest"]);
    expect(() => v.enum("Bad", ["a", "a"])).toThrow("duplicate");

    for (const invalid of [[], ["valid", 1], "not-an-array"]) {
      expect(() => v.enum(
        "Invalid",
        invalid as unknown as [string, ...string[]],
      )).toThrow("non-empty array of strings");
    }

    const source: ["draft", "live"] = ["draft", "live"];
    const status = v.enum("Status", source);
    source.splice(0, source.length, "live");
    const inferred: "draft" | "live" = check(status, "draft");
    expect(inferred).toBe("draft");
    expect(status.values).toEqual(["draft", "live"]);
    expect(Object.isFrozen(status.values)).toBe(true);
    expect(status.descriptor()).toEqual({
      k: "enum",
      name: "Status",
      values: ["draft", "live"],
    });
  });

  test("discriminated union validates object members", () => {
    const members = [
      v.object({ type: v.literal("text"), text: v.string() }),
      v.object({ type: v.literal("image"), url: v.string(), width: v.float() }),
      v.object({ type: v.literal("nothing") }),
    ] as const;
    const payload = v.discriminatedUnion("type", members, "MessagePayload");
    expect(check(payload, { type: "text", text: "hi" })).toEqual({ type: "text", text: "hi" });
    expect(check(payload, { type: "nothing" })).toEqual({ type: "nothing" });
    expect(() => check(payload, { type: "gif" })).toThrow("t.type");
    expect(() => check(payload, { type: "text", text: 3 })).toThrow("t.text");
    expect(() => check(payload, { type: "text", text: "x", extra: 1 })).toThrow("unknown field");
    expect(payload.members).not.toBe(members);
    expect(Object.isFrozen(payload.members)).toBe(true);
    expect(payload.codegenName).toBe("MessagePayload");
    expect(payload.tsType()).toBe("MessagePayload");
    expect(Object.hasOwn(payload.descriptor(), "name")).toBe(false);
  });

  test("jsonb accepts wire-encodable values only", () => {
    const validator = v.jsonb<{ n: bigint }>();
    expect(check(validator, { n: 1n })).toEqual({ n: 1n });
    expect(() => check(validator, { fn: () => 1 })).toThrow("wire-encodable");
    expect(() => validator.decode({ n: 1n })).toThrow("standard JSON");
    expect(() => validator.encode({ n: 1n })).toThrow("standard JSON");
  });
});

describe("tsType text", () => {
  test("emits exact TypeScript for codegen", () => {
    expect(v.string().tsType()).toBe("string");
    expect(v.float().nullable().tsType()).toBe("number | null");
    expect(v.array(v.string().nullable()).tsType()).toBe("(string | null)[]");
    expect(v.object({ a: v.bigint(), b: v.boolean() }).tsType()).toBe(
      "{ a: bigint; b: boolean }",
    );
    expect(v.enum("Role", ["a"]).tsType()).toBe("Role");
    expect(v.literal("image").tsType()).toBe('"image"');
    expect(v.literal(5n).tsType()).toBe("5n");
    expect(v.identity().tsType()).toBe("Identity");
  });
});

describe("Standard Schema contract", () => {
  const request = v.object({
    query: v.string().describe("Words to find."),
    limit: v.float().nullable().describe("Maximum results, or null for the default."),
    cursor: v.string().optional().describe("Continuation cursor."),
    replacement: v.string().nullish().describe("Optional replacement, or null to clear."),
    filters: v.jsonb<Record<string, unknown>>().describe("Opaque application filters."),
  });

  test("validates and normalizes through the dependency-free standard interface", () => {
    expect(request["~standard"]).toMatchObject({ version: 1, vendor: "ackerdb" });
    expect(request["~standard"].validate({ query: "tea", limit: null, filters: {} })).toEqual({
      value: { query: "tea", limit: null, filters: {} },
    });
    expect(request["~standard"].validate({ query: 42, filters: {} })).toEqual({
      issues: [{ message: "$input.query: expected string, got number" }],
    });
  });

  test("generates honest draft-2020-12 input and normalized output schemas", () => {
    expect(request["~standard"].jsonSchema.input({ target: "draft-2020-12" })).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        query: { type: "string", description: "Words to find." },
        limit: {
          type: ["number", "null"],
          description: "Maximum results, or null for the default.",
        },
        cursor: { type: "string", description: "Continuation cursor." },
        replacement: {
          type: ["string", "null"],
          description: "Optional replacement, or null to clear.",
        },
        filters: { description: "Opaque application filters." },
      },
      required: ["query", "limit", "filters"],
      additionalProperties: false,
    });
    expect(request["~standard"].jsonSchema.output({ target: "draft-2020-12" })).toMatchObject({
      required: ["query", "limit", "filters"],
    });
    expect(request["~standard"].jsonSchema.input({ target: "draft-07" })).toMatchObject({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
    });
    expect(() => request["~standard"].jsonSchema.input({ target: "openapi-3.0" })).toThrow(
      "draft-2020-12 and draft-07",
    );
  });

  test("descriptions are immutable guidance and opaque JSON stays unconstrained", () => {
    const plain = v.string();
    const described = plain.describe("A label.");
    expect(plain.description).toBeUndefined();
    expect(described.description).toBe("A label.");
    expect(described.descriptor()).toEqual({ k: "string" });
    expect(() => plain.describe("  ")).toThrow("non-empty");
  });

  test("keeps the native Standard Schema view distinct from Standard JSON", () => {
    expect(() => v.bigint()["~standard"].jsonSchema.input({ target: "draft-2020-12" }))
      .toThrow("$: v.bigint() requires a Standard JSON schema projection");
    expect(() => v.identity()["~standard"].jsonSchema.output({ target: "draft-2020-12" }))
      .toThrow("requires a Standard JSON schema projection");
    expect(() => v.bytes()["~standard"].jsonSchema.input({ target: "draft-2020-12" }))
      .toThrow("requires a Standard JSON schema projection");
    expect(() => v.literal(1n)["~standard"].jsonSchema.input({ target: "draft-2020-12" }))
      .toThrow("v.literal(bigint) requires a Standard JSON schema projection");
  });
});
