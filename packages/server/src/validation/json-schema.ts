/**
 * The one contract → JSON Schema emission. Every schema AckerDB publishes comes
 * from this walk: MCP tool input/output schemas, the dependency-free Standard
 * Schema view, and the OpenAPI document. There is no second emitter — a
 * validator describes itself exactly once, whoever is asking.
 */
import type {
  Descriptor,
  EnumValidator,
  LiteralValidator,
  ObjectShape,
  ObjectValidator,
  StandardValidator,
  UnionValidator,
  VectorValidator,
} from "./v.ts";

const JSON_SCHEMA_2020_12 = "https://json-schema.org/draft/2020-12/schema";
const JSON_SCHEMA_DRAFT_07 = "http://json-schema.org/draft-07/schema#";

/** Canonical proto3-style int64 text. The emitted `pattern` and the codec share it. */
export const DECIMAL_PATTERN = "^(?:0|-?[1-9][0-9]*)$";
/** Canonical padded base64, the only bytes form a JSON boundary carries. */
export const BASE64_PATTERN = "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$";

/** Wire direction: an input accepts lossless forms an output never emits. */
export type JsonSchemaMode = "input" | "output";
export type JsonSchemaTarget = "draft-2020-12" | "draft-07" | (string & {});

export interface JsonSchemaOptions {
  /** Defaults to `input`. */
  readonly mode?: JsonSchemaMode;
  /** Defaults to draft 2020-12, the dialect OpenAPI 3.1 and MCP both speak. */
  readonly target?: JsonSchemaTarget;
  /**
   * A standard-JSON protocol boundary carries bigint, Identity, and bytes
   * losslessly as decimal and base64 strings. A plain runtime validator has no
   * such mapping, so those kinds are refused instead of described dishonestly.
   * Defaults to `true`.
   */
  readonly protocol?: boolean;
}

export interface JsonObjectSchema extends Readonly<Record<string, unknown>> {
  readonly $schema: typeof JSON_SCHEMA_2020_12;
  readonly type: "object";
  readonly properties: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly required?: readonly string[];
  readonly additionalProperties: false;
}

type JsonSchemaOf<V> = V extends ObjectValidator ? JsonObjectSchema : Record<string, unknown>;

interface Emission {
  readonly mode: JsonSchemaMode;
  readonly protocol: boolean;
}

/** The one vocabulary for validator kinds no JSON boundary can carry. */
export function rejectUnrepresentable(validator: StandardValidator, where: string): never {
  switch (validator.kind) {
    case "pk":
      throw new TypeError(
        `${where}: v.primaryKey() is not a standard-JSON value; use v.bigint() for a decimal string`,
      );
    case "scheduleAt":
      throw new TypeError(
        `${where}: v.scheduleAt() is not a standard-JSON value; use v.float() for a timestamp`,
      );
    case "tag":
      throw new TypeError(`${where}: v.tag() is valid only as a direct v.union() member`);
    default:
      throw new TypeError(
        `${where}: v.${validator.kind}() has no lossless standard-JSON protocol representation`,
      );
  }
}

function requireProtocol(emission: Emission, where: string, source: string): void {
  if (!emission.protocol) {
    throw new TypeError(`${where}: ${source} requires a standard-JSON protocol codec`);
  }
}

