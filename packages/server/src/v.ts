/**
 * The `v` validator DSL. Validators describe the runtime validation, the
 * TypeScript type and the storage form of every column, argument and return
 * value in a dbzz app. They compose like Zod: validators nest inside arrays,
 * objects and unions, then finish with a nullable/optional/nullish modifier.
 */
import { encode, WireError, type Identity } from "@dbzz/core";
import {
  createStandardSchemaProperties,
  type StandardSchemaProperties,
} from "./standard-schema.ts";
import { isValidationError, ValidationError } from "./validation-error.ts";
import {
  checkArrayConstraints,
  checkBigintConstraints,
  checkNumberConstraints,
  checkStringConstraints,
  type ConstraintFields,
} from "./validator-constraints.ts";

export type { Identity } from "@dbzz/core";
export { isValidationError, ValidationError } from "./validation-error.ts";

/** JSON-serializable description of a validator, used for schema snapshots. */
export type Descriptor = { k: string } & Record<string, unknown>;

export interface Validator<T = unknown, K extends string = string, Input = T> {
  readonly kind: K;
  /** Phantom: the TypeScript type this validator admits. Never set at runtime. */
  readonly _type?: T;
  /** Phantom: the value accepted before validation and normalization. */
  readonly _inputType?: Input;
  /** Validate + normalize `value`; throws ValidationError mentioning `path`. */
  check(value: unknown, path: string): T;
  /** Literal TypeScript type text, for codegen. */
  tsType(): string;
  /** JSON descriptor, for schema snapshots and diffing. */
  descriptor(): Descriptor;
}

/** A v validator that can also describe its wire shape to external tools. */
export interface StandardValidator<T = unknown, K extends string = string, Input = T>
  extends Validator<T, K, Input> {
  readonly description?: string;
  /** Return an equivalent validator carrying human guidance for generated schemas. */
  describe(description: string): this;
  /** Dependency-free Standard Schema + Standard JSON Schema v1 contract. */
  readonly "~standard": StandardSchemaProperties<Input, T>;
}

/** An unmodified validator. Modifiers return a terminal validator surface. */
export interface ChainableValidator<T = unknown, K extends string = string, Input = T>
  extends StandardValidator<T, K, Input> {
  nullable(): NullableValidator<this>;
  optional(): OptionalValidator<this>;
  nullish(): NullishValidator<this>;
}

export interface BoundedValidator<
  T = unknown,
  K extends string = string,
  B = unknown,
  Input = T,
>
  extends ChainableValidator<T, K, Input> {
  min(bound: B): this;
  max(bound: B): this;
}

export interface StringValidator extends BoundedValidator<string, "string", number> {
  regex(pattern: RegExp): this;
}

export type InferValidator<V> = V extends Validator<infer T, string, unknown> ? T : never;
export type InferValidatorInput<V> = V extends Validator<unknown, string, infer T> ? T : never;

/**
 * Force TypeScript to *evaluate* computed types instead of displaying the
 * recipe (`RowShape<{...validators...}>`, `Omit<...> & {...}`). Every public
 * boundary (rows, inserts, patches, args, narrowed rows) goes through this,
 * so hovers read like hand-written object types. Scalars, bigints (incl.
 * the branded Identity) and bytes pass through untouched.
 */
export type Expand<T> = T extends bigint | string | number | boolean | null | undefined | Uint8Array
  ? T
  : T extends readonly (infer E)[]
    ? Expand<E>[]
    : T extends object
      ? { [K in keyof T]: Expand<T[K]> }
      : T;

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (value instanceof Uint8Array) return "bytes";
  return typeof value;
}

function fail(path: string, expected: string, value: unknown): never {
  throw new ValidationError(`${path}: expected ${expected}, got ${describe(value)}`);
}

const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;

type ModifierMode = "available" | "blocked" | "none";

function makeValidator<
  T,
  K extends string,
  Extra extends object = object,
  Input = T,
