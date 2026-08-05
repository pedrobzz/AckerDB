import { Buffer } from "node:buffer";
import { toStandardJson } from "@ackerdb/core";
import type {
  InferValidator,
  NullableValidator,
  NullishValidator,
  OptionalValidator,
  StandardValidator,
} from "./validator.ts";
import type {
  ArrayValidator,
  LiteralValidator,
  ObjectShape,
  ObjectValidator,
  UnionValidator,
} from "./composites.ts";
import {
  BASE64_PATTERN,
  DECIMAL_PATTERN,
  rejectUnrepresentable,
  validatorJsonSchema,
  type JsonSchemaMode,
  type JsonSchemaTarget,
} from "./json-schema.ts";
import { assertStandardJson } from "./standard-json.ts";
import { isValidationError, ValidationError } from "./error.ts";

const DECIMAL = new RegExp(DECIMAL_PATTERN);
const BASE64 = new RegExp(BASE64_PATTERN);

export interface StandardSchemaIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>;
}

export type StandardSchemaResult<T> =
  | { readonly value: T; readonly issues?: undefined }
  | { readonly issues: readonly StandardSchemaIssue[] };

export interface StandardSchemaOptions {
  readonly libraryOptions?: Readonly<Record<string, unknown>>;
}

export interface StandardJsonSchemaOptions {
  readonly target: JsonSchemaTarget;
  readonly libraryOptions?: Readonly<Record<string, unknown>>;
}

export interface StandardSchemaProperties<Input, Output = Input> {
  readonly version: 1;
  readonly vendor: "ackerdb";
  readonly validate: (
    value: unknown,
    options?: StandardSchemaOptions,
  ) => StandardSchemaResult<Output>;
  readonly types?: { readonly input: Input; readonly output: Output };
  readonly jsonSchema: {
    readonly input: (options: StandardJsonSchemaOptions) => Readonly<Record<string, unknown>>;
    readonly output: (options: StandardJsonSchemaOptions) => Readonly<Record<string, unknown>>;
  };
}

/**
 * One lossless standard-JSON boundary compiled from a AckerDB validator. HTTP and
 * local model adapters consume the same codec; AckerDB's ordinary runtime input
 * type remains unchanged. Schemas are not part of it — every published document
 * comes from `json-schema.ts`.
 */
export interface StandardJsonCodec<
  Output,
  ProtocolInput = unknown,
  ProtocolOutput = unknown,
> {
  readonly decode: (value: unknown, path?: string) => Output;
  readonly encode: (value: unknown, path?: string) => unknown;
  /** Validate canonical model input JSON without converting the exposed value. */
  readonly inputProtocolSchema: StandardJsonProtocolSchema<ProtocolInput>;
  /** Validate canonical structured output JSON without converting the exposed value. */
  readonly outputProtocolSchema: StandardJsonProtocolSchema<ProtocolOutput>;
  readonly "~standard": StandardSchemaProperties<unknown, Output>;
}

/** Standard Schema view consumed by JSON-native model/tool runtimes. */
export interface StandardJsonProtocolSchema<Value = unknown> {
  readonly "~standard": StandardSchemaProperties<Value, Value>;
}

type OmissibleProtocolKey<S extends ObjectShape> = {
  [K in keyof S]: S[K] extends OptionalValidator | NullishValidator ? K : never;
}[keyof S];

type RequiredProtocolKey<S extends ObjectShape> = Exclude<keyof S, OmissibleProtocolKey<S>>;

/** Standard-JSON values accepted before AckerDB converts lossless wire forms. */
export type StandardJsonInput<V extends StandardValidator> =
  V extends NullableValidator<infer Inner> ? StandardJsonInput<Inner> | null
    : V extends OptionalValidator<infer Inner> ? StandardJsonInput<Inner>
      : V extends NullishValidator<infer Inner> ? StandardJsonInput<Inner> | null
        : V extends ArrayValidator<infer Element> ? StandardJsonInput<Element>[]
          : V extends ObjectValidator<infer Shape> ? {
              [K in RequiredProtocolKey<Shape>]: StandardJsonInput<Shape[K]>;
            } & {
              [K in OmissibleProtocolKey<Shape>]?: StandardJsonInput<Shape[K]>;
            }
            : V extends UnionValidator<infer Members> ? {
                [K in keyof Members & string]: Members[K] extends { readonly kind: "tag" }
                  ? { readonly tag: K; readonly value?: null }
                  : Members[K] extends OptionalValidator | NullishValidator
                    ? { readonly tag: K; readonly value?: StandardJsonInput<Members[K]> }
                    : { readonly tag: K; readonly value: StandardJsonInput<Members[K]> };
              }[keyof Members & string]
              : V extends LiteralValidator<infer Value> ? Value extends bigint ? `${Value}` : Value
                : V extends { readonly kind: "bigint" | "identity" | "file" } ? number | string
                  : V extends { readonly kind: "bytes" } ? string
                    : V extends StandardValidator<infer Value, string, unknown> ? Value
                      : never;