function described(
  validator: StandardValidator,
  schema: Record<string, unknown>,
): Record<string, unknown> {
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

function constraintSchema(descriptor: Descriptor): Record<string, unknown> {
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
function nullableSchema(inner: Record<string, unknown>): Record<string, unknown> {
  const type = inner.type;
  const mergeable =
    (typeof type === "string" ||
      (Array.isArray(type) && type.every((member) => typeof member === "string"))) &&
    NULLABLE_MERGE_BLOCKERS.every((key) => !(key in inner));
  if (!mergeable) return { anyOf: [inner, { type: "null" }] };
  const types = typeof type === "string" ? [type] : (type as readonly string[]);
  return types.includes("null") ? inner : { ...inner, type: [...types, "null"] };
}

function shapeSchema(
  shape: ObjectShape,
  where: string,
  emission: Emission,
): Record<string, unknown> {
  if (shape === null || typeof shape !== "object" || Array.isArray(shape)) {
    throw new TypeError(`${where}: an object shape must be a plain object of validators`);
  }
  const properties = Object.create(null) as Record<string, Record<string, unknown>>;
  const required: string[] = [];
  for (const [name, field] of Object.entries(shape)) {
    properties[name] = schemaOf(field, `${where}.${name}`, emission);
    if (field.kind !== "optional" && field.kind !== "nullish") required.push(name);
  }
  return {
    type: "object",
    properties,
    ...(required.length === 0 ? {} : { required }),
    additionalProperties: false,
  };
}

function unionSchema(
  validator: UnionValidator,
  where: string,
  emission: Emission,
): Record<string, unknown> {
  const members = validator.members;
  if (members === null || typeof members !== "object" || Array.isArray(members)) {
    throw new TypeError(`${where}: v.union() has invalid members`);
  }
  return {
    oneOf: Object.entries(members).map(([tag, member]) => ({
      type: "object",
      properties: {
        tag: { const: tag },
        value: member.kind === "tag"
          ? { type: "null" }
          : schemaOf(member, `${where}.${tag}.value`, emission),
      },
      required: member.kind === "optional" || member.kind === "nullish" ||
          (emission.mode === "input" && member.kind === "tag")
        ? ["tag"]
        : ["tag", "value"],
      additionalProperties: false,
    })),
  };
}

function fragmentSchema(
  validator: StandardValidator,
  where: string,
  emission: Emission,
): Record<string, unknown> {
  switch (validator.kind) {
    case "string":
      return { type: "string", ...constraintSchema(validator.descriptor()) };
    case "int":
      return { type: "integer", ...constraintSchema(validator.descriptor()) };
    case "float":
      return { type: "number", ...constraintSchema(validator.descriptor()) };
    case "boolean":
      return { type: "boolean" };
    case "bigint":
    case "identity":
      requireProtocol(emission, where, `v.${validator.kind}()`);
      return emission.mode === "input"
        ? { type: ["integer", "string"], pattern: DECIMAL_PATTERN }
        : { type: "string", pattern: DECIMAL_PATTERN };
    case "bytes":
      requireProtocol(emission, where, "v.bytes()");
      return { type: "string", pattern: BASE64_PATTERN, contentEncoding: "base64" };
    case "vector": {
      const dimensions = (validator as VectorValidator).dimensions;
      return {
        type: "array",
        items: { type: "number" },
        minItems: dimensions,
        maxItems: dimensions,
      };
    }
    case "jsonb":
      return {};
    case "enum": {
      const values = (validator as EnumValidator).values;
      if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
        throw new TypeError(`${where}: v.enum() has invalid string values`);
      }
      return { type: "string", enum: [...values] };
    }
    case "literal": {
      const value = (validator as LiteralValidator).value;
      if (typeof value === "bigint") {
        requireProtocol(emission, where, "v.literal(bigint)");
        return { const: value.toString() };
      }
      if (
        (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") ||
        (typeof value === "number" && !Number.isFinite(value))
      ) {
        throw new TypeError(`${where}: v.literal() has no standard-JSON protocol value`);
      }
      return { const: value };
    }
    case "array": {
      const element = (validator as StandardValidator & {
        readonly element?: StandardValidator;
      }).element;
      if (element === undefined) throw new TypeError(`${where}: v.array() has no element validator`);
      return {
        type: "array",
        items: schemaOf(element, `${where}[]`, emission),
        ...constraintSchema(validator.descriptor()),
      };
    }
    case "object":
      return shapeSchema((validator as ObjectValidator).shape, where, emission);
    case "union":
      return unionSchema(validator as UnionValidator, where, emission);
    case "nullable":
    case "optional":
    case "nullish": {
      const inner = (validator as StandardValidator & {
        readonly inner?: StandardValidator;
      }).inner;
      if (inner === undefined) {
        throw new TypeError(`${where}: .${validator.kind}() has no inner validator`);
      }
      const schema = schemaOf(inner, where, emission);
      return validator.kind === "optional" ? schema : nullableSchema(schema);
    }
    default:
      rejectUnrepresentable(validator, where);
  }
}

function schemaOf(
  validator: StandardValidator,
  where: string,
  emission: Emission,
): Record<string, unknown> {
  return described(validator, fragmentSchema(validator, where, emission));
}

function schemaUri(target: JsonSchemaTarget | undefined): string {
  if (target === undefined || target === "draft-2020-12") return JSON_SCHEMA_2020_12;
  if (target === "draft-07") return JSON_SCHEMA_DRAFT_07;
  throw new TypeError("AckerDB validators support JSON Schema draft-2020-12 and draft-07");
}

function emissionOf(options: JsonSchemaOptions): Emission {
  return { mode: options.mode ?? "input", protocol: options.protocol ?? true };
}

/**
 * The request schema for a function's or tool's `args`. Arguments always cross a
 * JSON protocol boundary in the input direction, so the shape is the only input.
 */
export function argsJsonSchema(args: ObjectShape): JsonObjectSchema {
  return {
    $schema: JSON_SCHEMA_2020_12,
    ...shapeSchema(args, "$", { mode: "input", protocol: true }),
  } as JsonObjectSchema;
}

/**
 * The schema for one validator — a `returns` value, an sse `yields` chunk, or a
 * whole tool output. Every call owns a fresh mutable graph, because Standard
 * Schema consumers are allowed to normalize the document in place.
 */
export function validatorJsonSchema<V extends StandardValidator>(
  validator: V,
  options?: JsonSchemaOptions,
): JsonSchemaOf<V>;
export function validatorJsonSchema(
  validator: StandardValidator,
  options: JsonSchemaOptions = {},
): Record<string, unknown> {
  return {
    $schema: schemaUri(options.target),
    ...schemaOf(validator, "$", emissionOf(options)),
  };
}
