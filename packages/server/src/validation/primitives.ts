/** The scalar `v` validators and the constraint methods chained onto them. */
import type { FileGrantId, FileId, Identity } from "@ackerdb/core";
import { ValidationError } from "./error.ts";
import {
  checkBigintConstraints,
  checkNumberConstraints,
  checkStringConstraints,
  type ConstraintFields,
} from "./constraints.ts";
import { normalizeVector, vectorDimensions } from "./vector.ts";
import {
  bigintBound,
  bigintBounds,
  finiteBound,
  lengthBound,
  nextBounds,
  numberBounds,
  type Bounds,
  I64_MAX,
  I64_MIN,
} from "./bounds.ts";
import {
  fail,
  makeValidator,
  validatorPrototype,
  type BoundedValidator,
  type ChainableValidator,
  type StandardValidator,
} from "./validator.ts";

export interface StringValidator extends BoundedValidator<string, "string", number> {
  regex(pattern: RegExp): this;
}

export function primaryKey(): StandardValidator<bigint, "pk"> {
  return makeValidator("pk", {
    parse(value, path) {
      if (typeof value !== "bigint") fail(path, "bigint (primary key)", value);
      return value;
    },
    tsType: () => "bigint",
    descriptor: () => ({ k: "pk" }),
  }, undefined, "none");
}

interface StringConstraints extends Bounds<number> {
  readonly regex?: { readonly source: string; readonly compiled: RegExp };
}

function checkString(value: unknown, path: string): string {
  if (typeof value !== "string") fail(path, "string", value);
  return value;
}

export function string(
  constraints?: StringConstraints,
  description?: string,
): StringValidator {
  const fields: ConstraintFields | undefined = constraints === undefined
    ? undefined
    : {
      ...(constraints.min === undefined ? {} : { min: constraints.min }),
      ...(constraints.max === undefined ? {} : { max: constraints.max }),
      ...(constraints.regex === undefined ? {} : { regex: constraints.regex.source }),
    };
  const parse = constraints === undefined
    ? checkString
    : (value: unknown, path: string): string => {
      const checked = checkString(value, path);
      checkStringConstraints(fields!, checked, path, constraints.regex?.compiled);
      return checked;
    };
  return makeValidator<string, "string", Pick<StringValidator, "min" | "max" | "regex">>(
    "string",
    {
      parse,
      tsType: () => "string",
      descriptor: () => ({
        k: "string",
        ...fields,
      }),
    },
    undefined,
    "available",
    description,
    STRING_CONSTRAINT_PROTOTYPE,
  ) as StringValidator;
}

function checkInt(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) fail(path, "safe integer", value);
  return value;
}

function checkFloat(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "finite number", value);
  return value;
}


function boundedNumber<K extends "int" | "float">(
  kind: K,
  baseCheck: (value: unknown, path: string) => number,
  constraints?: Bounds<number>,
  description?: string,
): BoundedValidator<number, K, number> {
  const fields: ConstraintFields | undefined = constraints === undefined
    ? undefined
    : {
      ...(constraints.min === undefined ? {} : { min: constraints.min }),
      ...(constraints.max === undefined ? {} : { max: constraints.max }),
    };
  const parse = constraints === undefined
    ? baseCheck
    : (value: unknown, path: string): number => {
      const checked = baseCheck(value, path);
      checkNumberConstraints(fields!, checked, path);
      return checked;
    };
  return makeValidator<number, K, Pick<BoundedValidator<number, K, number>, "min" | "max">>(
    kind,
    {
      parse,
      tsType: () => "number",
      descriptor: () => ({
        k: kind,
        ...fields,
      }),
    },
    undefined,
    "available",
    description,
    NUMBER_CONSTRAINT_PROTOTYPE,
  ) as BoundedValidator<number, K, number>;
}

export function int(): BoundedValidator<number, "int", number> {
  return boundedNumber("int", checkInt);
}

export function float(): BoundedValidator<number, "float", number> {
  return boundedNumber("float", checkFloat);
}

function checkI64(value: unknown, path: string, expected: string): bigint {
  if (typeof value !== "bigint") fail(path, expected, value);
  if (value < I64_MIN || value > I64_MAX) {
    throw new ValidationError(`${path}: bigint out of 64-bit range`);
  }
  return value;
}

function checkBigint(value: unknown, path: string): bigint {
  return checkI64(value, path, "bigint");
}

export function bigint(
  constraints?: Bounds<bigint>,
  description?: string,
): BoundedValidator<bigint, "bigint", bigint> {
  const fields: ConstraintFields | undefined = constraints === undefined
    ? undefined
    : {
      ...(constraints.min === undefined ? {} : { min: constraints.min.toString() }),
      ...(constraints.max === undefined ? {} : { max: constraints.max.toString() }),
    };
  const parse = constraints === undefined
    ? checkBigint
    : (value: unknown, path: string): bigint => {
      const checked = checkBigint(value, path);
      checkBigintConstraints(fields!, checked, path, constraints);
      return checked;
    };
  return makeValidator<
    bigint,
    "bigint",
    Pick<BoundedValidator<bigint, "bigint", bigint>, "min" | "max">
  >(
    "bigint",
    {
      parse,
      tsType: () => "bigint",
      descriptor: () => ({
        k: "bigint",
        ...fields,
      }),
    },
    undefined,
    "available",
    description,
    BIGINT_CONSTRAINT_PROTOTYPE,
  ) as BoundedValidator<bigint, "bigint", bigint>;
}

