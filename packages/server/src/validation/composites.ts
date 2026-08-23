/** The `v` validators that compose other validators: arrays, objects, unions. */
import { encode, WireError } from "@ackerdb/core";
import { refuseUnknownKeys, ValidationError } from "./error.ts";
import { lengthBound, nextBounds, numberBounds, type Bounds } from "./bounds.ts";
import { checkArrayConstraints, type ConstraintFields } from "./constraints.ts";
import {
  describe,
  fail,
  makeValidator,
  validatorPrototype,
  type BoundedValidator,
  type ChainableValidator,
  type Descriptor,
  type InferValidator,
  type InferValidatorInput,
  type InferValidatorJsonInput,
  type InferValidatorJsonOutput,
  type StandardValidator,
  type Validator,
} from "./validator.ts";
import {
  requireJsonProtocol,
  type JsonSchema,
} from "./json-schema.ts";

/** Parenthesize type text when embedding it in `T[]`. */
function parenthesize(ts: string): string {
  return ts.includes("|") || ts.includes("&") ? `(${ts})` : ts;
}

export interface ArrayValidator<
  V extends StandardValidator<unknown, string> = StandardValidator<unknown, string>,
>
  extends BoundedValidator<
    InferValidator<V>[],
    "array",
    number,
    InferValidatorInput<V>[],
    InferValidatorJsonInput<V>[],
    InferValidatorJsonOutput<V>[]
  > {
  readonly element: V;
}

