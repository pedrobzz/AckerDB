import { Buffer } from "node:buffer";
import {
  type EnumValidator,
  type InferValidator,
  type LiteralValidator,
  type ObjectShape,
  type ObjectValidator,
  type StandardValidator,
  type UnionValidator,
} from "./dbz.ts";
import { deepFreeze } from "./immutable.ts";
import { assertStandardJson } from "./standard-json.ts";
import { isValidationError, ValidationError } from "./validation-error.ts";

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
  readonly vendor: "dbzz";
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
 * One lossless standard-JSON boundary compiled from a DBZZ validator. HTTP and
 * local model adapters consume the same codec; DBZZ's ordinary runtime input
 * type remains unchanged.
 */
export interface StandardJsonCodec<Output> {
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema: Readonly<Record<string, unknown>>;
  readonly decode: (value: unknown, path?: string) => Output;
  readonly encode: (value: unknown, path?: string) => unknown;
  /** Validate canonical model input JSON without converting the exposed value. */
  readonly inputProtocolSchema: StandardJsonProtocolSchema;
  /** Validate canonical structured output JSON without converting the exposed value. */
  readonly outputProtocolSchema: StandardJsonProtocolSchema;
  readonly "~standard": StandardSchemaProperties<unknown, Output>;
}

/** Standard Schema view consumed by JSON-native model/tool runtimes. */
export interface StandardJsonProtocolSchema {
  readonly "~standard": StandardSchemaProperties<unknown, unknown>;
}

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
  return validator.description === undefined
    ? schema
    : { ...schema, description: validator.description };
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