export function identity(): ChainableValidator<Identity, "identity"> {
  return makeValidator("identity", {
    parse: (value, path) => checkI64(value, path, "Identity (bigint)") as Identity,
    tsType: () => "Identity",
    descriptor: () => ({ k: "identity" }),
  });
}

export type FileValidator = ChainableValidator<FileId, "file">;

export function file(): FileValidator {
  return makeValidator("file", {
    parse: (value, path) => checkI64(value, path, "FileId (bigint)") as FileId,
    tsType: () => "FileId",
    descriptor: () => ({ k: "file" }),
  });
}

export type FileGrantValidator = ChainableValidator<FileGrantId, "fileGrant">;

export function fileGrant(): FileGrantValidator {
  return makeValidator("fileGrant", {
    parse: (value, path) => checkI64(value, path, "FileGrantId (bigint)") as FileGrantId,
    tsType: () => "FileGrantId",
    descriptor: () => ({ k: "fileGrant" }),
  });
}

export function boolean(): ChainableValidator<boolean, "boolean"> {
  return makeValidator("boolean", {
    parse(value, path) {
      if (typeof value !== "boolean") fail(path, "boolean", value);
      return value;
    },
    tsType: () => "boolean",
    descriptor: () => ({ k: "boolean" }),
  });
}

export function bytes(): ChainableValidator<Uint8Array, "bytes"> {
  return makeValidator("bytes", {
    parse(value, path) {
      if (!(value instanceof Uint8Array)) fail(path, "Uint8Array", value);
      return value;
    },
    tsType: () => "Uint8Array",
    descriptor: () => ({ k: "bytes" }),
  });
}

export interface VectorValidator
  extends ChainableValidator<readonly number[], "vector", readonly number[]> {
  readonly dimensions: number;
}

export function vector(dimensions: number): VectorValidator {
  const size = vectorDimensions(dimensions, "v.vector()");
  return makeValidator<
    readonly number[],
    "vector",
    { readonly dimensions: number },
    readonly number[]
  >(
    "vector",
    {
      parse: (value, path) => normalizeVector(value, size, path),
      tsType: () => "readonly number[]",
      descriptor: () => ({ k: "vector", dimensions: size }),
    },
    { dimensions: size },
  );
}

export function scheduleAt(): StandardValidator<number, "scheduleAt"> {
  return makeValidator("scheduleAt", {
    parse(value, path) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        fail(path, "timestamp (finite number)", value);
      }
      return value;
    },
    tsType: () => "number",
    descriptor: () => ({ k: "scheduleAt" }),
  }, undefined, "none");
}


const STRING_CONSTRAINT_PROTOTYPE = validatorPrototype({
  min(this: StringValidator, bound: number): StringValidator {
    const normalized = lengthBound(bound, "min", "string");
    const descriptor = this.descriptor();
    const source = descriptor["regex"] as string | undefined;
    return string({
      ...nextBounds("string", numberBounds(descriptor), "min", normalized),
      ...(source === undefined ? {} : { regex: { source, compiled: new RegExp(source) } }),
    }, this.description);
  },
  max(this: StringValidator, bound: number): StringValidator {
    const normalized = lengthBound(bound, "max", "string");
    const descriptor = this.descriptor();
    const source = descriptor["regex"] as string | undefined;
    return string({
      ...nextBounds("string", numberBounds(descriptor), "max", normalized),
      ...(source === undefined ? {} : { regex: { source, compiled: new RegExp(source) } }),
    }, this.description);
  },
  regex(this: StringValidator, pattern: RegExp): StringValidator {
    if (!(pattern instanceof RegExp)) {
      throw new ValidationError("v.string().regex(): pattern must be a RegExp");
    }
    if (pattern.flags !== "") {
      throw new ValidationError("v.string().regex(): RegExp flags are not allowed");
    }
    const descriptor = this.descriptor();
    if (descriptor["regex"] !== undefined) {
      throw new ValidationError("v.string(): duplicate regex constraint");
    }
    const source = pattern.source;
    return string({
      ...numberBounds(descriptor),
      regex: { source, compiled: new RegExp(source) },
    }, this.description);
  },
});

type NumberConstraintValidator = BoundedValidator<number, "int" | "float", number>;
const NUMBER_CONSTRAINT_PROTOTYPE = validatorPrototype({
  min(this: NumberConstraintValidator, bound: number): NumberConstraintValidator {
    const kind = this.kind;
    return boundedNumber(
      kind,
      kind === "int" ? checkInt : checkFloat,
      nextBounds(kind, numberBounds(this.descriptor()), "min", finiteBound(bound, "min", kind)),
      this.description,
    );
  },
  max(this: NumberConstraintValidator, bound: number): NumberConstraintValidator {
    const kind = this.kind;
    return boundedNumber(
      kind,
      kind === "int" ? checkInt : checkFloat,
      nextBounds(kind, numberBounds(this.descriptor()), "max", finiteBound(bound, "max", kind)),
      this.description,
    );
  },
});

type BigintConstraintValidator = BoundedValidator<bigint, "bigint", bigint>;
const BIGINT_CONSTRAINT_PROTOTYPE = validatorPrototype({
  min(this: BigintConstraintValidator, bound: bigint): BigintConstraintValidator {
    bigintBound(bound, "min");
    return bigint(
      nextBounds("bigint", bigintBounds(this.descriptor()), "min", bound),
      this.description,
    );
  },
  max(this: BigintConstraintValidator, bound: bigint): BigintConstraintValidator {
    bigintBound(bound, "max");
    return bigint(
      nextBounds("bigint", bigintBounds(this.descriptor()), "max", bound),
      this.description,
    );
  },
});