/** Canonical Standard-JSON values emitted after AckerDB encodes native values. */
export type StandardJsonOutput<V extends StandardValidator> =
  V extends NullableValidator<infer Inner> ? StandardJsonOutput<Inner> | null
    : V extends OptionalValidator<infer Inner> ? StandardJsonOutput<Inner>
      : V extends NullishValidator<infer Inner> ? StandardJsonOutput<Inner> | null
        : V extends ArrayValidator<infer Element> ? StandardJsonOutput<Element>[]
          : V extends ObjectValidator<infer Shape> ? {
              [K in RequiredProtocolKey<Shape>]: StandardJsonOutput<Shape[K]>;
            } & {
              [K in OmissibleProtocolKey<Shape>]?: StandardJsonOutput<Shape[K]>;
            }
            : V extends UnionValidator<infer Members> ? {
                [K in keyof Members & string]: Members[K] extends { readonly kind: "tag" }
                  ? { readonly tag: K; readonly value: null }
                  : Members[K] extends OptionalValidator | NullishValidator
                    ? { readonly tag: K; readonly value?: StandardJsonOutput<Members[K]> }
                    : { readonly tag: K; readonly value: StandardJsonOutput<Members[K]> };
              }[keyof Members & string]
              : V extends LiteralValidator<infer Value> ? Value extends bigint ? `${Value}` : Value
                : V extends { readonly kind: "bigint" | "identity" | "file" } ? string
                  : V extends { readonly kind: "bytes" } ? string
                    : V extends StandardValidator<infer Value, string, unknown> ? Value
                      : never;

interface ProtocolNode {
  readonly decode: (value: unknown, path: string, mode: JsonSchemaMode) => unknown;
  readonly preflight?: (value: unknown, path: string) => void;
  readonly encode: (value: unknown, path: string) => unknown;
}

/** Every kind whose canonical JSON form is already its runtime value. */
const PASSTHROUGH: ProtocolNode = Object.freeze({
  decode: (value: unknown) => value,
  encode: (value: unknown) => value,
});

/**
 * A validator AckerDB did not build. Its kind has no AckerDB meaning, so nothing
 * here interprets its values: they cross structurally, exactly as a value with
 * no validator at all does, and the validator's own `check` stays the single
 * word on what is valid. No JSON Schema can describe such a kind, so every
 * published document still refuses it — `rejectUnrepresentable` is where that
 * refusal lives, and AckerDB's own JSON-less kinds are refused here too.
 */
const FOREIGN: ProtocolNode = Object.freeze({
  decode: (value: unknown) => value,
  encode: (value: unknown) => toStandardJson(value),
});

function protocolError(path: string, expected: string, value: unknown): never {
  const got = value === null
    ? "null"
    : Array.isArray(value)
      ? "array"
      : value instanceof Uint8Array
        ? "bytes"
        : typeof value;
  throw new ValidationError(`${path}: expected ${expected}, got ${got}`);
}

/**
 * proto3-style int64 JSON mapping: encode always as a canonical decimal string,
 * accept either a JSON number or a canonical decimal string on the way in. A
 * number is taken only when it is a safe integer — every JSON integer literal
 * past ±(2^53-1) parses to a float that fails `Number.isSafeInteger`, so silent
 * precision loss can never pass and out-of-range values are forced to the string
 * form (`BigInt(-0)` is `0n`, so `-0` canonicalizes cleanly).
 */
