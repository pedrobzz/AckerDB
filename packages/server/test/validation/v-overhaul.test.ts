import { describe, expect, test } from "bun:test";
import {
  Engine,
  ValidationError,
  defineSchema,
  defineTable,
  makeDbWriter,
  newWriteCollector,
  v,
} from "@ackerdb/server";

const check = <T>(validator: { check(value: unknown, path: string): T }, value: unknown) =>
  validator.check(value, "value");

describe("v numeric validators", () => {
  test("separates safe integers, finite floats, and signed i64 bigints", () => {
    expect(check(v.int(), 42)).toBe(42);
    expect(() => check(v.int(), 1.5)).toThrow("safe integer");
    expect(() => check(v.int(), Number.MAX_SAFE_INTEGER + 1)).toThrow("safe integer");

    expect(check(v.float(), 1.5)).toBe(1.5);
    expect(check(v.float(), 1)).toBe(1);
    expect(() => check(v.float(), Infinity)).toThrow("finite number");

    expect(check(v.bigint(), 2n ** 63n - 1n)).toBe(2n ** 63n - 1n);
    expect(() => check(v.bigint(), 2n ** 63n)).toThrow("64-bit");
  });
});

describe("v modifiers", () => {
  const shape = v.object({
    nullable: v.string().nullable(),
    optional: v.string().optional(),
    nullish: v.string().nullish(),
    ["__proto__"]: v.string().optional(),
  });

  test("keeps nullable required and preserves omitted versus explicit undefined", () => {
    expect(() => check(shape, {})).toThrow("value.nullable");

    const omitted = check(shape, { nullable: null });
    expect(omitted).toEqual({ nullable: null });
    expect(Object.hasOwn(omitted, "optional")).toBe(false);
    expect(Object.hasOwn(omitted, "nullish")).toBe(false);

    const explicit = check(shape, {
      nullable: "set",
      optional: undefined,
      nullish: undefined,
      ["__proto__"]: "kept",
    });
    expect(explicit).toEqual({
      nullable: "set",
      optional: undefined,
      nullish: undefined,
      ["__proto__"]: "kept",
    });
    expect(Object.getPrototypeOf(explicit)).toBe(Object.prototype);
    expect(Object.hasOwn(explicit, "optional")).toBe(true);
    expect(Object.hasOwn(explicit, "nullish")).toBe(true);
    expect(Object.hasOwn(explicit, "__proto__")).toBe(true);

    const ignored = check(shape, { nullable: null, unknown: undefined } as never);
    expect(Object.hasOwn(ignored, "unknown")).toBe(false);

    expect(() => check(shape, { nullable: undefined })).toThrow("value.nullable");
    expect(() => check(shape, { nullable: null, optional: null })).toThrow("value.optional");
    expect(check(shape, { nullable: null, nullish: null })).toEqual({
      nullable: null,
      nullish: null,
    });
  });

  test("rejects redundant modifier combinations at runtime", () => {
    const nullable = v.string().nullable() as unknown as { optional(): unknown };
    expect(() => nullable.optional()).toThrow("redundant");
  });

  test("does not read declared fields through the input prototype", () => {
    expect(() => check(v.object({ toString: v.string() }), {}))
      .toThrow("value.toString: expected string, got undefined");
    expect(() => check(v.object({ ["__proto__"]: v.string() }), {}))
      .toThrow("value.__proto__: expected string, got undefined");
  });
});

describe("stored modifiers", () => {
  test("rejects optional and nullish recursively", () => {
    expect(() => defineSchema({
      invalid: defineTable({
        id: v.primaryKey(),
        nested: v.object({ value: v.string().optional() }),
      }),
    })).toThrow("optional");

    expect(() => defineSchema({
      invalid: defineTable({
        id: v.primaryKey(),
        nested: v.array(v.string().nullish()),
      }),
    })).toThrow("nullish");
  });

  test("materializes omitted nullable inserts and ignores undefined patches", async () => {
    const schema = defineSchema({
      items: defineTable({
        id: v.primaryKey(),
        name: v.string(),
        note: v.string().nullable(),
      }),
    });
    const engine = new Engine(schema, ":memory:");
    engine.createAll();
    const writes = newWriteCollector();
    // The runtime DB builder is intentionally untyped; generated contexts own its public type.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = makeDbWriter(engine, writes, () => 1n) as any;

    const inserted = await db.items.insert({ name: "first" }).returning();
    expect(inserted.note).toBe(null);

    await db.items.patch(inserted.id, { note: "set" });
    await db.items.patch(inserted.id, { note: undefined });
    expect((await db.items.get(inserted.id))?.note).toBe("set");

    await db.items.patch(inserted.id, { note: null });
    expect((await db.items.get(inserted.id))?.note).toBe(null);
    engine.close("clean");
  });
});
