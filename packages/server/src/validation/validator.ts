/**
 * The validator protocol every `v` constructor implements: native parsing,
 * Standard JSON conversion,
 * the TypeScript type text, the storage descriptor, and the nullable/optional/
 * nullish modifiers `makeValidator` installs on each validator it produces.
 */
import {
  createStandardSchemaProperties,
  type StandardSchemaProperties,
} from "./standard-schema.ts";
import { isValidationError, ValidationError } from "./error.ts";
import {
  describedJsonSchema,
  jsonSchemaContext,
  nullableJsonSchema,
  type JsonSchema,
  type JsonSchemaContext,
  type JsonSchemaOptions,
} from "./json-schema.ts";
import { assertStandardJson } from "./standard-json.ts";

export type Descriptor = { k: string } & Record<string, unknown>;

export interface Validator<
  T = unknown,
  K extends string = string,
  Input = T,
  JsonInput = Input,
  JsonOutput = T,
> {
  readonly kind: K;
  /** Phantom: the TypeScript type this validator admits. Never set at runtime. */
  readonly _type?: T;
  /** Phantom: the value accepted before validation and normalization. */
  readonly _inputType?: Input;
  /** Phantom: the Standard JSON value accepted by `decode`. */
  readonly _jsonInputType?: JsonInput;
  /** Phantom: the Standard JSON value emitted by `encode`. */
  readonly _jsonOutputType?: JsonOutput;
  /** Validate + normalize one native runtime value. */
  parse(value: unknown, path?: string): T;
  /** Decode one Standard JSON value into the native runtime value. */
  decode(value: unknown, path?: string): T;
  /** Validate and encode one native runtime value as Standard JSON. */
  encode(value: T, path?: string): JsonOutput;
  /** Describe this validator's own JSON Schema fragment. */
  toJsonSchema(options?: JsonSchemaOptions): JsonSchema;
  /** Literal TypeScript type text, for codegen. */
  tsType(): string;
  /** JSON descriptor, for schema snapshots and diffing. */
  descriptor(): Descriptor;
}

/** A v validator that can also describe its wire shape to external tools. */
export interface StandardValidator<
  T = unknown,
  K extends string = string,
  Input = T,
  JsonInput = Input,
  JsonOutput = T,
> extends Validator<T, K, Input, JsonInput, JsonOutput> {
  readonly description?: string;
  /** Return an equivalent validator carrying human guidance for generated schemas. */
  describe(description: string): this;
  /** Dependency-free Standard Schema + Standard JSON Schema v1 contract. */
  readonly "~standard": StandardSchemaProperties<Input, T>;
}

/** An unmodified validator. Modifiers return a terminal validator surface. */
export interface ChainableValidator<
  T = unknown,
  K extends string = string,
  Input = T,
  JsonInput = Input,
  JsonOutput = T,
> extends StandardValidator<T, K, Input, JsonInput, JsonOutput> {
  nullable(): NullableValidator<this>;
  optional(): OptionalValidator<this>;
  nullish(): NullishValidator<this>;
}

export interface BoundedValidator<
  T = unknown,
  K extends string = string,
  B = unknown,
  Input = T,
  JsonInput = Input,
  JsonOutput = T,
>
  extends ChainableValidator<T, K, Input, JsonInput, JsonOutput> {
  min(bound: B): this;
  max(bound: B): this;
}


export type InferValidator<V> = V extends Validator<infer T, string, any, any, any> ? T : never;
export type InferValidatorInput<V> = V extends Validator<any, string, infer T, any, any> ? T : never;
export type InferValidatorJsonInput<V> = V extends Validator<any, string, any, infer T, any> ? T : never;
export type InferValidatorJsonOutput<V> = V extends Validator<any, string, any, any, infer T> ? T : never;

/**
 * Force TypeScript to *evaluate* computed types instead of displaying the
 * recipe (`RowShape<{...validators...}>`, `Omit<...> & {...}`). Every public
 * boundary (rows, inserts, patches, args, narrowed rows) goes through this,
 * so hovers read like hand-written object types. Scalars, bigints (incl.
 * branded identities such as Identity, FileId, and FileGrantId) and bytes pass through untouched.
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

interface ValidatorImplementation<T, JsonOutput> {
  parse(value: unknown, path: string): T;
  /** Decode and validate Standard JSON. Defaults to native parsing. */
  decode?(this: Pick<Validator<T>, "parse">, value: unknown, path: string): T;
  /** Validate and encode a native value. Defaults to native parsing. */
  encode?(this: Pick<Validator<T>, "parse">, value: T, path: string): JsonOutput;
  /** Emit this kind's own schema fragment. Composite definitions call their children. */
  toJsonSchema(context: JsonSchemaContext): JsonSchema;
  tsType(): string;
  descriptor(): Descriptor;
}

export function makeValidator<
  T,
  K extends string,
  Extra extends object = object,
  Input = T,
  JsonInput = Input,
  JsonOutput = T,