function canonicalDecimal(value: unknown, path: string): bigint {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      protocolError(
        path,
        "a safe integer or a canonical decimal string (values beyond ±2^53-1 must be decimal strings)",
        value,
      );
    }
    return BigInt(value);
  }
  if (typeof value !== "string" || !DECIMAL.test(value)) {
    protocolError(path, "a canonical decimal string", value);
  }
  return BigInt(value);
}

function canonicalOutputDecimal(value: unknown, path: string): bigint {
  if (typeof value !== "string" || !DECIMAL.test(value)) {
    protocolError(path, "a canonical decimal string", value);
  }
  return BigInt(value);
}

function canonicalBytes(value: unknown, path: string): Uint8Array {
  if (typeof value !== "string" || !BASE64.test(value)) {
    protocolError(path, "a canonical base64 string", value);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    protocolError(path, "a canonical base64 string", value);
  }
  return new Uint8Array(decoded);
}

function compileObject(validator: ObjectValidator, where: string): ProtocolNode {
  if (validator.shape === null || typeof validator.shape !== "object" || Array.isArray(validator.shape)) {
    throw new TypeError(`${where}: v.object() has an invalid shape`);
  }
  const fields = Object.entries(validator.shape).map(([name, field]) => [
    name,
    field,
    compileNode(field, `${where}.${name}`),
  ] as const);
  return {
    decode(value, path, mode) {
      if (value === null || typeof value !== "object" || Array.isArray(value) || value instanceof Uint8Array) {
        return value;
      }
      const input = value as Record<string, unknown>;
      const decoded: Record<string, unknown> = { ...input };
      for (const [name, field, node] of fields) {
        if (!Object.hasOwn(input, name)) {
          if (field.kind === "optional" || field.kind === "nullish") continue;
          throw new ValidationError(`${path}.${name}: required ${mode} field is missing`);
        }
        decoded[name] = node.decode(input[name], `${path}.${name}`, mode);
      }
      return decoded;
    },
    preflight(value, path) {
      if (value === null || typeof value !== "object" || Array.isArray(value) || value instanceof Uint8Array) {
        return;
      }
      const input = value as Record<string, unknown>;
      for (const [name, field, node] of fields) {
        if (
          (field.kind === "optional" || field.kind === "nullish") &&
          (!Object.hasOwn(input, name) || input[name] === undefined)
        ) {
          continue;
        }
        node.preflight?.(input[name], `${path}.${name}`);
      }
    },
    encode(value, path) {
      const checked = value as Record<string, unknown>;
      const encoded = Object.create(null) as Record<string, unknown>;
      for (const [name, field, node] of fields) {
        if (
          (field.kind === "optional" || field.kind === "nullish") &&
          (!Object.hasOwn(checked, name) || checked[name] === undefined)
        ) {
          continue;
        }
        encoded[name] = node.encode(checked[name], `${path}.${name}`);
      }
      return encoded;
    },
  };
}

function compileUnion(validator: UnionValidator, where: string): ProtocolNode {
  if (validator.members === null || typeof validator.members !== "object" || Array.isArray(validator.members)) {
    throw new TypeError(`${where}: v.union() has invalid members`);
  }
  const members = new Map(Object.entries(validator.members).map(([tag, member]) => [
    tag,
    {
      validator: member,
      node: member.kind === "tag"
        ? undefined
        : compileNode(member, `${where}.${tag}.value`),
    },
  ]));
  return {
    decode(value, path, mode) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return value;
      }
      const input = value as Record<string, unknown>;
      const member = typeof input.tag === "string" ? members.get(input.tag) : undefined;
      if (member === undefined) return value;
      if (
        !Object.hasOwn(input, "value") &&
        member.validator.kind !== "optional" &&
        member.validator.kind !== "nullish" &&
        (mode === "output" || member.validator.kind !== "tag")
      ) {
        throw new ValidationError(`${path}.value: required ${mode} field is missing`);
      }
      return {
        ...input,
        value: member.node === undefined
          ? input.value
          : member.node.decode(input.value, `${path}.value`, mode),
      };
    },
    preflight(value, path) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return;
      const input = value as Record<string, unknown>;
      const member = typeof input.tag === "string" ? members.get(input.tag) : undefined;
      member?.node?.preflight?.(input.value, `${path}.value`);
    },
    encode(value, path) {
      const checked = value as { readonly tag: string; readonly value: unknown };
      const member = members.get(checked.tag)!;
      if (
        (member.validator.kind === "optional" || member.validator.kind === "nullish") &&
        (!Object.hasOwn(checked, "value") || checked.value === undefined)
      ) {
        return { tag: checked.tag };
      }
      return {
        tag: checked.tag,
        value: member.node === undefined
          ? null
          : member.node.encode(checked.value, `${path}.value`),
      };
    },
  };
}

