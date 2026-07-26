import { decode, encode } from "@ackerdb/core";
import type { Descriptor } from "../validation/v.ts";
import { validateConstraintDescriptor } from "../validation/constraints.ts";
import { ValidationError } from "../validation/error.ts";

type DescriptorRole = "column" | "nested" | "union-member";

const FIELDS = {
  pk: ["k"],
  string: ["k", "min", "max", "regex"],
  int: ["k", "min", "max"],
  float: ["k", "min", "max"],
  scheduleAt: ["k"],
  bigint: ["k", "min", "max"],
  identity: ["k"],
  boolean: ["k"],
  bytes: ["k"],
  vector: ["k", "dimensions"],
  enum: ["k", "name", "values"],
  literal: ["k", "v"],
  tag: ["k"],
  array: ["k", "el", "min", "max"],
  object: ["k", "shape"],
  union: ["k", "name", "members"],
  jsonb: ["k"],
  nullable: ["k", "inner"],
  optional: ["k", "inner"],
  nullish: ["k", "inner"],
} as const;

type DescriptorKind = keyof typeof FIELDS;
const NAME = /^[a-zA-Z][a-zA-Z0-9_]*$/;

function fail(path: string, message: string): never {
  throw new ValidationError(`${path}: ${message}`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "expected a validator descriptor object");
  }
  return value as Record<string, unknown>;
}

function name(value: unknown, path: string): string {
  if (typeof value !== "string" || !NAME.test(value) || value.includes("__")) {
    fail(path, "expected a valid identifier");
  }
  return value;
}

function exactFields(
  descriptor: Record<string, unknown>,
  kind: DescriptorKind,
  path: string,
): void {
  const allowed = FIELDS[kind] as readonly string[];
  const unknown = Object.keys(descriptor).find((field) => !allowed.includes(field));
  if (unknown !== undefined) fail(path, `unknown ${kind} descriptor field ${JSON.stringify(unknown)}`);
  const missing = allowed.find((field) =>
    field !== "min" && field !== "max" && field !== "regex" && !Object.hasOwn(descriptor, field)
  );
  if (missing !== undefined) fail(path, `missing ${kind} descriptor field ${JSON.stringify(missing)}`);
}

function validateLiteral(value: unknown, path: string): void {
  if (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  const encoded = record(value, path);
  if (
    Object.keys(encoded).length !== 2 ||
    encoded["$"] !== "b" ||
    typeof encoded["v"] !== "string"
  ) {
    fail(path, "invalid literal descriptor value");
  }
  try {
    const decoded = decode(JSON.stringify(encoded));
    const canonical = JSON.parse(encode(decoded)) as Record<string, unknown>;
    if (typeof decoded !== "bigint" || canonical["v"] !== encoded["v"]) {
      fail(path, "invalid literal descriptor value");
    }
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    fail(path, "invalid literal descriptor value");
  }
}

function validate(
  value: unknown,
  path: string,
  role: DescriptorRole,
  modifierAllowed: boolean,
): void {
  const descriptor = record(value, path);
  const kind = descriptor["k"];
  if (typeof kind !== "string" || !Object.hasOwn(FIELDS, kind)) {
    fail(path, `unknown validator descriptor kind ${JSON.stringify(kind)}`);
  }
  const typedKind = kind as DescriptorKind;
  exactFields(descriptor, typedKind, path);

  switch (typedKind) {
    case "optional":
    case "nullish":
      fail(path, `.${typedKind}() is not valid in stored data; use .nullable()`);
    case "nullable":
      if (!modifierAllowed) fail(path, "redundant stored presence modifier");
      {
        const inner = record(descriptor["inner"], `${path}.inner`);
        if (inner["k"] === "pk" || inner["k"] === "scheduleAt" || inner["k"] === "tag") {
          fail(path, `v.${String(inner["k"])}() cannot be nullable`);
        }
        validate(inner, `${path}.inner`, role, false);
      }
      return;
    case "pk":
    case "scheduleAt":
      if (role !== "column") fail(path, `v.${typedKind}() must be a top-level column`);
      return;
    case "tag":
      if (role !== "union-member") fail(path, "v.tag() must be a direct union member");
      return;
    case "literal":
      if (role === "column") fail(path, "v.literal() cannot be stored as a top-level column");
      validateLiteral(descriptor["v"], `${path}.v`);
      return;
    case "vector":
      if (role !== "column") {
        fail(path, "v.vector() must be a direct table column");
      }
      if (!Number.isSafeInteger(descriptor["dimensions"]) || (descriptor["dimensions"] as number) <= 0) {
        fail(`${path}.dimensions`, "expected a positive safe integer");
      }
      return;
    case "string":
    case "int":
    case "float":
    case "bigint":
      validateConstraintDescriptor(typedKind, descriptor, path);
      return;
    case "array":
      validateConstraintDescriptor("array", descriptor, path);
      validate(descriptor["el"], `${path}.el`, "nested", true);
      return;
    case "object": {
      const shape = record(descriptor["shape"], `${path}.shape`);
      for (const key of Object.keys(shape)) {
        validate(shape[key], `${path}.shape.${key}`, "nested", true);
      }
      return;
    }
    case "enum": {
      name(descriptor["name"], `${path}.name`);
      const values = descriptor["values"];
      if (
        !Array.isArray(values) ||
        values.length === 0 ||
        values.some((variant) => typeof variant !== "string") ||
        new Set(values).size !== values.length
      ) {
        fail(`${path}.values`, "expected distinct string variants");
      }
      return;
    }
    case "union": {
      name(descriptor["name"], `${path}.name`);
      const members = record(descriptor["members"], `${path}.members`);
      const variants = Object.keys(members);
      if (variants.length === 0) fail(`${path}.members`, "expected at least one union variant");
      for (const variant of variants) {
        name(variant, `${path}.members variant`);
        validate(members[variant], `${path}.members.${variant}`, "union-member", true);
      }
      return;
    }
    case "identity":
    case "boolean":
    case "bytes":
    case "jsonb":
      return;
  }
}

/** Validate one complete persisted column descriptor before DDL or diff consumers see it. */
export function validateStoredDescriptor(value: unknown, path: string): asserts value is Descriptor {
  validate(value, path, "column", true);
}