>(
  kind: K,
  impl: ValidatorImplementation<T, JsonOutput>,
  extra?: Extra,
  modifierMode: ModifierMode = "available",
  description?: string,
  prototype?: object,
): ChainableValidator<T, K, Input, JsonInput, JsonOutput> & Extra {
  const validator = {
    __proto__: prototype ?? Object.prototype,
    kind,
    parse(value: unknown, path = "$input") {
      return impl.parse.call(validator, value, path);
    },
    decode(value: unknown, path = "$input") {
      assertStandardJson(value, path);
      return impl.decode === undefined
        ? impl.parse.call(validator, value, path)
        : impl.decode.call(validator, value, path);
    },
    encode(value: T, path = "$output") {
      const encoded = impl.encode === undefined
        ? impl.parse.call(validator, value, path) as unknown as JsonOutput
        : impl.encode.call(validator, value, path);
      assertStandardJson(encoded, path);
      return encoded;
    },
    toJsonSchema(this: StandardValidator, options: JsonSchemaOptions = {}) {
      const context = jsonSchemaContext(options);
      return describedJsonSchema(
        this.description,
        impl.toJsonSchema.call(this, context),
      );
    },
    tsType: impl.tsType,
    descriptor: impl.descriptor,
    ...extra,
    ...(description === undefined ? {} : { description }),
  } as unknown as ChainableValidator<T, K, Input, JsonInput, JsonOutput> & Extra;
  Object.defineProperties(validator, {
    describe: {
      value(
        this: ChainableValidator<T, K, Input, JsonInput, JsonOutput> & Extra,
        nextDescription: string,
      ) {
        if (typeof nextDescription !== "string" || nextDescription.trim() === "") {
          throw new ValidationError("validator description must be a non-empty string");
        }
        return makeValidator<T, K, Extra, Input, JsonInput, JsonOutput>(
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
      value: createStandardSchemaProperties(validator, isValidationError),
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
    InferValidatorInput<V> | null,
    InferValidatorJsonInput<V> | null,
    InferValidatorJsonOutput<V> | null
  > {
  readonly inner: V;
}

export interface OptionalValidator<
  V extends StandardValidator<unknown, string> = StandardValidator<unknown, string>,
>
  extends StandardValidator<
    InferValidator<V> | undefined,
    "optional",
    InferValidatorInput<V> | undefined,
    InferValidatorJsonInput<V>,
    InferValidatorJsonOutput<V>
  > {
  readonly inner: V;
}

export interface NullishValidator<
  V extends StandardValidator<unknown, string> = StandardValidator<unknown, string>,
>
  extends StandardValidator<
    InferValidator<V> | null | undefined,
    "nullish",
    InferValidatorInput<V> | null | undefined,
    InferValidatorJsonInput<V> | null,
    InferValidatorJsonOutput<V> | null
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

type ModifiedJsonInput<
  V extends StandardValidator<unknown, string>,
  K extends "nullable" | "optional" | "nullish",
> = K extends "optional" ? InferValidatorJsonInput<V> : InferValidatorJsonInput<V> | null;

type ModifiedJsonOutput<
  V extends StandardValidator<unknown, string>,
  K extends "nullable" | "optional" | "nullish",
> = K extends "optional" ? InferValidatorJsonOutput<V> : InferValidatorJsonOutput<V> | null;

function modified<
  V extends StandardValidator<unknown, string>,
  K extends "nullable" | "optional" | "nullish",
>(inner: V, kind: K): ModifiedValidator<V, K> {
  if (inner.kind === "nullable" || inner.kind === "optional" || inner.kind === "nullish") {
    throw new ValidationError(
      `${inner.kind} validator is already modified; redundant modifier combinations are not allowed — use .nullish() for nullable optional input`,
    );
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
    InferValidatorInput<V> | null | undefined,
    ModifiedJsonInput<V, K>,
    ModifiedJsonOutput<V, K>
  >(
    kind,
    {
      parse(value, path) {
        if (value === null && acceptsNull) return null;
        if (value === undefined && acceptsUndefined) return undefined;
        return inner.parse(value, path) as InferValidator<V>;
      },
      decode(value, path) {
        if (value === null && acceptsNull) return null;
        return inner.decode(value, path) as InferValidator<V>;
      },
      encode(value, path) {
        if (value === null && acceptsNull) return null as ModifiedJsonOutput<V, K>;
        return inner.encode(value as InferValidator<V>, path) as ModifiedJsonOutput<V, K>;
      },
      toJsonSchema(context) {
        const schema = inner.toJsonSchema(context);
        return kind === "optional" ? schema : nullableJsonSchema(schema);
      },
      tsType: () => `${inner.tsType()}${suffix}`,
      descriptor: () => ({ k: kind, inner: inner.descriptor() }),
    },
    { inner },
    "blocked",
  ) as unknown as ModifiedValidator<V, K>;
}