function compileNode(validator: StandardValidator, where: string): ProtocolNode {
  switch (validator.kind) {
    case "string":
    case "int":
    case "float":
    case "boolean":
    case "vector":
    case "enum":
      return PASSTHROUGH;
    case "bigint":
    case "identity":
    case "file":
      return {
        decode(value, path, mode) {
          return mode === "input"
            ? canonicalDecimal(value, path)
            : canonicalOutputDecimal(value, path);
        },
        encode(value) {
          return (value as bigint).toString();
        },
      };
    case "bytes":
      return {
        decode(value, path) {
          return canonicalBytes(value, path);
        },
        encode(value) {
          const bytes = value as Uint8Array;
          return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
        },
      };
    case "jsonb":
      return {
        decode(value, path) {
          assertStandardJson(value, path);
          return value;
        },
        preflight: assertStandardJson,
        encode: (value) => value,
      };
    case "literal": {
      const value = (validator as LiteralValidator).value;
      if (typeof value !== "bigint") return PASSTHROUGH;
      const protocolValue = value.toString();
      return {
        decode(input, path) {
          if (input !== protocolValue) protocolError(path, JSON.stringify(protocolValue), input);
          return value;
        },
        encode: () => protocolValue,
      };
    }
    case "array": {
      const element = (validator as StandardValidator & {
        readonly element?: StandardValidator;
      }).element;
      if (element === undefined) throw new TypeError(`${where}: v.array() has no element validator`);
      const node = compileNode(element, `${where}[]`);
      return {
        decode(value, path, mode) {
          if (!Array.isArray(value)) return value;
          return value.map((item, index) => node.decode(item, `${path}[${index}]`, mode));
        },
        preflight(value, path) {
          if (!Array.isArray(value)) return;
          for (let index = 0; index < value.length; index++) {
            node.preflight?.(value[index], `${path}[${index}]`);
          }
        },
        encode(value, path) {
          const checked = value as unknown[];
          return checked.map((item, index) => node.encode(item, `${path}[${index}]`));
        },
      };
    }
    case "object":
      return compileObject(validator as ObjectValidator, where);
    case "union":
      return compileUnion(validator as UnionValidator, where);
    case "nullable":
    case "optional":
    case "nullish": {
      const inner = (validator as StandardValidator & {
        readonly inner?: StandardValidator;
      }).inner;
      if (inner === undefined) throw new TypeError(`${where}: .${validator.kind}() has no inner validator`);
      const node = compileNode(inner, where);
      const acceptsNull = validator.kind === "nullable" || validator.kind === "nullish";
      const acceptsUndefined = validator.kind === "optional" || validator.kind === "nullish";
      return {
        decode(value, path, mode) {
          if (value === null && acceptsNull) return null;
          if (value === undefined && acceptsUndefined) return undefined;
          return node.decode(value, path, mode);
        },
        preflight(value, path) {
          if ((value !== null || !acceptsNull) && (value !== undefined || !acceptsUndefined)) {
            node.preflight?.(value, path);
          }
        },
        encode(value, path) {
          if (value === null && acceptsNull) return null;
          if (value === undefined && acceptsUndefined) return undefined;
          return node.encode(value, path);
        },
      };
    }
    default:
      // AckerDB's own kinds without a JSON form are named and refused. A kind
      // AckerDB never defined belongs to whoever wrote that validator.
      if (validator.kind === "pk" || validator.kind === "scheduleAt" || validator.kind === "tag") {
        rejectUnrepresentable(validator, where);
      }
      return FOREIGN;
  }
}

/**
 * The Standard Schema view over the shared emitter. A plain validator describes
 * only what its runtime values already are; a compiled codec additionally
 * carries bigint, Identity, FileId, and bytes across the JSON boundary.
 */
function standardJsonSchema(
  validator: StandardValidator,
  mode: JsonSchemaMode,
  options: StandardJsonSchemaOptions,
  protocol: boolean,
): Readonly<Record<string, unknown>> {
  return validatorJsonSchema<StandardValidator>(validator, {
    mode,
    target: options?.target,
    protocol,
  });
}

