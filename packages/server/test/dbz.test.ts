import { describe, expect, test } from "bun:test";
import { dbz, ValidationError, type Identity } from "@dbzz/server";

const check = <T>(v: { check(value: unknown, path: string): T }, value: unknown) =>
  v.check(value, "t");

describe("scalar validators", () => {
  test("string / number / boolean / bigint / bytes accept and reject", () => {
    expect(check(dbz.string(), "a")).toBe("a");
    expect(() => check(dbz.string(), 1)).toThrow(ValidationError);
    expect(check(dbz.number(), 1.5)).toBe(1.5);
    expect(() => check(dbz.number(), NaN)).toThrow("finite");
    expect(() => check(dbz.number(), 1n)).toThrow(ValidationError);
    expect(check(dbz.boolean(), true)).toBe(true);
    expect(check(dbz.bigint(), 5n)).toBe(5n);
    expect(() => check(dbz.bigint(), 5)).toThrow(ValidationError);
    expect(() => check(dbz.bigint(), 2n ** 63n)).toThrow("64-bit");
    expect(check(dbz.bytes(), new Uint8Array([1]))).toEqual(new Uint8Array([1]));
  });

  test("identity validates as bigint and brands the type", () => {
    const id = check(dbz.identity(), 7n);
    const _typecheck: Identity = id;
    expect(id).toBe(7n as Identity);
    expect(() => check(dbz.identity(), "u1")).toThrow(ValidationError);
  });

  test("literal matches exact values including bigints", () => {
    expect(check(dbz.literal("image"), "image")).toBe("image");
    expect(() => check(dbz.literal("image"), "video")).toThrow(ValidationError);
    expect(check(dbz.literal(5n), 5n)).toBe(5n);
  });
});

describe("composite validators", () => {
  test("array validates elements with index in path", () => {
    const v = dbz.array(dbz.number());
    expect(check(v, [1, 2])).toEqual([1, 2]);
    expect(() => check(v, [1, "x"])).toThrow("t[1]");
  });

  test("object is strict: unknown fields rejected, required enforced", () => {
    const v = dbz.object({ x: dbz.number(), y: dbz.nullable(dbz.string()) });
    expect(check(v, { x: 1, y: "a" })).toEqual({ x: 1, y: "a" });
    expect(check(v, { x: 1 })).toEqual({ x: 1, y: null });
    expect(check(v, { x: 1, y: undefined })).toEqual({ x: 1, y: null });
    expect(() => check(v, { x: 1, z: 2 })).toThrow('unknown field "z"');
    expect(() => check(v, { y: "a" })).toThrow("t.x");
  });

  test("nullable normalizes undefined to null and rejects silly nesting", () => {
    const v = dbz.nullable(dbz.number());
    expect(check(v, null)).toBe(null);
    expect(check(v, undefined)).toBe(null);
    expect(check(v, 3)).toBe(3);
    expect(() => dbz.nullable(dbz.nullable(dbz.number()))).toThrow("redundant");
    expect(() => dbz.nullable(dbz.primaryKey())).toThrow(ValidationError);
  });

  test("enum checks membership and keeps declaration metadata", () => {
    const role = dbz.enum("UserRole", ["admin", "member", "guest"]);
    expect(check(role, "admin")).toBe("admin");
    expect(() => check(role, "root")).toThrow('"admin" | "member" | "guest"');
    expect(role.name).toBe("UserRole");
    expect(role.values).toEqual(["admin", "member", "guest"]);
    expect(() => dbz.enum("Bad", ["a", "a"])).toThrow("duplicate");
  });

  test("union validates tagged values and exposes constructors", () => {
    const payload = dbz.union("MessagePayload", {
      text: dbz.string(),
      image: dbz.object({ url: dbz.string(), width: dbz.number() }),
      nothing: dbz.tag(),
    });
    expect(payload.union.text("hi")).toEqual({ tag: "text", value: "hi" });
    expect(payload.union.nothing()).toEqual({ tag: "nothing", value: null });
    expect(check(payload, { tag: "text", value: "hi" })).toEqual({ tag: "text", value: "hi" });
    expect(check(payload, { tag: "nothing", value: null })).toEqual({ tag: "nothing", value: null });
    expect(() => check(payload, { tag: "gif", value: 1 })).toThrow("t.tag");
    expect(() => check(payload, { tag: "text", value: 3 })).toThrow("t.value");
    expect(() => check(payload, { tag: "text", value: "x", extra: 1 })).toThrow("unknown field");
  });

  test("jsonb accepts wire-encodable values only", () => {
    const v = dbz.jsonb<{ n: bigint }>();
    expect(check(v, { n: 1n })).toEqual({ n: 1n });
    expect(() => check(v, { fn: () => 1 })).toThrow("wire-encodable");
  });
});

describe("tsType text", () => {
  test("emits exact TypeScript for codegen", () => {
    expect(dbz.string().tsType()).toBe("string");
    expect(dbz.nullable(dbz.number()).tsType()).toBe("number | null");
    expect(dbz.array(dbz.nullable(dbz.string())).tsType()).toBe("(string | null)[]");
    expect(dbz.object({ a: dbz.bigint(), b: dbz.boolean() }).tsType()).toBe(
      "{ a: bigint; b: boolean }",
    );
    expect(dbz.enum("Role", ["a"]).tsType()).toBe("Role");
    expect(dbz.literal("image").tsType()).toBe('"image"');
    expect(dbz.literal(5n).tsType()).toBe("5n");
    expect(dbz.identity().tsType()).toBe("Identity");
  });
});