>(
  kind: K,
  impl: Pick<Validator<T, K, Input>, "check" | "tsType" | "descriptor">,
  extra?: Extra,
  modifierMode: ModifierMode = "available",
  description?: string,
  prototype?: object,
): ChainableValidator<T, K, Input> & Extra {
  const validator = {
    __proto__: prototype ?? Object.prototype,
    kind,
    ...impl,
    ...extra,
    ...(description === undefined ? {} : { description }),
  } as unknown as ChainableValidator<T, K, Input> & Extra;
  Object.defineProperties(validator, {
    describe: {
      value(this: ChainableValidator<T, K, Input> & Extra, nextDescription: string) {
        if (typeof nextDescription !== "string" || nextDescription.trim() === "") {
          throw new ValidationError("validator description must be a non-empty string");
        }
        return makeValidator<T, K, Extra, Input>(
          kind,
          impl,
          extra,
          modifierMode,
          nextDescription.trim(),
          prototype,
        );
      },
    },
    "~standard": {
      value: createStandardSchemaProperties<Input, T>(validator, isValidationError),
    },
  });
  if (modifierMode !== "none") {
    const defineModifier = (name: "nullable" | "optional" | "nullish") => {
      Object.defineProperty(validator, name, {
        value: modifierMode === "available"
          ? () => modified(validator, name)
          : () => {
              throw new ValidationError(
                `${kind} validator is already modified; redundant modifier combinations are not allowed — use .nullish() for nullable optional input`,
              );
            },
      });
    };
    defineModifier("nullable");
    defineModifier("optional");
    defineModifier("nullish");
  }
  return validator;
}

function primaryKey(): StandardValidator<bigint, "pk"> {
  return makeValidator("pk", {
    check(value, path) {
      if (typeof value !== "bigint") fail(path, "bigint (primary key)", value);
      return value;
    },
    tsType: () => "bigint",
    descriptor: () => ({ k: "pk" }),
  }, undefined, "none");
}

interface Bounds<B extends number | bigint> {
  readonly min?: B;
  readonly max?: B;
}

interface StringConstraints extends Bounds<number> {
  readonly regex?: { readonly source: string; readonly compiled: RegExp };
}

function lengthBound(bound: number, method: "min" | "max", kind: "string" | "array"): number {
  if (!Number.isSafeInteger(bound) || bound < 0) {
    throw new ValidationError(
      `v.${kind}().${method}(): bound must be a non-negative safe integer`,
    );
  }
  return Object.is(bound, -0) ? 0 : bound;
}

