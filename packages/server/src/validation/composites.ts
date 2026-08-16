/** The `v` validators that compose other validators: arrays, objects, unions. */
import { encode, WireError } from "@ackerdb/core";
import { refuseUnknownKeys, refuseUnknownUnionKeys, ValidationError } from "./error.ts";
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
  type StandardValidator,
  type Validator,
} from "./validator.ts";

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

export function array<V extends StandardValidator<unknown, string>>(
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
    refuseUnknownKeys(input, (key) => knownKeys[key] === true, path);
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

export function object<S extends ObjectShape>(shape: S): ObjectValidator<S> {
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

export function literal<const V extends LiteralValue>(value: V): LiteralValidator<V> {
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

export function tag(): StandardValidator<null, "tag"> {
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

export function union<M extends UnionMembers>(name: string, members: M): UnionValidator<M> {
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
        refuseUnknownUnionKeys(input, path);
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

export function jsonb<T>(): ChainableValidator<T, "jsonb"> {
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
