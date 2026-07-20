import { describe, expect, test } from "bun:test";
import {
  type ObjectShape,
  ValidationError,
  defineSchema,
  defineTable,
  snapshotOf,
  v,
} from "@dbzz/server";
import { compileStandardJsonCodec } from "../src/standard-schema.ts";
import { checkDescriptor } from "../src/schema/descriptor-kinds.ts";
import { checkShape, validatorBaseChecksForTest } from "../src/v.ts";

const check = <T>(validator: { check(value: unknown, path: string): T }, value: unknown) =>
  validator.check(value, "value");

test("only approved validator families expose constraint methods", () => {
  expect(v.string()).toMatchObject({ min: expect.any(Function), max: expect.any(Function), regex: expect.any(Function) });
  for (const validator of [v.int(), v.float(), v.bigint(), v.array(v.string())]) {
    expect(validator).toMatchObject({ min: expect.any(Function), max: expect.any(Function) });
    expect("regex" in validator).toBe(false);
  }
  for (const validator of [
    v.identity(),
    v.boolean(),
    v.bytes(),
    v.object({ value: v.string() }),
    v.enum("Role", ["admin"]),
    v.literal("x"),
    v.union("Payload", { text: v.string() }),
    v.jsonb<unknown>(),
    v.primaryKey(),
    v.scheduleAt(),
    v.tag(),
  ]) {
    expect("min" in validator).toBe(false);
    expect("max" in validator).toBe(false);
    expect("regex" in validator).toBe(false);
  }
});

describe("v string constraints", () => {
  test("checks inclusive Unicode code-point bounds and a flagless regex", () => {
    for (const flag of ["d", "g", "i", "m", "s", "u", "v", "y"]) {
      expect(() => v.string().regex(new RegExp("a", flag))).toThrow("flags");
    }

    const letters = v.string().min(2).max(3).regex(/^[A-Za-z😀]+$/);
    expect(check(letters, "a😀")).toBe("a😀");
    expect(() => check(letters, "😀")).toThrow("value");
    expect(() => check(letters, "abcd")).toThrow("at most 3 Unicode code points");
    expect(() => check(letters, "a1")).toThrow("pattern");
  });

  test("serializes one canonical descriptor independent of chain order", () => {
    const minThenMax = v.string().min(2).max(5).regex(/^[a-z]+$/);
    const regexThenMaxThenMin = v.string().regex(/^[a-z]+$/).max(5).min(2);

    expect(minThenMax.descriptor()).toEqual({
      k: "string",
      min: 2,
      max: 5,
      regex: "^[a-z]+$",
    });
    expect(regexThenMaxThenMin.descriptor()).toEqual(minThenMax.descriptor());
    expect(JSON.stringify(regexThenMaxThenMin.descriptor())).toBe(
      JSON.stringify(minThenMax.descriptor()),
    );
  });

  test("rejects invalid, duplicate, and contradictory definitions", () => {
    for (const bound of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
      expect(() => v.string().min(bound)).toThrow("non-negative safe integer");
    }
    expect(() => v.string().min(1).min(1)).toThrow("duplicate min");
    expect(() => v.string().max(4).max(5)).toThrow("duplicate max");
    expect(() => v.string().regex(/a/).regex(/b/)).toThrow("duplicate regex");
    expect(() => v.string().min(5).max(4)).toThrow("min");
    expect(() => v.string().max(4).min(5)).toThrow("min");
    expect(() => v.string().regex("a" as unknown as RegExp)).toThrow(ValidationError);

    const zero = v.string().min(-0).descriptor()["min"];
    expect(zero).toBe(0);
    expect(Object.is(zero, -0)).toBe(false);
  });

  test("preserves descriptions and immutable originals across chains", () => {
    const original = v.string().describe("A display label.");
    const constrained = original.min(1).regex(new RegExp(""));

    expect(original.description).toBe("A display label.");
    expect(original.descriptor()).toEqual({ k: "string" });
    expect(constrained.description).toBe("A display label.");
    expect(constrained.descriptor()).toEqual({ k: "string", min: 1, regex: "(?:)" });
    expect(constrained.describe("A renamed label.").descriptor()).toEqual(
      constrained.descriptor(),
    );
  });
});