function nextBounds<B extends number | bigint>(
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

function checkString(value: unknown, path: string): string {
  if (typeof value !== "string") fail(path, "string", value);
  return value;
}

function string(
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
  const check = constraints === undefined
    ? checkString
    : (value: unknown, path: string): string => {
      const checked = checkString(value, path);
      checkStringConstraints(fields!, checked, path, constraints.regex?.compiled);
      return checked;
    };
  return makeValidator<string, "string", Pick<StringValidator, "min" | "max" | "regex">>(
    "string",
    {
      check,
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

function finiteBound(bound: number, method: "min" | "max", kind: "int" | "float"): number {
  if (!Number.isFinite(bound)) {
    throw new ValidationError(`v.${kind}().${method}(): bound must be a finite number`);
  }
  return Object.is(bound, -0) ? 0 : bound;
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
  const check = constraints === undefined
    ? baseCheck
    : (value: unknown, path: string): number => {
      const checked = baseCheck(value, path);
      checkNumberConstraints(fields!, checked, path);
      return checked;
    };
  return makeValidator<number, K, Pick<BoundedValidator<number, K, number>, "min" | "max">>(
    kind,
    {
      check,
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

function int(): BoundedValidator<number, "int", number> {
  return boundedNumber("int", checkInt);
}

function float(): BoundedValidator<number, "float", number> {
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

/** @internal Base-check identities for the one sanctioned structural test; not in the package barrel. */
export const validatorBaseChecksForTest = Object.freeze({
  string: checkString,
  int: checkInt,
  float: checkFloat,
  bigint: checkBigint,
});

function bigintBound(bound: bigint, method: "min" | "max"): void {
  if (typeof bound !== "bigint" || bound < I64_MIN || bound > I64_MAX) {
    throw new ValidationError(
      `v.bigint().${method}(): bound must be a bigint within the signed 64-bit range`,
    );
  }
}

function bigint(
  constraints?: Bounds<bigint>,
  description?: string,
): BoundedValidator<bigint, "bigint", bigint> {
  const fields: ConstraintFields | undefined = constraints === undefined
    ? undefined
    : {
      ...(constraints.min === undefined ? {} : { min: constraints.min.toString() }),
      ...(constraints.max === undefined ? {} : { max: constraints.max.toString() }),
    };
  const check = constraints === undefined
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
      check,
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

function identity(): ChainableValidator<Identity, "identity"> {
  return makeValidator("identity", {
    check: (value, path) => checkI64(value, path, "Identity (bigint)") as Identity,
    tsType: () => "Identity",
    descriptor: () => ({ k: "identity" }),
  });
}

function boolean(): ChainableValidator<boolean, "boolean"> {
  return makeValidator("boolean", {
    check(value, path) {
      if (typeof value !== "boolean") fail(path, "boolean", value);
      return value;
    },
    tsType: () => "boolean",
    descriptor: () => ({ k: "boolean" }),
  });
}

function bytes(): ChainableValidator<Uint8Array, "bytes"> {
  return makeValidator("bytes", {
    check(value, path) {
      if (!(value instanceof Uint8Array)) fail(path, "Uint8Array", value);
      return value;
    },
    tsType: () => "Uint8Array",
    descriptor: () => ({ k: "bytes" }),
  });
}

function scheduleAt(): StandardValidator<number, "scheduleAt"> {
  return makeValidator("scheduleAt", {
    check(value, path) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        fail(path, "timestamp (finite number)", value);
      }
      return value;
    },
    tsType: () => "number",
    descriptor: () => ({ k: "scheduleAt" }),
  }, undefined, "none");
}

/** Parenthesize type text when embedding it in `T[]`. */
function parenthesize(ts: string): string {
  return ts.includes("|") || ts.includes("&") ? `(${ts})` : ts;
}

export interface ArrayValidator<
  V extends StandardValidator<unknown, string> = StandardValidator<unknown, string>,
>
  extends BoundedValidator<InferValidator<V>[], "array", number, InferValidatorInput<V>[]> {
  readonly element: V;
}

function array<V extends StandardValidator<unknown, string>>(
  element: V,
  constraints?: Bounds<number>,
  description?: string,
  baseCheck: (value: unknown, path: string) => InferValidator<V>[] = (value, path) => {
    if (!Array.isArray(value)) fail(path, "array", value);
    return value.map((item, i) => element.check(item, `${path}[${i}]`)) as InferValidator<V>[];
  },
): ArrayValidator<V> {
  const fields: ConstraintFields | undefined = constraints === undefined
    ? undefined
    : {
      ...(constraints.min === undefined ? {} : { min: constraints.min }),
      ...(constraints.max === undefined ? {} : { max: constraints.max }),
    };
  const check = constraints === undefined
    ? baseCheck
    : (value: unknown, path: string): InferValidator<V>[] => {
      if (!Array.isArray(value)) fail(path, "array", value);
      checkArrayConstraints(fields!, value.length, path);
      return value.map((item, i) => element.check(item, `${path}[${i}]`)) as InferValidator<V>[];
    };
  return makeValidator<
    InferValidator<V>[],
    "array",
    Pick<ArrayValidator<V>, "element">,
    InferValidatorInput<V>[]
  >(
    "array",
    {
      check,
      tsType: () => `${parenthesize(element.tsType())}[]`,
      descriptor: () => ({
        k: "array",
        el: element.descriptor(),
        ...fields,
      }),
    },
    { element },
    "available",
    description,
    ARRAY_CONSTRAINT_PROTOTYPE,
  ) as ArrayValidator<V>;
}

function validatorPrototype<T extends object>(methods: T): T {
  const prototype = Object.create(Object.prototype) as T;
  for (const [name, method] of Object.entries(methods)) {
    Object.defineProperty(prototype, name, { value: method });
  }
  return Object.freeze(prototype);
}

function numberBounds(descriptor: Descriptor): Bounds<number> {
  return {
    ...(descriptor["min"] === undefined ? {} : { min: descriptor["min"] as number }),
    ...(descriptor["max"] === undefined ? {} : { max: descriptor["max"] as number }),
  };
}

function bigintBounds(descriptor: Descriptor): Bounds<bigint> {
  return {
    ...(descriptor["min"] === undefined ? {} : { min: BigInt(descriptor["min"] as string) }),
    ...(descriptor["max"] === undefined ? {} : { max: BigInt(descriptor["max"] as string) }),
  };
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

const ARRAY_CONSTRAINT_PROTOTYPE = validatorPrototype({
  min(this: ArrayValidator, bound: number): ArrayValidator {
    const normalized = lengthBound(bound, "min", "array");
    return array(
      this.element,
      nextBounds("array", numberBounds(this.descriptor()), "min", normalized),
      this.description,
    );
  },
  max(this: ArrayValidator, bound: number): ArrayValidator {
    const normalized = lengthBound(bound, "max", "array");
    return array(
      this.element,
      nextBounds("array", numberBounds(this.descriptor()), "max", normalized),
      this.description,
    );
  },
});

export type ObjectShape = Record<string, StandardValidator<unknown, string>>;
type OmissibleShapeKey<S extends ObjectShape> = {
  [K in keyof S]: S[K] extends Validator<unknown, "optional" | "nullish", unknown> ? K : never;
}[keyof S];
export type InferShape<S extends ObjectShape> = {
  [K in Exclude<keyof S, OmissibleShapeKey<S>>]: InferValidator<S[K]>;
} & {
  [K in OmissibleShapeKey<S>]?: InferValidator<S[K]>;
};
export type InferInputShape<S extends ObjectShape> = {
  [K in Exclude<keyof S, OmissibleShapeKey<S>>]: InferValidatorInput<S[K]>;
} & {
  [K in OmissibleShapeKey<S>]?: InferValidatorInput<S[K]>;
};

interface CompiledShapeField {
  readonly key: string;
  readonly validator: StandardValidator<unknown, string>;
  readonly omissible: boolean;
}

function ownShape<S extends ObjectShape>(shape: S): S {
  const owned: ObjectShape = Object.create(null) as ObjectShape;
  for (const key of Object.keys(shape)) owned[key] = shape[key]!;
  return Object.freeze(owned) as S;
}

function setOwnField(record: Record<string, unknown>, key: string, value: unknown): void {
  if (key !== "__proto__") {
    record[key] = value;
    return;
  }
  Object.defineProperty(record, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

/** Compile one strict, presence-preserving object validator from a shape. */
export function compileShape<S extends ObjectShape>(
  shape: S,
): (value: unknown, path: string) => InferShape<S> {
  const knownKeys: Record<string, true> = Object.create(null);
  const fields = Object.keys(shape).map((key): CompiledShapeField => {
    const field = shape[key]!;
    knownKeys[key] = true;
    return {
      key,
      validator: field,
      omissible: field.kind === "optional" || field.kind === "nullish",
    };
  });

  return (value, path) => {
    if (value === null || typeof value !== "object" || Array.isArray(value) || value instanceof Uint8Array) {
      fail(path, "object", value);
    }
    const input = value as Record<string, unknown>;
    for (const key of Object.keys(input)) {
      if (knownKeys[key] !== true && input[key] !== undefined) {
        throw new ValidationError(`${path}: unknown field "${key}"`);
      }
    }
    const out: Record<string, unknown> = {};
    for (const field of fields) {
      const present = Object.hasOwn(input, field.key);
      if (!present && field.omissible) continue;
      setOwnField(
        out,
        field.key,
        field.validator.check(present ? input[field.key] : undefined, `${path}.${field.key}`),
      );
    }
    return out as InferShape<S>;
  };
}

/** One-shot convenience for callers that do not retain a compiled shape. */
export function checkShape<S extends ObjectShape>(
  shape: S,
  value: unknown,
  path: string,
): InferShape<S> {
  return compileShape(shape)(value, path);
}

export interface ObjectValidator<S extends ObjectShape = ObjectShape>
  extends ChainableValidator<InferShape<S>, "object", InferInputShape<S>> {
  readonly shape: S;
}

function object<S extends ObjectShape>(shape: S): ObjectValidator<S> {
  // Own one immutable DSL shape for runtime validation and every projection.
  // Compile its hot-path keys and omission bits once without splitting that
  // contract or changing the receiver of a structural validator's check.
  const ownedShape = ownShape(shape);
  const check = compileShape(ownedShape);
  return makeValidator<
    InferShape<S>,
    "object",
    { readonly shape: S },
    InferInputShape<S>
  >(
    "object",
    {
      check,
      tsType() {
        const fields = Object.keys(ownedShape).map((k) => {
          const field = ownedShape[k]!;
          const optional = field.kind === "optional" || field.kind === "nullish" ? "?" : "";
          return `${k}${optional}: ${field.tsType()}`;
        });
        return `{ ${fields.join("; ")} }`;
      },
      descriptor() {
        const fields: Record<string, Descriptor> = {};
        for (const key of Object.keys(ownedShape)) {
          setOwnField(fields, key, ownedShape[key]!.descriptor());
        }
        return { k: "object", shape: fields };
      },
    },
    { shape: ownedShape },
  );
}

export interface EnumValidator<V extends string = string>
  extends ChainableValidator<V, "enum"> {
  readonly name: string;
  readonly values: readonly V[];
}

function enum_<const V extends readonly [string, ...string[]]>(
  name: string,
  values: V,
): EnumValidator<V[number]> {
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    values.some((value) => typeof value !== "string")
  ) {
    throw new ValidationError(`enum ${name}: values must be a non-empty array of strings`);
  }
  if (new Set(values).size !== values.length) {
    throw new ValidationError(`enum ${name}: duplicate variants`);
  }
  const ownedValues = Object.freeze([...values]) as readonly V[number][];
  return makeValidator<
    V[number],
    "enum",
    { readonly name: string; readonly values: readonly V[number][] }
  >(
    "enum",
    {
      check(value, path) {
        if (typeof value !== "string" || !ownedValues.includes(value)) {
          const got = typeof value === "string" ? JSON.stringify(value) : describe(value);
          throw new ValidationError(
            `${path}: expected one of ${ownedValues.map((v) => JSON.stringify(v)).join(" | ")} (${name}), got ${got}`,
          );
        }
        return value as V[number];
      },
      tsType: () => name,
      descriptor: () => ({ k: "enum", name, values: [...ownedValues] }),
    },
    { name, values: ownedValues },
  );
}

type LiteralValue = string | number | boolean | bigint;

export interface LiteralValidator<V extends LiteralValue = LiteralValue>
  extends ChainableValidator<V, "literal"> {
  readonly value: V;
}

function literal<const V extends LiteralValue>(value: V): LiteralValidator<V> {
  return makeValidator<V, "literal", { readonly value: V }>(
    "literal",
    {
      check(input, path) {
        if (input !== value) fail(path, literalTs(value), input);
        return value;
      },
      tsType: () => literalTs(value),
      descriptor: () => ({ k: "literal", v: JSON.parse(encode(value)) }),
    },
    { value },
  );
}

function literalTs(value: LiteralValue): string {
  if (typeof value === "bigint") return `${value}n`;
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

function tag(): StandardValidator<null, "tag"> {
  return makeValidator("tag", {
    check(value, path) {
      if (value !== null && value !== undefined) fail(path, "null (payload-less variant)", value);
      return null;
    },
    tsType: () => "null",
    descriptor: () => ({ k: "tag" }),
  }, undefined, "none");
}

export type UnionMembers = Record<string, StandardValidator<unknown, string>>;

export type UnionValue<M extends UnionMembers> = {
  [K in keyof M & string]: M[K] extends Validator<unknown, "optional" | "nullish", unknown>
    ? { tag: K; value?: InferValidator<M[K]> }
    : { tag: K; value: InferValidator<M[K]> };
}[keyof M & string];

export type UnionInput<M extends UnionMembers> = {
  [K in keyof M & string]: M[K] extends Validator<unknown, "tag", unknown>
    ? { tag: K; value?: null }
    : M[K] extends Validator<unknown, "optional" | "nullish", unknown>
      ? { tag: K; value?: InferValidatorInput<M[K]> }
      : { tag: K; value: InferValidatorInput<M[K]> };
}[keyof M & string];

export type UnionNamespace<M extends UnionMembers> = {
  [K in keyof M & string]: M[K] extends Validator<null, "tag">
    ? () => { tag: K; value: null }
    : (value: InferValidator<M[K]>) => { tag: K; value: InferValidator<M[K]> };
};

export interface UnionValidator<M extends UnionMembers = UnionMembers>
  extends ChainableValidator<UnionValue<M>, "union", UnionInput<M>> {
  readonly name: string;
  readonly members: M;
  /** Runtime variant constructors: `MessagePayload.text("hi")`. */
  readonly union: UnionNamespace<M>;
  /** Phantom: `typeof myUnion.type` is the discriminated union type. */
  readonly type: UnionValue<M>;
}

function union<M extends UnionMembers>(name: string, members: M): UnionValidator<M> {
  const variantNames = Object.keys(members);
  if (variantNames.length === 0) throw new ValidationError(`union ${name}: no variants`);
  const namespace: Record<string, (value?: unknown) => unknown> = {};
  for (const variant of variantNames) {
    setOwnField(
      namespace,
      variant,
      members[variant]!.kind === "tag"
        ? () => ({ tag: variant, value: null })
        : (value: unknown) => ({ tag: variant, value }),
    );
  }
  return makeValidator<
    UnionValue<M>,
    "union",
    {
      readonly name: string;
      readonly members: M;
      readonly union: UnionNamespace<M>;
      readonly type: UnionValue<M>;
    },
    UnionInput<M>
  >(
    "union",
    {
      check(value, path) {
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
          fail(path, `${name} ({ tag, value })`, value);
        }
        const input = value as Record<string, unknown>;
        const variant = input["tag"];
        if (typeof variant !== "string" || !Object.hasOwn(members, variant)) {
          throw new ValidationError(
            `${path}.tag: expected one of ${variantNames.map((v) => JSON.stringify(v)).join(" | ")}, got ${describe(variant) === "string" ? JSON.stringify(variant) : describe(variant)}`,
          );
        }
        for (const key of Object.keys(input)) {
          if (key !== "tag" && key !== "value" && input[key] !== undefined) {
            throw new ValidationError(`${path}: unknown field "${key}" on union value`);
          }
        }
        const member = members[variant]!;
        if (
          !Object.hasOwn(input, "value") &&
          (member.kind === "optional" || member.kind === "nullish")
        ) {
          return { tag: variant } as UnionValue<M>;
        }
        const payload = member.check(input["value"], `${path}.value`);
        return { tag: variant, value: payload } as UnionValue<M>;
      },
      tsType: () => name,
      descriptor() {
        const memberDesc: Record<string, Descriptor> = {};
        for (const variant of variantNames) {
          setOwnField(memberDesc, variant, members[variant]!.descriptor());
        }
        return { k: "union", name, members: memberDesc };
      },
    },
    {
      name,
      members,
      union: namespace as UnionNamespace<M>,
      type: undefined as unknown as UnionValue<M>,
    },
  );
}

function jsonb<T>(): ChainableValidator<T, "jsonb"> {
  return makeValidator("jsonb", {
    check(value, path) {
      if (value === undefined) fail(path, "JSON value", value);
      try {
        encode(value);
      } catch (error) {
        if (error instanceof WireError) {
          throw new ValidationError(`${path}: not wire-encodable: ${error.message}`);
        }
        throw error;
      }
      return value as T;
    },
    // T is erased at runtime; row-level jsonb types flow through the schema's
    // TypeScript type instead (RowOf<Schema, ...> in generated types).
    tsType: () => "unknown",
    descriptor: () => ({ k: "jsonb" }),
  });
}

export interface NullableValidator<
  V extends StandardValidator<unknown, string> = StandardValidator<unknown, string>,
>
  extends StandardValidator<
    InferValidator<V> | null,
    "nullable",
    InferValidatorInput<V> | null
  > {
  readonly inner: V;
}

export interface OptionalValidator<
  V extends StandardValidator<unknown, string> = StandardValidator<unknown, string>,
>
  extends StandardValidator<
    InferValidator<V> | undefined,
    "optional",
    InferValidatorInput<V> | undefined
  > {
  readonly inner: V;
}

export interface NullishValidator<
  V extends StandardValidator<unknown, string> = StandardValidator<unknown, string>,
>
  extends StandardValidator<
    InferValidator<V> | null | undefined,
    "nullish",
    InferValidatorInput<V> | null | undefined
  > {
  readonly inner: V;
}

type ModifiedValidator<V extends StandardValidator<unknown, string>, K extends "nullable" | "optional" | "nullish"> =
  K extends "nullable"
    ? NullableValidator<V>
    : K extends "optional"
      ? OptionalValidator<V>
      : NullishValidator<V>;

function modified<
  V extends StandardValidator<unknown, string>,
  K extends "nullable" | "optional" | "nullish",
>(inner: V, kind: K): ModifiedValidator<V, K> {
  if (inner.kind === "nullable" || inner.kind === "optional" || inner.kind === "nullish") {
    throw new ValidationError(
      `${inner.kind} validator is already modified; redundant modifier combinations are not allowed — use .nullish() for nullable optional input`,
    );
  }
  if (inner.kind === "pk" || inner.kind === "scheduleAt" || inner.kind === "tag") {
    throw new ValidationError(`${inner.kind} cannot be ${kind}`);
  }
  const acceptsNull = kind === "nullable" || kind === "nullish";
  const acceptsUndefined = kind === "optional" || kind === "nullish";
  const suffix = kind === "nullable"
    ? " | null"
    : kind === "optional"
      ? " | undefined"
      : " | null | undefined";
  return makeValidator<
    InferValidator<V> | null | undefined,
    K,
    { readonly inner: V },
    InferValidatorInput<V> | null | undefined
  >(
    kind,
    {
      check(value, path) {
        if (value === null && acceptsNull) return null;
        if (value === undefined && acceptsUndefined) return undefined;
        return inner.check(value, path) as InferValidator<V>;
      },
      tsType: () => `${inner.tsType()}${suffix}`,
      descriptor: () => ({ k: kind, inner: inner.descriptor() }),
    },
    { inner },
    "blocked",
  ) as unknown as ModifiedValidator<V, K>;
}

export const v = {
  primaryKey,
  string,
  int,
  float,
  bigint,
  identity,
  boolean,
  bytes,
  array,
  object,
  enum: enum_,
  literal,
  union,
  tag,
  jsonb,
  scheduleAt,
};
