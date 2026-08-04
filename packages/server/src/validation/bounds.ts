/** Bound normalization and merging shared by every bounded validator kind. */
import { ValidationError } from "./error.ts";
import type { Descriptor } from "./validator.ts";

export const I64_MIN = -(2n ** 63n);
export const I64_MAX = 2n ** 63n - 1n;

export interface Bounds<B extends number | bigint> {
  readonly min?: B;
  readonly max?: B;
}

export function lengthBound(bound: number, method: "min" | "max", kind: "string" | "array"): number {
  if (!Number.isSafeInteger(bound) || bound < 0) {
    throw new ValidationError(
      `v.${kind}().${method}(): bound must be a non-negative safe integer`,
    );
  }
  return Object.is(bound, -0) ? 0 : bound;
}

export function nextBounds<B extends number | bigint>(
  kind: "string" | "int" | "float" | "bigint" | "array",
  bounds: Bounds<B>,
  method: "min" | "max",
  bound: B,
): Bounds<B> {
  if (bounds[method] !== undefined) {
    throw new ValidationError(`v.${kind}(): duplicate ${method} constraint`);
  }
  const min = method === "min" ? bound : bounds.min;
  const max = method === "max" ? bound : bounds.max;
  if (min !== undefined && max !== undefined && min > max) {
    throw new ValidationError(
      `v.${kind}(): min (${String(min)}) must be less than or equal to max (${String(max)})`,
    );
  }
  return {
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
  };
}

export function finiteBound(bound: number, method: "min" | "max", kind: "int" | "float"): number {
  if (!Number.isFinite(bound)) {
    throw new ValidationError(`v.${kind}().${method}(): bound must be a finite number`);
  }
  return Object.is(bound, -0) ? 0 : bound;
}

export function bigintBound(bound: bigint, method: "min" | "max"): void {
  if (typeof bound !== "bigint" || bound < I64_MIN || bound > I64_MAX) {
    throw new ValidationError(
      `v.bigint().${method}(): bound must be a bigint within the signed 64-bit range`,
    );
  }
}

export function numberBounds(descriptor: Descriptor): Bounds<number> {
  return {
    ...(descriptor["min"] === undefined ? {} : { min: descriptor["min"] as number }),
    ...(descriptor["max"] === undefined ? {} : { max: descriptor["max"] as number }),
  };
}

export function bigintBounds(descriptor: Descriptor): Bounds<bigint> {
  return {
    ...(descriptor["min"] === undefined ? {} : { min: BigInt(descriptor["min"] as string) }),
    ...(descriptor["max"] === undefined ? {} : { max: BigInt(descriptor["max"] as string) }),
  };
}
