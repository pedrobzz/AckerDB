/**
 * The `dbz` validator DSL. Validators describe the runtime validation, the
 * TypeScript type and the storage form of every column, argument and return
 * value in a dbzz app. They compose like Zod: any validator nests inside
 * `array`, `object`, `union` and `nullable`.
 */
import { encode, WireError } from "@dbzz/core";

export class ValidationError extends Error {}

/** Branded bigint: only `ctx.auth.userId` (or another Identity) satisfies it. */
export type Identity = bigint & { readonly __dbzzIdentity: unique symbol };

/** JSON-serializable description of a validator, used for schema snapshots. */
export type Descriptor = { k: string } & Record<string, unknown>;

export interface Validator<T = unknown, K extends string = string> {
  readonly kind: K;
  /** Phantom: the TypeScript type this validator admits. Never set at runtime. */
  readonly _type?: T;
  /** Validate + normalize `value`; throws ValidationError mentioning `path`. */
  check(value: unknown, path: string): T;
  /** Literal TypeScript type text, for codegen. */
  tsType(): string;
  /** JSON descriptor, for schema snapshots and diffing. */
  descriptor(): Descriptor;
}

export type InferValidator<V> = V extends Validator<infer T, string> ? T : never;

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

function makeValidator<T, K extends string>(
  kind: K,
  impl: Omit<Validator<T, K>, "kind" | "_type">,
): Validator<T, K> {
  return { kind, ...impl };
}

function primaryKey(): Validator<bigint, "pk"> {
  return makeValidator("pk", {
    check(value, path) {
      if (typeof value !== "bigint") fail(path, "bigint (primary key)", value);
      return value;
    },
    tsType: () => "bigint",
    descriptor: () => ({ k: "pk" }),
  });
}

function string(): Validator<string, "string"> {
  return makeValidator("string", {
    check(value, path) {
      if (typeof value !== "string") fail(path, "string", value);
      return value;
    },
    tsType: () => "string",
    descriptor: () => ({ k: "string" }),
  });
}

function number(): Validator<number, "number"> {
  return makeValidator("number", {
    check(value, path) {
      if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "finite number", value);
      return value;
    },
    tsType: () => "number",
    descriptor: () => ({ k: "number" }),
  });
}

function checkI64(value: unknown, path: string, expected: string): bigint {
  if (typeof value !== "bigint") fail(path, expected, value);
  if (value < I64_MIN || value > I64_MAX) {
    throw new ValidationError(`${path}: bigint out of 64-bit range`);
  }
  return value;
}

function bigint(): Validator<bigint, "bigint"> {
  return makeValidator("bigint", {
    check: (value, path) => checkI64(value, path, "bigint"),
    tsType: () => "bigint",
    descriptor: () => ({ k: "bigint" }),
  });
}

function identity(): Validator<Identity, "identity"> {
  return makeValidator("identity", {
    check: (value, path) => checkI64(value, path, "Identity (bigint)") as Identity,
    tsType: () => "Identity",
    descriptor: () => ({ k: "identity" }),
  });
}

function boolean(): Validator<boolean, "boolean"> {
  return makeValidator("boolean", {
    check(value, path) {
      if (typeof value !== "boolean") fail(path, "boolean", value);
      return value;
    },
    tsType: () => "boolean",
    descriptor: () => ({ k: "boolean" }),
  });
}

function bytes(): Validator<Uint8Array, "bytes"> {
  return makeValidator("bytes", {
    check(value, path) {
      if (!(value instanceof Uint8Array)) fail(path, "Uint8Array", value);
      return value;
    },
    tsType: () => "Uint8Array",
    descriptor: () => ({ k: "bytes" }),
  });
}

function scheduleAt(): Validator<number, "scheduleAt"> {
  return makeValidator("scheduleAt", {
    check(value, path) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        fail(path, "timestamp (finite number)", value);
      }
      return value;
    },
    tsType: () => "number",
    descriptor: () => ({ k: "scheduleAt" }),
  });
}

/** Parenthesize type text when embedding it in `T[]`. */
function parenthesize(ts: string): string {
  return ts.includes("|") || ts.includes("&") ? `(${ts})` : ts;
}

function array<V extends Validator<unknown, string>>(
  element: V,
): Validator<InferValidator<V>[], "array"> & { readonly element: V } {
  return {
    ...makeValidator<InferValidator<V>[], "array">("array", {
      check(value, path) {
        if (!Array.isArray(value)) fail(path, "array", value);
        return value.map((item, i) => element.check(item, `${path}[${i}]`)) as InferValidator<V>[];
      },
      tsType: () => `${parenthesize(element.tsType())}[]`,
      descriptor: () => ({ k: "array", el: element.descriptor() }),
    }),
    element,
  };
}