export function array<V extends StandardValidator<unknown, string>>(
  element: V,
  constraints?: Bounds<number>,
  description?: string,
  baseCheck: (value: unknown, path: string) => InferValidator<V>[] = (value, path) => {
    if (!Array.isArray(value)) fail(path, "array", value);
    return value.map((item, i) => element.parse(item, `${path}[${i}]`)) as InferValidator<V>[];
  },
): ArrayValidator<V> {
  const fields: ConstraintFields | undefined = constraints === undefined
    ? undefined
    : {
      ...(constraints.min === undefined ? {} : { min: constraints.min }),
      ...(constraints.max === undefined ? {} : { max: constraints.max }),
    };
  const parse = constraints === undefined
    ? baseCheck
    : (value: unknown, path: string): InferValidator<V>[] => {
      if (!Array.isArray(value)) fail(path, "array", value);
      checkArrayConstraints(fields!, value.length, path);
      return value.map((item, i) => element.parse(item, `${path}[${i}]`)) as InferValidator<V>[];
    };
  const checkContainer = (value: unknown, path: string): unknown[] => {
    if (!Array.isArray(value)) fail(path, "array", value);
    if (fields !== undefined) checkArrayConstraints(fields, value.length, path);
    return value;
  };
  return makeValidator<
    InferValidator<V>[],
    "array",
    Pick<ArrayValidator<V>, "element">,
    InferValidatorInput<V>[],
    InferValidatorJsonInput<V>[],
    InferValidatorJsonOutput<V>[]
  >(
    "array",
    {
      parse,
      decode(value, path) {
        return checkContainer(value, path).map(
          (item, index) => element.decode(item, `${path}[${index}]`),
        ) as InferValidator<V>[];
      },
      encode(value, path) {
        return checkContainer(value, path).map(
          (item, index) => element.encode(item, `${path}[${index}]`),
        ) as InferValidatorJsonOutput<V>[];
      },
      toJsonSchema(context) {
        return {
          type: "array",
          items: element.toJsonSchema({ ...context, path: `${context.path}[]` }),
          ...(fields?.min === undefined ? {} : { minItems: fields.min }),
          ...(fields?.max === undefined ? {} : { maxItems: fields.max }),
        };
      },
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
export type InferJsonInputShape<S extends ObjectShape> = {
  [K in Exclude<keyof S, OmissibleShapeKey<S>>]: InferValidatorJsonInput<S[K]>;
} & {
  [K in OmissibleShapeKey<S>]?: InferValidatorJsonInput<S[K]>;
};
export type InferJsonOutputShape<S extends ObjectShape> = {
  [K in Exclude<keyof S, OmissibleShapeKey<S>>]: InferValidatorJsonOutput<S[K]>;
} & {
  [K in OmissibleShapeKey<S>]?: InferValidatorJsonOutput<S[K]>;
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

export interface ObjectValidator<S extends ObjectShape = ObjectShape>
  extends ChainableValidator<
    InferShape<S>,
    "object",
    InferInputShape<S>,
    InferJsonInputShape<S>,
    InferJsonOutputShape<S>
  > {
  readonly shape: S;
}

export function object<S extends ObjectShape>(shape: S): ObjectValidator<S> {
  // Own one immutable DSL shape for runtime validation and every projection.
  // Compile its hot-path keys and omission bits once without splitting that
  // contract or changing the receiver of a structural validator's parser.
  const ownedShape = ownShape(shape);
  const knownKeys: Record<string, true> = Object.create(null);
  const fields = Object.keys(ownedShape).map((key): CompiledShapeField => {
    const field = ownedShape[key]!;
    knownKeys[key] = true;
    return {
      key,
      validator: field,
      omissible: field.kind === "optional" || field.kind === "nullish",
    };
  });
  const parse = (value: unknown, path: string): InferShape<S> => {
    const input = inputRecord(value, path, false);
    const out: Record<string, unknown> = {};
    for (const field of fields) {
      const present = Object.hasOwn(input, field.key);
      if (!present && field.omissible) continue;
      setOwnField(
        out,
        field.key,
        field.validator.parse(present ? input[field.key] : undefined, `${path}.${field.key}`),
      );
    }
    return out as InferShape<S>;
  };
  const inputRecord = (
    value: unknown,
    path: string,
    standardJson: boolean,
  ): Record<string, unknown> => {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      value instanceof Uint8Array ||
      (standardJson && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    ) {
      fail(path, "object", value);
    }
    const input = value as Record<string, unknown>;
    refuseUnknownKeys(input, (key) => knownKeys[key] === true, path);
    return input;
  };
  return makeValidator<
    InferShape<S>,
    "object",
    { readonly shape: S },
    InferInputShape<S>,
    InferJsonInputShape<S>,
    InferJsonOutputShape<S>
  >(
    "object",
    {
      parse,
      decode(value, path) {
        const input = inputRecord(value, path, true);
        const decoded: Record<string, unknown> = {};
        for (const field of fields) {
          if (!Object.hasOwn(input, field.key)) {
            if (field.omissible) continue;
            throw new ValidationError(`${path}.${field.key}: required input field is missing`);
          }
          setOwnField(
            decoded,
            field.key,
            field.validator.decode(input[field.key], `${path}.${field.key}`),
          );
        }
        return decoded as InferShape<S>;
      },
      encode(value, path) {
        const input = inputRecord(value, path, false);
        const encoded = Object.create(null) as Record<string, unknown>;
        for (const field of fields) {
          if (
            field.omissible &&
            (!Object.hasOwn(input, field.key) || input[field.key] === undefined)
          ) {
            continue;
          }
          if (!Object.hasOwn(input, field.key)) {
            throw new ValidationError(`${path}.${field.key}: required output field is missing`);
          }
          setOwnField(
            encoded,
            field.key,
            field.validator.encode(
              input[field.key],
              `${path}.${field.key}`,
            ),
          );
        }
        return encoded as InferJsonOutputShape<S>;
      },
      toJsonSchema(context) {
        const properties = Object.create(null) as Record<string, JsonSchema>;
        const required: string[] = [];
        for (const field of fields) {
          setOwnField(
            properties,
            field.key,
            field.validator.toJsonSchema({
              ...context,
              path: `${context.path}.${field.key}`,
            }),
          );
          if (!field.omissible) required.push(field.key);
        }
        return {
          type: "object",
          properties,
          ...(required.length === 0 ? {} : { required }),
          additionalProperties: false,
        };
      },
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

export function enum_<const V extends readonly [string, ...string[]]>(
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
      parse(value, path) {
        if (typeof value !== "string" || !ownedValues.includes(value)) {
          const got = typeof value === "string" ? JSON.stringify(value) : describe(value);
          throw new ValidationError(
            `${path}: expected one of ${ownedValues.map((v) => JSON.stringify(v)).join(" | ")} (${name}), got ${got}`,
          );
        }
        return value as V[number];
      },
      toJsonSchema: () => ({ type: "string", enum: [...ownedValues] }),
      tsType: () => name,
      descriptor: () => ({ k: "enum", name, values: [...ownedValues] }),
    },
    { name, values: ownedValues },
  );
}

export type LiteralValue = string | number | boolean | bigint;
type LiteralJson<V extends LiteralValue> = V extends bigint ? `${V}` : V;

export interface LiteralValidator<V extends LiteralValue = LiteralValue>
  extends ChainableValidator<V, "literal", V, LiteralJson<V>, LiteralJson<V>> {
  readonly value: V;
}

export function literal<const V extends LiteralValue>(value: V): LiteralValidator<V> {
  const jsonValue = typeof value === "bigint" ? value.toString() : value;
  return makeValidator<
    V,
    "literal",
    { readonly value: V },
    V,
    LiteralJson<V>,
    LiteralJson<V>
  >(
    "literal",
    {
      parse(input, path) {
        if (input !== value) fail(path, literalTs(value), input);
        return value;
      },
      decode(input, path) {
        if (typeof value !== "bigint") return this.parse(input, path);
        if (input !== jsonValue) {
          throw new ValidationError(
            `${path}: expected ${JSON.stringify(jsonValue)}, got ${describe(input)}`,
          );
        }
        return this.parse(value, path);
      },
      encode(input, path) {
        this.parse(input, path);
        if (typeof value === "number" && !Number.isFinite(value)) {
          throw new TypeError(`${path}: v.literal(${String(value)}) has no Standard JSON value`);
        }
        return jsonValue as LiteralJson<V>;
      },
      toJsonSchema(context) {
        if (typeof value === "bigint") {
          requireJsonProtocol(context, "v.literal(bigint)");
        } else if (typeof value === "number" && !Number.isFinite(value)) {
          throw new TypeError(`${context.path}: v.literal(${String(value)}) has no Standard JSON value`);
        }
        return { const: jsonValue };
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

type DiscriminatedMembers = readonly [ObjectValidator<any>, ObjectValidator<any>, ...ObjectValidator<any>[]];

type ValidDiscriminatedMembers<
  D extends string,
  M extends DiscriminatedMembers,
> = {
  readonly [I in keyof M]: M[I] extends ObjectValidator<infer S>
    ? D extends keyof S
      ? S[D] extends LiteralValidator<string>
        ? M[I]
        : never
      : never
    : never;
};

export interface DiscriminatedUnionValidator<
  D extends string = string,
  M extends DiscriminatedMembers = DiscriminatedMembers,
> extends ChainableValidator<
    InferValidator<M[number]>,
    "discriminatedUnion",
    InferValidatorInput<M[number]>,
    InferValidatorJsonInput<M[number]>,
    InferValidatorJsonOutput<M[number]>
> {
  /** Optional generated TypeScript alias. It is not part of schema or storage identity. */
  readonly codegenName?: string;
  readonly discriminator: D;
  readonly members: M;
  readonly hasDiscriminatorValue: (value: string) => boolean;
}

export function discriminatedUnion<
  const D extends string,
  const M extends DiscriminatedMembers,
>(
  discriminator: D,
  members: M & ValidDiscriminatedMembers<D, M>,
  codegenName?: string,
): DiscriminatedUnionValidator<D, M> {
  const ownedMembers = Object.freeze([...members]) as unknown as M;
  const memberByDiscriminator = new Map<string, ObjectValidator<any>>();
  for (const member of ownedMembers) {
    const literal = member.shape[discriminator] as LiteralValidator;
    if (literal === undefined || literal.kind !== "literal" || typeof literal.value !== "string") {
      throw new ValidationError(
        `v.discriminatedUnion(${JSON.stringify(discriminator)}, ...): every member must have a string-literal discriminator`,
      );
    }
    if (memberByDiscriminator.has(literal.value)) {
      throw new ValidationError(
        `v.discriminatedUnion(${JSON.stringify(discriminator)}, ...): duplicate discriminator ${literalTs(literal.value)}`,
      );
    }
    memberByDiscriminator.set(literal.value, member);
  }
  const inputRecord = (value: unknown, path: string): Record<string, unknown> => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      fail(path, "discriminated union object", value);
    }
    return value as Record<string, unknown>;
  };
  const unknownDiscriminator = (value: unknown, path: string): never => {
    const expected = [...memberByDiscriminator.keys()].map(literalTs).join(" | ");
    throw new ValidationError(
      `${path}.${discriminator}: expected one of ${expected}, got ${describe(value)}`,
    );
  };
  const memberFor = (value: unknown, path: string): ObjectValidator<any> => {
    const input = inputRecord(value, path);
    return typeof input[discriminator] === "string"
      ? memberByDiscriminator.get(input[discriminator]) ?? unknownDiscriminator(input[discriminator], path)
      : unknownDiscriminator(input[discriminator], path);
  };
  const validator = makeValidator<
    InferValidator<M[number]>,
    "discriminatedUnion",
    {
      readonly codegenName?: string;
      readonly discriminator: D;
      readonly members: M;
      readonly hasDiscriminatorValue: (value: string) => boolean;
    },
    InferValidatorInput<M[number]>,
    InferValidatorJsonInput<M[number]>,
    InferValidatorJsonOutput<M[number]>
  >(
    "discriminatedUnion",
    {
      parse(value, path) {
        return memberFor(value, path).parse(value, path) as InferValidator<M[number]>;
      },
      decode(value, path) {
        return memberFor(value, path).decode(value, path) as InferValidator<M[number]>;
      },
      encode(value, path) {
        return memberFor(value, path).encode(value, path) as InferValidatorJsonOutput<M[number]>;
      },
      toJsonSchema(context) {
        return {
          oneOf: ownedMembers.map((member, index) =>
            member.toJsonSchema({
              ...context,
              path: `${context.path}[${index}]`,
            })
          ),
        };
      },
      tsType: () => codegenName ?? ownedMembers.map((member) => member.tsType()).join(" | "),
      descriptor: () => ({
        k: "discriminatedUnion",
        discriminator,
        members: Object.fromEntries(
          [...memberByDiscriminator].map(([value, member]) => [value, member.descriptor()]),
        ),
      }),
    },
    {
      ...(codegenName === undefined ? {} : { codegenName }),
      discriminator,
      members: ownedMembers,
      hasDiscriminatorValue: (value) => memberByDiscriminator.has(value),
    },
  );
  return validator;
}

export function jsonb<T>(): ChainableValidator<T, "jsonb"> {
  return makeValidator("jsonb", {
    parse(value, path) {
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
    decode: (value) => value as T,
    encode: (value) => value,
    toJsonSchema: () => ({}),
    // T is erased at runtime; row-level jsonb types flow through the schema's
    // TypeScript type instead (RowOf<Schema, ...> in generated types).
    tsType: () => "unknown",
    descriptor: () => ({ k: "jsonb" }),
  });
}
