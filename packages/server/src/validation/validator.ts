/**
 * The validator protocol every `v` constructor implements: the runtime check,
 * the TypeScript type text, the storage descriptor, and the nullable/optional/
 * nullish modifiers `makeValidator` installs on each validator it produces.
 */
import {
  createStandardSchemaProperties,
  type StandardSchemaProperties,
} from "./standard-schema.ts";
import { isValidationError, ValidationError } from "./error.ts";

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


export type InferValidator<V> = V extends Validator<infer T, string, unknown> ? T : never;
export type InferValidatorInput<V> = V extends Validator<unknown, string, infer T> ? T : never;

/**
 * Force TypeScript to *evaluate* computed types instead of displaying the
 * recipe (`RowShape<{...validators...}>`, `Omit<...> & {...}`). Every public
 * boundary (rows, inserts, patches, args, narrowed rows) goes through this,
 * so hovers read like hand-written object types. Scalars, bigints (incl.
 * branded identities such as Identity and FileId) and bytes pass through untouched.
 */
export type Expand<T> = T extends bigint | string | number | boolean | null | undefined | Uint8Array
  ? T
  : T extends readonly (infer E)[]
    ? T extends unknown[]
      ? Expand<E>[]
      : readonly Expand<E>[]
    : T extends object
      ? { [K in keyof T]: Expand<T[K]> }
      : T;

export function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (value instanceof Uint8Array) return "bytes";
  return typeof value;
}

export function fail(path: string, expected: string, value: unknown): never {
  throw new ValidationError(`${path}: expected ${expected}, got ${describe(value)}`);
}

type ModifierMode = "available" | "blocked" | "none";

export function makeValidator<
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

export function validatorPrototype<T extends object>(methods: T): T {
  const prototype = Object.create(Object.prototype) as T;
  for (const [name, method] of Object.entries(methods)) {
    Object.defineProperty(prototype, name, { value: method });
  }
  return Object.freeze(prototype);
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

/** Return the underlying validator when storage nullability wraps it. */
export function baseValidator(
  validator: Validator<unknown, string>,
): Validator<unknown, string> {
  return validator.kind === "nullable"
    ? (validator as NullableValidator).inner
    : validator;
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
