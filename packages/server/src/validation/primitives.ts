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
  type Validator,
} from "./validator.ts";
import {
  base64JsonSchema,
  decimalJsonSchema,
  type JsonSchemaContext,
} from "./json-schema.ts";
import {
  decodeBase64,
  decodeDecimal,
  encodeBase64,
  encodeDecimal,
} from "./standard-json.ts";

function decimalJson<T extends bigint = bigint>(source: string) {
  return {
    decode(this: Pick<Validator<T>, "parse">, value: unknown, path: string) {
      return this.parse(decodeDecimal(value, path), path);
    },
    encode(this: Pick<Validator<T>, "parse">, value: T, path: string) {
      return encodeDecimal(this.parse(value, path));
    },
    toJsonSchema: (context: JsonSchemaContext) =>
      decimalJsonSchema(context, source),
  };
}

export interface StringValidator extends BoundedValidator<string, "string", number> {
  regex(pattern: RegExp): this;
}

export function primaryKey(): StandardValidator<
  bigint,
  "pk",
  bigint,
  number | string,
  string
> {
  return makeValidator<bigint, "pk", object, bigint, number | string, string>("pk", {
    parse(value, path) {
      if (typeof value !== "bigint") fail(path, "bigint (primary key)", value);
      return value;
    },
    ...decimalJson("v.primaryKey()"),
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
  const schema = {
    type: "string",
    ...(fields?.min === undefined ? {} : { minLength: fields.min }),
    ...(fields?.max === undefined ? {} : { maxLength: fields.max }),
    ...(fields?.regex === undefined ? {} : { pattern: fields.regex }),
  };
  return makeValidator<string, "string", Pick<StringValidator, "min" | "max" | "regex">>(
    "string",
    {
      parse,
      toJsonSchema: () => ({ ...schema }),
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
  const schema = kind === "int"
    ? {
        type: "integer",
        minimum: fields?.min === undefined
          ? Number.MIN_SAFE_INTEGER
          : Math.max(Number.MIN_SAFE_INTEGER, fields.min as number),
        maximum: fields?.max === undefined
          ? Number.MAX_SAFE_INTEGER
          : Math.min(Number.MAX_SAFE_INTEGER, fields.max as number),
      }
    : {
        type: "number",
        ...(fields?.min === undefined ? {} : { minimum: fields.min }),
        ...(fields?.max === undefined ? {} : { maximum: fields.max }),
      };
  return makeValidator<number, K, Pick<BoundedValidator<number, K, number>, "min" | "max">>(
    kind,
    {
      parse,
      toJsonSchema: () => ({ ...schema }),
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
): BoundedValidator<bigint, "bigint", bigint, bigint, number | string, string> {
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
  const boundsDescription = [
    fields?.min === undefined
      ? undefined
      : `Minimum bigint value (inclusive): ${String(fields.min)}.`,
    fields?.max === undefined
      ? undefined
      : `Maximum bigint value (inclusive): ${String(fields.max)}.`,
  ].filter((part): part is string => part !== undefined).join(" ");
  return makeValidator<
    bigint,
    "bigint",
    Pick<
      BoundedValidator<bigint, "bigint", bigint, bigint, number | string, string>,
      "min" | "max"
    >,
    bigint,
    number | string,
    string
  >(
    "bigint",
    {
      parse,
      ...decimalJson("v.bigint()"),
      toJsonSchema(context) {
        const schema = decimalJsonSchema(context, "v.bigint()");
        return boundsDescription === "" ? schema : { ...schema, description: boundsDescription };
      },
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
  ) as BoundedValidator<bigint, "bigint", bigint, bigint, number | string, string>;
}

export function identity(): ChainableValidator<
  Identity,
  "identity",
  Identity,
  number | string,
  string
> {
  return makeValidator<Identity, "identity", object, Identity, number | string, string>("identity", {
    parse: (value, path) => checkI64(value, path, "Identity (bigint)") as Identity,
    ...decimalJson<Identity>("v.identity()"),
    tsType: () => "Identity",
    descriptor: () => ({ k: "identity" }),
  });
}

export type FileValidator = ChainableValidator<
  FileId,
  "file",
  FileId,
  number | string,
  string
>;

export function file(): FileValidator {
  return makeValidator<FileId, "file", object, FileId, number | string, string>("file", {
    parse: (value, path) => checkI64(value, path, "FileId (bigint)") as FileId,
    ...decimalJson<FileId>("v.file()"),
    tsType: () => "FileId",
    descriptor: () => ({ k: "file" }),
  });
}

export type FileGrantValidator = ChainableValidator<
  FileGrantId,
  "fileGrant",
  FileGrantId,
  number | string,
  string
>;

export function fileGrant(): FileGrantValidator {
  return makeValidator<
    FileGrantId,
    "fileGrant",
    object,
    FileGrantId,
    number | string,
    string
  >("fileGrant", {
    parse: (value, path) => checkI64(value, path, "FileGrantId (bigint)") as FileGrantId,
    ...decimalJson<FileGrantId>("v.fileGrant()"),
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
    toJsonSchema: () => ({ type: "boolean" }),
    tsType: () => "boolean",
    descriptor: () => ({ k: "boolean" }),
  });
}

export function bytes(): ChainableValidator<
  Uint8Array,
  "bytes",
  Uint8Array,
  string,
  string
> {
  return makeValidator<Uint8Array, "bytes", object, Uint8Array, string, string>("bytes", {
    parse(value, path) {
      if (!(value instanceof Uint8Array)) fail(path, "Uint8Array", value);
      return value;
    },
    decode(value, path) {
      return this.parse(decodeBase64(value, path), path);
    },
    encode(value, path) {
      return encodeBase64(this.parse(value, path));
    },
    toJsonSchema: base64JsonSchema,
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
      toJsonSchema: () => ({
        type: "array",
        items: { type: "number" },
        minItems: size,
        maxItems: size,
      }),
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
    toJsonSchema: () => ({ type: "number" }),
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

type BigintConstraintValidator = BoundedValidator<
  bigint,
  "bigint",
  bigint,
  bigint,
  number | string,
  string
>;
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
