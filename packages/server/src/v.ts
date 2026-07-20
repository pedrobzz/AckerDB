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
): ChainableValidator<T, K, Input> & Extra {
  const validator = {
    kind,
    ...impl,
    ...extra,
    ...(description === undefined ? {} : { description }),
  } as ChainableValidator<T, K, Input> & Extra;
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

function string(): ChainableValidator<string, "string"> {
  return makeValidator("string", {
    check(value, path) {
      if (typeof value !== "string") fail(path, "string", value);
      return value;
    },
    tsType: () => "string",
    descriptor: () => ({ k: "string" }),
  });
}

function int(): ChainableValidator<number, "int"> {
  return makeValidator("int", {
    check(value, path) {
      if (typeof value !== "number" || !Number.isSafeInteger(value)) fail(path, "safe integer", value);
      return value;
    },
    tsType: () => "number",
    descriptor: () => ({ k: "int" }),
  });
}

function float(): ChainableValidator<number, "float"> {
  return makeValidator("float", {
    check(value, path) {
      if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "finite number", value);
      return value;
    },
    tsType: () => "number",
    descriptor: () => ({ k: "float" }),
  });
}

function checkI64(value: unknown, path: string, expected: string): bigint {
  if (typeof value !== "bigint") fail(path, expected, value);
  if (value < I64_MIN || value > I64_MAX) {
    throw new ValidationError(`${path}: bigint out of 64-bit range`);
  }
  return value;
}

function bigint(): ChainableValidator<bigint, "bigint"> {
  return makeValidator("bigint", {
    check: (value, path) => checkI64(value, path, "bigint"),
    tsType: () => "bigint",
    descriptor: () => ({ k: "bigint" }),
  });
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

function array<V extends StandardValidator<unknown, string>>(
  element: V,
): ChainableValidator<InferValidator<V>[], "array", InferValidatorInput<V>[]> & {
  readonly element: V;
} {
  return makeValidator<
    InferValidator<V>[],
    "array",
    { readonly element: V },
    InferValidatorInput<V>[]
  >(
    "array",
    {
      check(value, path) {
        if (!Array.isArray(value)) fail(path, "array", value);
        return value.map((item, i) => element.check(item, `${path}[${i}]`)) as InferValidator<V>[];
      },
      tsType: () => `${parenthesize(element.tsType())}[]`,
      descriptor: () => ({ k: "array", el: element.descriptor() }),
    },
    { element },
  );
}

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

/** Shared by v.object and args validation: strict keys and presence-preserving omission. */
export function checkShape<S extends ObjectShape>(
  shape: S,
  value: unknown,
  path: string,
): InferShape<S> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || value instanceof Uint8Array) {
    fail(path, "object", value);
  }
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!(key in shape) && input[key] !== undefined) {
      throw new ValidationError(`${path}: unknown field "${key}"`);
    }
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(shape)) {
    const field = shape[key]!;
    if (!Object.hasOwn(input, key) && (field.kind === "optional" || field.kind === "nullish")) {
      continue;
    }
    out[key] = field.check(input[key], `${path}.${key}`);
  }
  return out as InferShape<S>;
}

export interface ObjectValidator<S extends ObjectShape = ObjectShape>
  extends ChainableValidator<InferShape<S>, "object", InferInputShape<S>> {
  readonly shape: S;
}

function object<S extends ObjectShape>(shape: S): ObjectValidator<S> {
  return makeValidator<
    InferShape<S>,
    "object",
    { readonly shape: S },
    InferInputShape<S>
  >(
    "object",
    {
      check: (value, path) => checkShape(shape, value, path),
      tsType() {
        const fields = Object.keys(shape).map((k) => {
          const field = shape[k]!;
          const optional = field.kind === "optional" || field.kind === "nullish" ? "?" : "";
          return `${k}${optional}: ${field.tsType()}`;
        });
        return `{ ${fields.join("; ")} }`;
      },
      descriptor() {
        const fields: Record<string, Descriptor> = {};
        for (const key of Object.keys(shape)) fields[key] = shape[key]!.descriptor();
        return { k: "object", shape: fields };
      },
    },
    { shape },
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
  if (new Set(values).size !== values.length) {
    throw new ValidationError(`enum ${name}: duplicate variants`);
  }
  return makeValidator<
    V[number],
    "enum",
    { readonly name: string; readonly values: readonly V[number][] }
  >(
    "enum",
    {
      check(value, path) {
        if (typeof value !== "string" || !values.includes(value)) {
          const got = typeof value === "string" ? JSON.stringify(value) : describe(value);
          throw new ValidationError(
            `${path}: expected one of ${values.map((v) => JSON.stringify(v)).join(" | ")} (${name}), got ${got}`,
          );
        }
        return value as V[number];
      },
      tsType: () => name,
      descriptor: () => ({ k: "enum", name, values: [...values] }),
    },
    { name, values },
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
    namespace[variant] =
      members[variant]!.kind === "tag"
        ? () => ({ tag: variant, value: null })
        : (value: unknown) => ({ tag: variant, value });
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
        if (typeof variant !== "string" || !(variant in members)) {
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
        for (const variant of variantNames) memberDesc[variant] = members[variant]!.descriptor();
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
    // TypeScript type instead (RowOf<typeof schema, ...> in generated types).
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
