import { Buffer } from "node:buffer";
import {
  type ArrayValidator,
  type EnumValidator,
  type Descriptor,
  type InferValidator,
  type LiteralValidator,
  type NullableValidator,
  type ObjectShape,
  type ObjectValidator,
  type NullishValidator,
  type OptionalValidator,
  type StandardValidator,
  type UnionValidator,
  type VectorValidator,
} from "./v.ts";
import { deepFreeze } from "../shared/immutable.ts";
import { assertStandardJson } from "./standard-json.ts";
import { isValidationError, ValidationError } from "./error.ts";

const JSON_SCHEMA_2020_12 = "https://json-schema.org/draft/2020-12/schema";
const JSON_SCHEMA_DRAFT_07 = "http://json-schema.org/draft-07/schema#";
const DECIMAL_PATTERN = "^(?:0|-?[1-9][0-9]*)$";
const DECIMAL = new RegExp(DECIMAL_PATTERN);
const BASE64_PATTERN = "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$";
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
  readonly target: "draft-2020-12" | "draft-07" | (string & {});
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

export interface JsonObjectSchema extends Readonly<Record<string, unknown>> {
  readonly $schema: typeof JSON_SCHEMA_2020_12;
  readonly type: "object";
  readonly properties: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly required?: readonly string[];
  readonly additionalProperties: false;
}

/**
 * One lossless standard-JSON boundary compiled from a AckerDB validator. HTTP and
 * local model adapters consume the same codec; AckerDB's ordinary runtime input
 * type remains unchanged.
 */
export interface StandardJsonCodec<
  Output,
  ProtocolInput = unknown,
  ProtocolOutput = unknown,