export function createStandardSchemaProperties<Input, Output>(
  validator: StandardValidator<Output, string, Input>,
  validationError: (value: unknown) => value is Error,
): StandardSchemaProperties<Input, Output> {
  return Object.freeze({
    version: 1 as const,
    vendor: "ackerdb" as const,
    validate(value: unknown): StandardSchemaResult<Output> {
      try {
        return { value: validator.check(value, "$input") };
      } catch (error) {
        if (!validationError(error)) throw error;
        return { issues: [{ message: error.message }] };
      }
    },
    jsonSchema: Object.freeze({
      input: (options: StandardJsonSchemaOptions) =>
        standardJsonSchema(validator, "input", options, false),
      output: (options: StandardJsonSchemaOptions) =>
        standardJsonSchema(validator, "output", options, false),
    }),
  });
}

export function compileStandardJsonCodec<V extends StandardValidator>(
  validator: V,
): StandardJsonCodec<InferValidator<V>, StandardJsonInput<V>, StandardJsonOutput<V>> {
  const node = compileNode(validator, "$");
  const decode = (value: unknown, path = "$input") => {
    assertStandardJson(value, path);
    return validator.check(node.decode(value, path, "input"), path) as InferValidator<V>;
  };
  const encode = (value: unknown, path = "$output") => {
    node.preflight?.(value, path);
    const encoded = node.encode(validator.check(value, path), path);
    assertStandardJson(encoded, path);
    return encoded;
  };
  const protocolSchema = <Value>(mode: JsonSchemaMode): StandardJsonProtocolSchema<Value> => Object.freeze({
    "~standard": Object.freeze({
      version: 1 as const,
      vendor: "ackerdb" as const,
      validate(value: unknown): StandardSchemaResult<Value> {
        const path = mode === "input" ? "$input" : "$output";
        try {
          assertStandardJson(value, path);
          validator.check(node.decode(value, path, mode), path);
          return { value: value as Value };
        } catch (error) {
          if (!isValidationError(error)) throw error;
          return { issues: [{ message: error.message }] };
        }
      },
      jsonSchema: Object.freeze({
        input: (options: StandardJsonSchemaOptions) =>
          standardJsonSchema(validator, mode, options, true),
        output: (options: StandardJsonSchemaOptions) =>
          standardJsonSchema(validator, mode, options, true),
      }),
    }),
  });
  const codec: StandardJsonCodec<
    InferValidator<V>,
    StandardJsonInput<V>,
    StandardJsonOutput<V>
  > = {
    decode,
    encode,
    inputProtocolSchema: protocolSchema<StandardJsonInput<V>>("input"),
    outputProtocolSchema: protocolSchema<StandardJsonOutput<V>>("output"),
    "~standard": Object.freeze({
      version: 1 as const,
      vendor: "ackerdb" as const,
      validate(value: unknown): StandardSchemaResult<InferValidator<V>> {
        try {
          return { value: decode(value) };
        } catch (error) {
          if (!isValidationError(error)) throw error;
          return { issues: [{ message: error.message }] };
        }
      },
      jsonSchema: Object.freeze({
        input: (options: StandardJsonSchemaOptions) =>
          standardJsonSchema(validator, "input", options, true),
        output: (options: StandardJsonSchemaOptions) =>
          standardJsonSchema(validator, "output", options, true),
      }),
    }),
  };
  return Object.freeze(codec);
}

/**
 * Compile one contract validator into a standard-JSON codec, refusing a
 * contract no JSON boundary can carry where it is declared rather than at the
 * first call. `surface` names the boundary in the error, so the same rule reads
 * correctly whether it is the HTTP surface or the MCP one refusing it.
 */
export function compileContractCodec(
  validator: StandardValidator | { readonly kind: string },
  where: string,
  surface: string,
): StandardJsonCodec<unknown> {
  try {
    // Declarations type their validators as the erased `Validator` face;
    // registration already refuses anything `v` did not build.
    return compileStandardJsonCodec(validator as StandardValidator);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new TypeError(
      `${where} cannot cross the ${surface}'s standard-JSON boundary: ${detail}`,
      { cause },
    );
  }
}