describe("v numeric constraints", () => {
  test("checks inclusive finite int and float bounds", () => {
    const ints = v.int().min(1.5).max(3.5);
    expect(check(ints, 2)).toBe(2);
    expect(check(ints, 3)).toBe(3);
    expect(() => check(ints, 1)).toThrow("greater than or equal to 1.5");
    expect(() => check(ints, 4)).toThrow("less than or equal to 3.5");

    const floats = v.float().max(1).min(-1);
    expect(check(floats, -1)).toBe(-1);
    expect(check(floats, 1)).toBe(1);
    expect(() => check(floats, -1.01)).toThrow("greater than or equal to -1");
    expect(() => check(floats, 1.01)).toThrow("less than or equal to 1");
  });

  test("validates numeric definitions and canonicalizes descriptor order", () => {
    expect(v.int().max(8).min(2).descriptor()).toEqual({ k: "int", min: 2, max: 8 });
    expect(v.float().min(-2.5).max(4).descriptor()).toEqual({
      k: "float",
      min: -2.5,
      max: 4,
    });
    for (const bound of [NaN, Infinity, -Infinity]) {
      expect(() => v.int().min(bound)).toThrow("finite number");
      expect(() => v.float().max(bound)).toThrow("finite number");
    }
    expect(() => v.int().min(1).min(2)).toThrow("duplicate min");
    expect(() => v.float().max(2).max(1)).toThrow("duplicate max");
    expect(() => v.int().min(2).max(1)).toThrow("min");
  });

  test("checks signed-i64 bigint bounds and serializes decimal strings", () => {
    const min = -(2n ** 63n);
    const max = 2n ** 63n - 1n;
    const validator = v.bigint().max(max).min(min);
    expect(check(validator, min)).toBe(min);
    expect(check(validator, max)).toBe(max);
    expect(validator.descriptor()).toEqual({
      k: "bigint",
      min: "-9223372036854775808",
      max: "9223372036854775807",
    });
    expect(() => check(v.bigint().min(3n), 2n)).toThrow("greater than or equal to 3");
    expect(() => check(v.bigint().max(3n), 4n)).toThrow("less than or equal to 3");
    expect(() => v.bigint().min(-(2n ** 63n) - 1n)).toThrow("64-bit");
    expect(() => v.bigint().max(2n ** 63n)).toThrow("64-bit");
    expect(() => v.bigint().min(1n).min(1n)).toThrow("duplicate min");
    expect(() => v.bigint().max(1n).min(2n)).toThrow("min");
  });
});

describe("v array constraints", () => {
  test("checks inclusive item counts and preserves nested element paths", () => {
    const validator = v.array(v.string().min(2)).min(1).max(2);
    expect(check(validator, ["ab"])).toEqual(["ab"]);
    expect(check(validator, ["ab", "cd"])).toEqual(["ab", "cd"]);
    expect(() => check(validator, [])).toThrow("at least 1 item");
    expect(() => check(validator, ["ab", "cd", "ef"])).toThrow("at most 2 items");
    expect(() => check(validator, ["x"])).toThrow("value[0]");
    expect(() => check(v.array(v.string().min(2)).max(0), ["x"]))
      .toThrow("at most 0 items");
  });

  test("validates count definitions and canonicalizes descriptor order", () => {
    expect(v.array(v.int()).max(4).min(1).descriptor()).toEqual({
      k: "array",
      el: { k: "int" },
      min: 1,
      max: 4,
    });
    expect(() => v.array(v.string()).min(-1)).toThrow("non-negative safe integer");
    expect(() => v.array(v.string()).max(1.5)).toThrow("non-negative safe integer");
    expect(() => v.array(v.string()).min(1).min(2)).toThrow("duplicate min");
    expect(() => v.array(v.string()).max(1).min(2)).toThrow("min");

    const zero = v.array(v.string()).max(-0).descriptor()["max"];
    expect(zero).toBe(0);
    expect(Object.is(zero, -0)).toBe(false);
  });
});

test("nullable null bypasses inner constraints", () => {
  const validator = v.string().min(2).nullable();
  expect(check(validator, null)).toBeNull();
  expect(() => check(validator, "x")).toThrow("value");
});

test("schema snapshots retain canonical constraints but exclude descriptions", () => {
  const schema = (description: string) => defineSchema({
    items: defineTable({
      id: v.primaryKey(),
      tags: v.array(v.string().min(1).regex(/^[a-z]+$/)).max(3).describe(description),
      score: v.float().min(0).nullable(),
    }),
  });
  const snapshot = snapshotOf(schema("First description."));

  expect(snapshot.tables.items?.columns).toEqual({
    id: { k: "pk" },
    tags: {
      k: "array",
      el: { k: "string", min: 1, regex: "^[a-z]+$" },
      max: 3,
    },
    score: { k: "nullable", inner: { k: "float", min: 0 } },
  });
  expect(snapshotOf(schema("Different description."))).toEqual(snapshot);
});

describe("constraint Standard JSON Schema projection", () => {
  const target = { target: "draft-2020-12" as const };

  test("emits faithful string, array, int, and float keywords", () => {
    expect(v.string().min(2).max(5).regex(/^[a-z]+$/).describe("A slug.")
      ["~standard"].jsonSchema.input(target)).toEqual({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "string",
        minLength: 2,
        maxLength: 5,
        pattern: "^[a-z]+$",
        description: "A slug.",
      });
    expect(v.array(v.int().min(0)).min(1).max(3)
      ["~standard"].jsonSchema.output(target)).toEqual({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "array",
        items: { type: "integer", minimum: 0 },
        minItems: 1,
        maxItems: 3,
      });
    expect(v.float().min(-1.5).max(2.5)["~standard"].jsonSchema.input(target)).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "number",
      minimum: -1.5,
      maximum: 2.5,
    });
  });

  test("documents bigint bounds without contradictory numeric keywords", () => {
    const schema = compileStandardJsonCodec(
      v.bigint().min(-5n).max(10n).describe("A durable counter."),
    ).inputSchema;

    expect(schema).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: ["integer", "string"],
      pattern: "^(?:0|-?[1-9][0-9]*)$",
      description:
        "A durable counter. Minimum bigint value (inclusive): -5. Maximum bigint value (inclusive): 10.",
    });
    expect(schema).not.toHaveProperty("minimum");
    expect(schema).not.toHaveProperty("maximum");
  });
});