> {
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema: Readonly<Record<string, unknown>>;
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
                : V extends { readonly kind: "bigint" | "identity" } ? number | string
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
                : V extends { readonly kind: "bigint" | "identity" } ? string
                  : V extends { readonly kind: "bytes" } ? string
                    : V extends StandardValidator<infer Value, string, unknown> ? Value
                      : never;

type SchemaMode = "input" | "output";

interface ProtocolNode {
  readonly schema: (mode: SchemaMode) => Readonly<Record<string, unknown>>;
  readonly decode: (value: unknown, path: string, mode: SchemaMode) => unknown;
  readonly preflight?: (value: unknown, path: string) => void;
  readonly encode: (value: unknown, path: string) => unknown;
}

function described(
  validator: StandardValidator,
  schema: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const descriptor = validator.kind === "bigint" ? validator.descriptor() : undefined;
  const bigintBounds = descriptor === undefined
    ? ""
    : [
      descriptor["min"] === undefined
        ? undefined
        : `Minimum bigint value (inclusive): ${String(descriptor["min"])}.`,
      descriptor["max"] === undefined
        ? undefined
        : `Maximum bigint value (inclusive): ${String(descriptor["max"])}.`,
    ].filter((part): part is string => part !== undefined).join(" ");
  const ownDescription = [validator.description, bigintBounds]
    .filter((part): part is string => part !== undefined && part !== "")
    .join(" ");
  if (ownDescription === "") return schema;
  const inherited = typeof schema["description"] === "string" ? schema["description"] : "";
  return {
    ...schema,
    description: inherited === "" || inherited === ownDescription
      ? ownDescription
      : `${ownDescription} ${inherited}`,
  };
}

function constraintSchema(descriptor: Descriptor): Readonly<Record<string, unknown>> {
  switch (descriptor["k"]) {
    case "string":
      return {
        ...(descriptor["min"] === undefined ? {} : { minLength: descriptor["min"] }),
        ...(descriptor["max"] === undefined ? {} : { maxLength: descriptor["max"] }),
        ...(descriptor["regex"] === undefined ? {} : { pattern: descriptor["regex"] }),
      };
    case "array":
      return {
        ...(descriptor["min"] === undefined ? {} : { minItems: descriptor["min"] }),
        ...(descriptor["max"] === undefined ? {} : { maxItems: descriptor["max"] }),
      };
    case "int": {
      const min = descriptor["min"] as number | undefined;
      const max = descriptor["max"] as number | undefined;
      return {
        minimum: min === undefined
          ? Number.MIN_SAFE_INTEGER
          : Math.max(Number.MIN_SAFE_INTEGER, min),
        maximum: max === undefined
          ? Number.MAX_SAFE_INTEGER
          : Math.min(Number.MAX_SAFE_INTEGER, max),
      };
    }
    case "float":
      return {
        ...(descriptor["min"] === undefined ? {} : { minimum: descriptor["min"] }),
        ...(descriptor["max"] === undefined ? {} : { maximum: descriptor["max"] }),
      };
    default:
      return {};
  }
}

const NULLABLE_MERGE_BLOCKERS = ["enum", "const", "anyOf", "oneOf", "allOf", "not", "$ref"] as const;

/**
 * A nullable wrapper widens the inner `type` keyword instead of wrapping the
 * schema in an `anyOf` union whenever that is spec-equivalent:
 * `{"type":["boolean","null"]}` accepts exactly the same values as
 * `{"anyOf":[{"type":"boolean"},{"type":"null"}]}`, and function-calling
 * models reliably honor flat `type` keywords where many ignore `anyOf`
 * member types entirely (DeepSeek, for one, stringifies every scalar
 * argument of an `anyOf`-typed parameter). Inners whose constraints would
 * change meaning under a widened type (enum/const/combinators) keep the
 * union form.
 */
function nullableSchema(
  inner: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const type = inner.type;
  const mergeable =
    (typeof type === "string" ||
      (Array.isArray(type) && type.every((member) => typeof member === "string"))) &&
    NULLABLE_MERGE_BLOCKERS.every((key) => !(key in inner));
  if (!mergeable) return { anyOf: [inner, { type: "null" }] };
  const types = typeof type === "string" ? [type] : (type as readonly string[]);
  return types.includes("null") ? inner : { ...inner, type: [...types, "null"] };
}

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

function checkedNode(
  validator: StandardValidator,
  fragment: Readonly<Record<string, unknown>>,
): ProtocolNode {
  return {
    schema: () => described(validator, fragment),
    decode: (value) => value,
    encode: (value) => value,
  };
}

function compileObject(
  validator: ObjectValidator,
  where: string,
  protocol: boolean,
): ProtocolNode {
  if (validator.shape === null || typeof validator.shape !== "object" || Array.isArray(validator.shape)) {
    throw new TypeError(`${where}: v.object() has an invalid shape`);
  }
  const fields = Object.entries(validator.shape).map(([name, field]) => [
    name,
    field,
    compileNode(field, `${where}.${name}`, protocol),
  ] as const);
  return {
    schema(mode) {
      const properties = Object.create(null) as Record<
        string,
        Readonly<Record<string, unknown>>
      >;
      const required: string[] = [];
      for (const [name, field, node] of fields) {
        properties[name] = node.schema(mode);
        if (field.kind !== "optional" && field.kind !== "nullish") required.push(name);
      }
      return described(validator, {
        type: "object",
        properties,
        ...(required.length === 0 ? {} : { required }),
        additionalProperties: false,
      });
    },
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

function compileUnion(
  validator: UnionValidator,
  where: string,
  protocol: boolean,
): ProtocolNode {
  if (validator.members === null || typeof validator.members !== "object" || Array.isArray(validator.members)) {
    throw new TypeError(`${where}: v.union() has invalid members`);
  }
  const members = new Map(Object.entries(validator.members).map(([tag, member]) => [
    tag,
    {
      validator: member,
      node: member.kind === "tag"
        ? undefined
        : compileNode(member, `${where}.${tag}.value`, protocol),
    },
  ]));
  return {
    schema(mode) {
      return described(validator, {
        oneOf: [...members].map(([tag, member]) => ({
          type: "object",
          properties: {
            tag: { const: tag },
            value: member.node === undefined ? { type: "null" } : member.node.schema(mode),
          },
          required:
            member.validator.kind === "optional" || member.validator.kind === "nullish" ||
              (mode === "input" && member.validator.kind === "tag")
              ? ["tag"]
              : ["tag", "value"],
          additionalProperties: false,
        })),
      });
    },
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

function compileNode(
  validator: StandardValidator,
  where: string,
  protocol: boolean,
): ProtocolNode {
  switch (validator.kind) {
    case "string":
      return checkedNode(validator, {
        type: "string",
        ...constraintSchema(validator.descriptor()),
      });
    case "int":
      return checkedNode(validator, {
        type: "integer",
        ...constraintSchema(validator.descriptor()),
      });
    case "float":
      return checkedNode(validator, {
        type: "number",
        ...constraintSchema(validator.descriptor()),
      });
    case "boolean":
      return checkedNode(validator, { type: "boolean" });
    case "bigint":
    case "identity":
      if (!protocol) {
        throw new TypeError(
          `${where}: v.${validator.kind}() requires a standard-JSON protocol codec`,
        );
      }
      return {
        schema: (mode) => described(
          validator,
          mode === "input"
            ? { type: ["integer", "string"], pattern: DECIMAL_PATTERN }
            : { type: "string", pattern: DECIMAL_PATTERN },
        ),
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
      if (!protocol) {
        throw new TypeError(`${where}: v.bytes() requires a standard-JSON protocol codec`);
      }
      return {
        schema: () => described(validator, {
          type: "string",
          pattern: BASE64_PATTERN,
          contentEncoding: "base64",
        }),
        decode(value, path) {
          return canonicalBytes(value, path);
        },
        encode(value) {
          const bytes = value as Uint8Array;
          return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
        },
      };
    case "vector": {
      const dimensions = (validator as VectorValidator).dimensions;
      return checkedNode(validator, {
        type: "array",
        items: { type: "number" },
        minItems: dimensions,
        maxItems: dimensions,
      });
    }
    case "jsonb":
      return {
        schema: () => described(validator, {}),
        decode(value, path) {
          assertStandardJson(value, path);
          return value;
        },
        preflight: assertStandardJson,
        encode: (value) => value,
      };
    case "enum": {
      const values = (validator as EnumValidator).values;
      if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
        throw new TypeError(`${where}: v.enum() has invalid string values`);
      }
      return checkedNode(validator, { type: "string", enum: [...values] });
    }
    case "literal": {
      const value = (validator as LiteralValidator).value;
      if (typeof value === "bigint") {
        if (!protocol) {
          throw new TypeError(`${where}: v.literal(bigint) requires a standard-JSON protocol codec`);
        }
        const protocolValue = value.toString();
        return {
          schema: () => described(validator, { const: protocolValue }),
          decode(input, path) {
            if (input !== protocolValue) protocolError(path, JSON.stringify(protocolValue), input);
            return value;
          },
          encode: () => protocolValue,
        };
      }
      if (
        (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") ||
        (typeof value === "number" && !Number.isFinite(value))
      ) {
        throw new TypeError(`${where}: v.literal() has no standard-JSON protocol value`);
      }
      return checkedNode(validator, { const: value });
    }
    case "array": {
      const element = (validator as StandardValidator & {
        readonly element?: StandardValidator;
      }).element;
      if (element === undefined) throw new TypeError(`${where}: v.array() has no element validator`);
      const node = compileNode(element, `${where}[]`, protocol);
      const constraints = constraintSchema(validator.descriptor());
      return {
        schema: (mode) => described(validator, {
          type: "array",
          items: node.schema(mode),
          ...constraints,
        }),
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
      return compileObject(validator as ObjectValidator, where, protocol);
    case "union":
      return compileUnion(validator as UnionValidator, where, protocol);
    case "nullable":
    case "optional":
    case "nullish": {
      const inner = (validator as StandardValidator & {
        readonly inner?: StandardValidator;
      }).inner;
      if (inner === undefined) throw new TypeError(`${where}: .${validator.kind}() has no inner validator`);
      const node = compileNode(inner, where, protocol);
      const acceptsNull = validator.kind === "nullable" || validator.kind === "nullish";
      const acceptsUndefined = validator.kind === "optional" || validator.kind === "nullish";
      return {
        schema: (mode) => described(
          validator,
          acceptsNull ? nullableSchema(node.schema(mode)) : node.schema(mode),
        ),
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
    case "pk":
      throw new TypeError(
        `${where}: v.primaryKey() is not an MCP value; use v.bigint() for a decimal string`,
      );
    case "scheduleAt":
      throw new TypeError(
        `${where}: v.scheduleAt() is not an MCP value; use v.float() for a timestamp`,
      );
    case "tag":
      throw new TypeError(`${where}: v.tag() is valid only as a direct v.union() member`);
    default:
      throw new TypeError(
        `${where}: v.${validator.kind}() has no lossless standard-JSON protocol representation`,
      );
  }
}

function schemaUri(options: StandardJsonSchemaOptions): string {
  if (options?.target === "draft-2020-12") return JSON_SCHEMA_2020_12;
  if (options?.target === "draft-07") return JSON_SCHEMA_DRAFT_07;
  throw new TypeError("AckerDB validators support JSON Schema draft-2020-12 and draft-07");
}

/** Standard Schema consumers may normalize in place, so every call owns a fresh graph. */
function mutableStandardSchemaFor(
  node: ProtocolNode,
  mode: SchemaMode,
  options: StandardJsonSchemaOptions,
): Readonly<Record<string, unknown>> {
  return { $schema: schemaUri(options), ...node.schema(mode) };
}

function schemaFor(
  node: ProtocolNode,
  mode: SchemaMode,
  options: StandardJsonSchemaOptions,
): Readonly<Record<string, unknown>> {
  return deepFreeze(mutableStandardSchemaFor(node, mode, options));
}

function jsonSchema(
  validator: StandardValidator,
  mode: SchemaMode,
  options: StandardJsonSchemaOptions,
): Readonly<Record<string, unknown>> {
  return mutableStandardSchemaFor(compileNode(validator, "$", false), mode, options);
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
      input: (options: StandardJsonSchemaOptions) => jsonSchema(validator, "input", options),
      output: (options: StandardJsonSchemaOptions) => jsonSchema(validator, "output", options),
    }),
  });
}

export function compileStandardJsonCodec<V extends StandardValidator>(
  validator: V,
): StandardJsonCodec<InferValidator<V>, StandardJsonInput<V>, StandardJsonOutput<V>> {
  const node = compileNode(validator, "$", true);
  const inputSchema = schemaFor(node, "input", { target: "draft-2020-12" });
  const outputSchema = schemaFor(node, "output", { target: "draft-2020-12" });
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
  const protocolSchema = <Value>(mode: SchemaMode): StandardJsonProtocolSchema<Value> => Object.freeze({
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
        input: (options: StandardJsonSchemaOptions) => mutableStandardSchemaFor(node, mode, options),
        output: (options: StandardJsonSchemaOptions) => mutableStandardSchemaFor(node, mode, options),
      }),
    }),
  });
  const codec: StandardJsonCodec<
    InferValidator<V>,
    StandardJsonInput<V>,
    StandardJsonOutput<V>
  > = {
    inputSchema,
    outputSchema,
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
        input: (options: StandardJsonSchemaOptions) => mutableStandardSchemaFor(node, "input", options),
        output: (options: StandardJsonSchemaOptions) => mutableStandardSchemaFor(node, "output", options),
      }),
    }),
  };
  return Object.freeze(codec);
}

export function compileMcpObjectCodec<S extends ObjectShape>(
  validator: ObjectValidator<S>,
): StandardJsonCodec<
  InferValidator<ObjectValidator<S>>,
  StandardJsonInput<ObjectValidator<S>>,
  StandardJsonOutput<ObjectValidator<S>>
> & {
  readonly inputSchema: JsonObjectSchema;
  readonly outputSchema: JsonObjectSchema;
} {
  return compileStandardJsonCodec(validator) as StandardJsonCodec<
    InferValidator<ObjectValidator<S>>,
    StandardJsonInput<ObjectValidator<S>>,
    StandardJsonOutput<ObjectValidator<S>>
  > & {
    readonly inputSchema: JsonObjectSchema;
    readonly outputSchema: JsonObjectSchema;
  };
}
