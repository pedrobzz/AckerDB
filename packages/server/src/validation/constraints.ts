import { ValidationError } from "./error.ts";

export interface ConstraintFields {
  readonly [field: string]: unknown;
  readonly min?: unknown;
  readonly max?: unknown;
  readonly regex?: unknown;
}

const DECIMAL = /^(?:0|-?[1-9][0-9]*)$/;
const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;
// Historical snapshot descriptors validate many rows; compile/parse each
// descriptor's durable constraint data once, never once per migrated row.
const descriptorRegexes = new WeakMap<object, RegExp>();
const descriptorBigints = new WeakMap<object, ParsedBounds<bigint>>();

export interface ParsedBounds<T> {
  readonly min?: T;
  readonly max?: T;
}

function lengthField(
  descriptor: ConstraintFields,
  field: "min" | "max",
  path: string,
): number | undefined {
  const value = descriptor[field];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ValidationError(`${path}: invalid ${field} length constraint descriptor`);
  }
  return value;
}

function numberField(
  descriptor: ConstraintFields,
  field: "min" | "max",
  path: string,
): number | undefined {
  const value = descriptor[field];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ValidationError(`${path}: invalid ${field} numeric constraint descriptor`);
  }
  return value;
}

function bigintField(
  descriptor: ConstraintFields,
  field: "min" | "max",
  path: string,
): bigint | undefined {
  const value = descriptor[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !DECIMAL.test(value)) {
    throw new ValidationError(`${path}: invalid ${field} bigint constraint descriptor`);
  }
  const bound = BigInt(value);
  if (bound < I64_MIN || bound > I64_MAX) {
    throw new ValidationError(`${path}: ${field} bigint constraint is outside the signed 64-bit range`);
  }
  return bound;
}

function bigintBounds(descriptor: ConstraintFields, path: string): ParsedBounds<bigint> {
  const key = descriptor as object;
  const cached = descriptorBigints.get(key);
  if (cached !== undefined) return cached;
  const min = bigintField(descriptor, "min", path);
  const max = bigintField(descriptor, "max", path);
  const bounds = {
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
  };
  descriptorBigints.set(key, bounds);
  return bounds;
}

function descriptorRegex(descriptor: ConstraintFields, path: string): RegExp | undefined {
  const source = descriptor.regex;
  if (source === undefined) return undefined;
  if (typeof source !== "string") {
    throw new ValidationError(`${path}: invalid regex constraint descriptor`);
  }
  const key = descriptor as object;
  const cached = descriptorRegexes.get(key);
  if (cached !== undefined) return cached;
  let compiled: RegExp;
  try {
    compiled = new RegExp(source);
  } catch {
    throw new ValidationError(`${path}: invalid regex constraint descriptor`);
  }
  descriptorRegexes.set(key, compiled);
  return compiled;
}

export function checkStringConstraints(
  descriptor: ConstraintFields,
  value: string,
  path: string,
  compiledRegex?: RegExp,
): void {
  const min = lengthField(descriptor, "min", path);
  const max = lengthField(descriptor, "max", path);
  if (min !== undefined || max !== undefined) {
    let length = 0;
    for (const _codePoint of value) length++;
    if (min !== undefined && length < min) {
      throw new ValidationError(
        `${path}: expected at least ${min} Unicode code points, got ${length}`,
      );
    }
    if (max !== undefined && length > max) {
      throw new ValidationError(
        `${path}: expected at most ${max} Unicode code points, got ${length}`,
      );
    }
  }
  const regex = compiledRegex ?? (
    descriptor.regex === undefined ? undefined : descriptorRegex(descriptor, path)
  );
  if (regex !== undefined && !regex.test(value)) {
    throw new ValidationError(`${path}: string does not match pattern /${regex.source}/`);
  }
}

export function checkNumberConstraints(
  descriptor: ConstraintFields,
  value: number,
  path: string,
): void {
  const min = numberField(descriptor, "min", path);
  const max = numberField(descriptor, "max", path);
  if (min !== undefined && value < min) {
    throw new ValidationError(`${path}: expected a number greater than or equal to ${min}`);
  }
  if (max !== undefined && value > max) {
    throw new ValidationError(`${path}: expected a number less than or equal to ${max}`);
  }
}

export function checkBigintConstraints(
  descriptor: ConstraintFields,
  value: bigint,
  path: string,
  parsed?: ParsedBounds<bigint>,
): void {
  const { min, max } = parsed ?? bigintBounds(descriptor, path);
  if (min !== undefined && value < min) {
    throw new ValidationError(`${path}: expected a bigint greater than or equal to ${min}`);
  }
  if (max !== undefined && value > max) {
    throw new ValidationError(`${path}: expected a bigint less than or equal to ${max}`);
  }
}

export function checkArrayConstraints(
  descriptor: ConstraintFields,
  length: number,
  path: string,
): void {
  const min = lengthField(descriptor, "min", path);
  const max = lengthField(descriptor, "max", path);
  if (min !== undefined && length < min) {
    throw new ValidationError(`${path}: expected at least ${itemCount(min)}, got ${itemCount(length)}`);
  }
  if (max !== undefined && length > max) {
    throw new ValidationError(`${path}: expected at most ${itemCount(max)}, got ${itemCount(length)}`);
  }
}

function itemCount(count: number): string {
  return `${count} ${count === 1 ? "item" : "items"}`;
}

/** Validate durable constraint metadata without needing a sample value. */
export function validateConstraintDescriptor(
  kind: "string" | "int" | "float" | "bigint" | "array",
  descriptor: ConstraintFields,
  path: string,
): void {
  let min: number | bigint | undefined;
  let max: number | bigint | undefined;
  if (kind === "string" || kind === "array") {
    min = lengthField(descriptor, "min", path);
    max = lengthField(descriptor, "max", path);
    if (kind === "string") descriptorRegex(descriptor, path);
  } else if (kind === "bigint") {
    ({ min, max } = bigintBounds(descriptor, path));
  } else {
    min = numberField(descriptor, "min", path);
    max = numberField(descriptor, "max", path);
  }
  if (min !== undefined && max !== undefined && min > max) {
    throw new ValidationError(`${path}: min constraint must be less than or equal to max`);
  }
}