test("unconstrained validators retain their direct base check", () => {
  const plainString = v.string();
  const constrainedString = plainString.min(0);
  expect(Object.keys(plainString)).toEqual(["kind", "check", "tsType", "descriptor"]);
  expect(Object.hasOwn(plainString, "min")).toBe(false);
  expect(Object.getPrototypeOf(constrainedString)).toBe(Object.getPrototypeOf(plainString));
  expect(v.string().check).toBe(validatorBaseChecksForTest.string);
  expect(v.int().check).toBe(validatorBaseChecksForTest.int);
  expect(v.float().check).toBe(validatorBaseChecksForTest.float);
  expect(v.bigint().check).toBe(validatorBaseChecksForTest.bigint);
  expect(constrainedString.check).not.toBe(validatorBaseChecksForTest.string);
  expect(v.int().max(0).check).not.toBe(validatorBaseChecksForTest.int);
  expect(v.float().min(0).check).not.toBe(validatorBaseChecksForTest.float);
  expect(v.bigint().max(0n).check).not.toBe(validatorBaseChecksForTest.bigint);

  const plainArray = v.array(v.string());
  expect(plainArray.check.toString()).not.toContain("checkArrayConstraints");
  expect(plainArray.min(0).check.toString()).toContain("checkArrayConstraints");
});

test("object validators own one immutable shape across their public contract", () => {
  const source: ObjectShape = { name: v.string() };
  const owned = v.object(source);
  expect(Object.isFrozen(owned.shape)).toBe(true);

  source.name = v.int();
  source.extra = v.boolean();

  expect(owned.check({ name: "Ada" }, "value")).toEqual({ name: "Ada" });
  expect(() => owned.check({ name: "Ada", extra: true }, "value")).toThrow(
    'unknown field "extra"',
  );
  expect(owned.tsType()).toBe("{ name: string }");
  expect(owned.descriptor()).toEqual({ k: "object", shape: { name: { k: "string" } } });

  const thisAware = v.string();
  const baseCheck = thisAware.check;
  thisAware.check = function (this: typeof thisAware, value, path) {
    if (this !== thisAware) throw new Error("field check received the wrong validator receiver");
    return baseCheck(value, path);
  };
  expect(v.object({ value: thisAware }).check({ value: "ok" }, "value"))
    .toEqual({ value: "ok" });

  expect(() => checkShape({}, { toString: "declared by Object.prototype" }, "value"))
    .toThrow('unknown field "toString"');
});

test("live and descriptor validation reject prototype-named fields and variants", () => {
  expect(() => v.union("Payload", { text: v.string() }).check(
    { tag: "toString", value: "payload" },
    "value",
  )).toThrow('value.tag: expected one of "text"');

  expect(() => checkDescriptor(
    { k: "object", shape: {} },
    { toString: "declared by Object.prototype" },
    "value",
  )).toThrow('unknown field "toString"');

  expect(() => checkDescriptor(
    { k: "union", name: "Payload", members: { text: { k: "string" } } },
    { tag: "toString", value: "payload" },
    "value",
  )).toThrow('value.tag: expected one of "text"');
});

test("declared prototype-named fields and variants remain own through every validator projection", () => {
  const object = v.object({ ["__proto__"]: v.string() });
  const input = JSON.parse('{"__proto__":"kept"}');
  const live = object.check(input, "value") as Record<string, unknown>;
  const descriptor = object.descriptor();
  const stored = checkDescriptor(descriptor, input, "value") as Record<string, unknown>;

  expect(Object.hasOwn(live, "__proto__")).toBe(true);
  expect(live["__proto__"]).toBe("kept");
  expect(Object.hasOwn(descriptor["shape"] as object, "__proto__")).toBe(true);
  expect(Object.getPrototypeOf(stored)).toBeNull();
  expect(Object.hasOwn(stored, "__proto__")).toBe(true);
  expect(stored["__proto__"]).toBe("kept");

  const union = v.union("PrototypeVariant", { ["__proto__"]: v.string() });
  expect(Object.hasOwn(union.union, "__proto__")).toBe(true);
  expect(union.union.__proto__("payload")).toEqual({
    tag: "__proto__",
    value: "payload",
  });
  expect(Object.hasOwn(union.descriptor()["members"] as object, "__proto__")).toBe(true);
  expect(checkDescriptor(
    union.descriptor(),
    { tag: "__proto__", value: "payload" },
    "value",
  )).toEqual({ tag: "__proto__", value: "payload" });
});