export type ObjectShape = Record<string, Validator<unknown, string>>;
export type InferShape<S extends ObjectShape> = { [K in keyof S]: InferValidator<S[K]> };

/** Shared by dbz.object and args validation: strict keys, nullable -> null. */
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
    out[key] = shape[key]!.check(input[key], `${path}.${key}`);
  }
  return out as InferShape<S>;
}

function object<S extends ObjectShape>(
  shape: S,
): Validator<InferShape<S>, "object"> & { readonly shape: S } {
  return {
    ...makeValidator<InferShape<S>, "object">("object", {
      check: (value, path) => checkShape(shape, value, path),
      tsType() {
        const fields = Object.keys(shape).map((k) => `${k}: ${shape[k]!.tsType()}`);
        return `{ ${fields.join("; ")} }`;
      },
      descriptor() {
        const fields: Record<string, Descriptor> = {};
        for (const key of Object.keys(shape)) fields[key] = shape[key]!.descriptor();
        return { k: "object", shape: fields };
      },
    }),
    shape,
  };
}

export interface EnumValidator<V extends string = string>
  extends Validator<V, "enum"> {
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
  return {
    ...makeValidator<V[number], "enum">("enum", {
      check(value, path) {
        if (typeof value !== "string" || !values.includes(value)) {
          fail(path, `one of ${values.map((v) => JSON.stringify(v)).join(" | ")}`, value);
        }
        return value as V[number];
      },
      tsType: () => name,
      descriptor: () => ({ k: "enum", name, values: [...values] }),
    }),
    name,
    values,
  };
}

type LiteralValue = string | number | boolean | bigint;

function literal<const V extends LiteralValue>(value: V): Validator<V, "literal"> {
  return makeValidator("literal", {
    check(input, path) {
      if (input !== value) fail(path, literalTs(value), input);
      return value;
    },
    tsType: () => literalTs(value),
    descriptor: () => ({ k: "literal", v: JSON.parse(encode(value)) }),
  });
}

function literalTs(value: LiteralValue): string {
  if (typeof value === "bigint") return `${value}n`;
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

function tag(): Validator<null, "tag"> {
  return makeValidator("tag", {
    check(value, path) {
      if (value !== null && value !== undefined) fail(path, "null (payload-less variant)", value);
      return null;
    },
    tsType: () => "null",
    descriptor: () => ({ k: "tag" }),
  });
}

export type UnionMembers = Record<string, Validator<unknown, string>>;

export type UnionValue<M extends UnionMembers> = {
  [K in keyof M & string]: { tag: K; value: InferValidator<M[K]> };
}[keyof M & string];

export type UnionNamespace<M extends UnionMembers> = {
  [K in keyof M & string]: M[K] extends Validator<null, "tag">
    ? () => { tag: K; value: null }
    : (value: InferValidator<M[K]>) => { tag: K; value: InferValidator<M[K]> };
};

export interface UnionValidator<M extends UnionMembers = UnionMembers>
  extends Validator<UnionValue<M>, "union"> {
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
  return {
    ...makeValidator<UnionValue<M>, "union">("union", {
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
        const payload = members[variant]!.check(input["value"], `${path}.value`);
        return { tag: variant, value: payload } as UnionValue<M>;
      },
      tsType: () => name,
      descriptor() {
        const memberDesc: Record<string, Descriptor> = {};
        for (const variant of variantNames) memberDesc[variant] = members[variant]!.descriptor();
        return { k: "union", name, members: memberDesc };
      },
    }),
    name,
    members,
    union: namespace as UnionNamespace<M>,
    type: undefined as unknown as UnionValue<M>,
  };
}

function jsonb<T>(): Validator<T, "jsonb"> {
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

export interface NullableValidator<V extends Validator<unknown, string> = Validator<unknown, string>>
  extends Validator<InferValidator<V> | null, "nullable"> {
  readonly inner: V;
}

function nullable<V extends Validator<unknown, string>>(inner: V): NullableValidator<V> {
  if (inner.kind === "nullable") throw new ValidationError("nullable(nullable(...)) is redundant");
  if (inner.kind === "pk" || inner.kind === "scheduleAt" || inner.kind === "tag") {
    throw new ValidationError(`nullable(${inner.kind}) is not allowed`);
  }
  return {
    ...makeValidator<InferValidator<V> | null, "nullable">("nullable", {
      check(value, path) {
        if (value === null || value === undefined) return null;
        return inner.check(value, path) as InferValidator<V>;
      },
      tsType: () => `${inner.tsType()} | null`,
      descriptor: () => ({ k: "nullable", inner: inner.descriptor() }),
    }),
    inner,
  };
}

export const dbz = {
  primaryKey,
  string,
  number,
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
  nullable,
  scheduleAt,
};