function canonicalDecimal(value: unknown, path: string): bigint {
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
    throw new TypeError(`${where}: dbz.object() has an invalid shape`);
  }
  const fields = Object.entries(validator.shape).map(([name, field]) => [
    name,
    field,
    compileNode(field, `${where}.${name}`, protocol),
  ] as const);
  return {
    schema(mode) {
      const properties: Record<string, Readonly<Record<string, unknown>>> = {};
      const required: string[] = [];
      for (const [name, field, node] of fields) {
        properties[name] = node.schema(mode);
        if (mode === "output" || field.kind !== "nullable") required.push(name);
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
      for (const [name, , node] of fields) {
        if (mode === "output" && !Object.hasOwn(input, name)) {
          throw new ValidationError(`${path}.${name}: required output field is missing`);
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
      for (const [name, , node] of fields) {
        node.preflight?.(input[name], `${path}.${name}`);
      }
    },
    encode(value, path) {
      const checked = value as Record<string, unknown>;
      const encoded: Record<string, unknown> = {};
      for (const [name, , node] of fields) {
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
    throw new TypeError(`${where}: dbz.union() has invalid members`);
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
          required: mode === "output" || (
            member.validator.kind !== "tag" && member.validator.kind !== "nullable"
          )
            ? ["tag", "value"]
            : ["tag"],
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
      if (mode === "output" && !Object.hasOwn(input, "value")) {
        throw new ValidationError(`${path}.value: required output field is missing`);
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
      return checkedNode(validator, { type: "string" });
    case "number":
      return checkedNode(validator, { type: "number" });
    case "boolean":
      return checkedNode(validator, { type: "boolean" });
    case "bigint":
    case "identity":
      if (!protocol) {
        throw new TypeError(
          `${where}: dbz.${validator.kind}() requires a standard-JSON protocol codec`,
        );
      }
      return {
        schema: () => described(validator, { type: "string", pattern: DECIMAL_PATTERN }),
        decode(value, path) {
          return canonicalDecimal(value, path);
        },
        encode(value) {
          return (value as bigint).toString();
        },
      };
    case "bytes":
      if (!protocol) {
        throw new TypeError(`${where}: dbz.bytes() requires a standard-JSON protocol codec`);
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
        throw new TypeError(`${where}: dbz.enum() has invalid string values`);
      }
      return checkedNode(validator, { type: "string", enum: [...values] });
    }
    case "literal": {
      const value = (validator as LiteralValidator).value;
      if (typeof value === "bigint") {
        if (!protocol) {
          throw new TypeError(`${where}: dbz.literal(bigint) requires a standard-JSON protocol codec`);
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
        throw new TypeError(`${where}: dbz.literal() has no standard-JSON protocol value`);
      }
      return checkedNode(validator, { const: value });
    }
    case "array": {
      const element = (validator as StandardValidator & {
        readonly element?: StandardValidator;
      }).element;
      if (element === undefined) throw new TypeError(`${where}: dbz.array() has no element validator`);
      const node = compileNode(element, `${where}[]`, protocol);
      return {
        schema: (mode) => described(validator, { type: "array", items: node.schema(mode) }),
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
    case "nullable": {
      const inner = (validator as StandardValidator & {
        readonly inner?: StandardValidator;
      }).inner;
      if (inner === undefined) throw new TypeError(`${where}: dbz.nullable() has no inner validator`);
      const node = compileNode(inner, where, protocol);
      return {
        schema: (mode) => described(validator, {
          anyOf: [node.schema(mode), { type: "null" }],
        }),
        decode(value, path, mode) {
          return value === null || value === undefined
            ? value
            : node.decode(value, path, mode);
        },
        preflight(value, path) {
          if (value !== null && value !== undefined) node.preflight?.(value, path);
        },
        encode(value, path) {
          return value === null ? null : node.encode(value, path);
        },
      };
    }
    case "pk":
      throw new TypeError(
        `${where}: dbz.primaryKey() is not an MCP value; use dbz.bigint() for a decimal string`,
      );
    case "scheduleAt":
      throw new TypeError(
        `${where}: dbz.scheduleAt() is not an MCP value; use dbz.number() for a timestamp`,
      );
    case "tag":
      throw new TypeError(`${where}: dbz.tag() is valid only as a direct dbz.union() member`);
    default:
      throw new TypeError(
        `${where}: dbz.${validator.kind}() has no lossless standard-JSON protocol representation`,
      );
  }
}

function schemaUri(options: StandardJsonSchemaOptions): string {
  if (options?.target === "draft-2020-12") return JSON_SCHEMA_2020_12;
  if (options?.target === "draft-07") return JSON_SCHEMA_DRAFT_07;
  throw new TypeError("DBZZ validators support JSON Schema draft-2020-12 and draft-07");
}

function schemaFor(
  node: ProtocolNode,
  mode: SchemaMode,
  options: StandardJsonSchemaOptions,
): Readonly<Record<string, unknown>> {
  return deepFreeze({ $schema: schemaUri(options), ...node.schema(mode) });
}

function jsonSchema(
  validator: StandardValidator,
  mode: SchemaMode,
  options: StandardJsonSchemaOptions,
): Readonly<Record<string, unknown>> {
  return schemaFor(compileNode(validator, "$", false), mode, options);
}

export function createStandardSchemaProperties<Input, Output>(
  validator: StandardValidator<Output, string, Input>,
  validationError: (value: unknown) => value is Error,
): StandardSchemaProperties<Input, Output> {
  return Object.freeze({
    version: 1 as const,
    vendor: "dbzz" as const,
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
): StandardJsonCodec<InferValidator<V>> {
  const node = compileNode(validator, "$", true);
  const inputSchema = schemaFor(node, "input", { target: "draft-2020-12" });
  const outputSchema = schemaFor(node, "output", { target: "draft-2020-12" });
  const decode = (value: unknown, path = "$input") =>
    validator.check(node.decode(value, path, "input"), path) as InferValidator<V>;
  const encode = (value: unknown, path = "$output") => {
    node.preflight?.(value, path);
    return node.encode(validator.check(value, path), path);
  };
  const protocolSchema = (mode: SchemaMode): StandardJsonProtocolSchema => Object.freeze({
    "~standard": Object.freeze({
      version: 1 as const,
      vendor: "dbzz" as const,
      validate(value: unknown): StandardSchemaResult<unknown> {
        const path = mode === "input" ? "$input" : "$output";
        try {
          validator.check(node.decode(value, path, mode), path);
          return { value };
        } catch (error) {
          if (!isValidationError(error)) throw error;
          return { issues: [{ message: error.message }] };
        }
      },
      jsonSchema: Object.freeze({
        input: (options: StandardJsonSchemaOptions) => schemaFor(node, mode, options),
        output: (options: StandardJsonSchemaOptions) => schemaFor(node, mode, options),
      }),
    }),
  });
  const codec: StandardJsonCodec<InferValidator<V>> = {
    inputSchema,
    outputSchema,
    decode,
    encode,
    inputProtocolSchema: protocolSchema("input"),
    outputProtocolSchema: protocolSchema("output"),
    "~standard": Object.freeze({
      version: 1 as const,
      vendor: "dbzz" as const,
      validate(value: unknown): StandardSchemaResult<InferValidator<V>> {
        try {
          return { value: decode(value) };
        } catch (error) {
          if (!isValidationError(error)) throw error;
          return { issues: [{ message: error.message }] };
        }
      },
      jsonSchema: Object.freeze({
        input: (options: StandardJsonSchemaOptions) => schemaFor(node, "input", options),
        output: (options: StandardJsonSchemaOptions) => schemaFor(node, "output", options),
      }),
    }),
  };
  return Object.freeze(codec);
}

export function compileMcpObjectCodec<S extends ObjectShape>(
  validator: ObjectValidator<S>,
): StandardJsonCodec<InferValidator<ObjectValidator<S>>> & {
  readonly inputSchema: JsonObjectSchema;
  readonly outputSchema: JsonObjectSchema;
} {
  return compileStandardJsonCodec(validator) as StandardJsonCodec<InferValidator<ObjectValidator<S>>> & {
    readonly inputSchema: JsonObjectSchema;
    readonly outputSchema: JsonObjectSchema;
  };
}
