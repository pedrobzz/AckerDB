/** Shared JSON Schema vocabulary and the root document wrapper. */
import type { StandardValidator } from "./validator.ts";
import { BASE64_PATTERN, DECIMAL_PATTERN } from "./standard-json.ts";

export { BASE64_PATTERN, DECIMAL_PATTERN } from "./standard-json.ts";

const JSON_SCHEMA_2020_12 = "https://json-schema.org/draft/2020-12/schema";
const JSON_SCHEMA_DRAFT_07 = "http://json-schema.org/draft-07/schema#";

export type JsonSchemaMode = "input" | "output";
export type JsonSchemaTarget = "draft-2020-12" | "draft-07" | (string & {});
export type JsonSchema = Record<string, unknown>;

export interface JsonSchemaOptions {
  /** Defaults to `input`. */
  readonly mode?: JsonSchemaMode;
  /** Defaults to draft 2020-12, the dialect OpenAPI 3.1 speaks. */
  readonly target?: JsonSchemaTarget;
  /** Whether the schema describes the validator's Standard JSON representation. */
  readonly protocol?: boolean;
  /** Nested validators receive their location from their owning composite. */
  readonly path?: string;
}

export interface JsonSchemaContext {
  readonly mode: JsonSchemaMode;
  readonly target?: JsonSchemaTarget;
  readonly protocol: boolean;
  readonly path: string;
}

interface JsonObjectSchema extends Readonly<Record<string, unknown>> {
  readonly $schema: typeof JSON_SCHEMA_2020_12;
  readonly type: "object";
  readonly properties: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly required?: readonly string[];
  readonly additionalProperties: false;
}

type JsonSchemaOf<V> = V extends StandardValidator<unknown, "object">
  ? JsonObjectSchema
  : Record<string, unknown>;

export function jsonSchemaContext(options: JsonSchemaOptions = {}): JsonSchemaContext {
  return {
    mode: options.mode ?? "input",
    target: options.target,
    protocol: options.protocol ?? true,
    path: options.path ?? "$",
  };
}

export function requireJsonProtocol(context: JsonSchemaContext, source: string): void {
  if (!context.protocol) {
    throw new TypeError(`${context.path}: ${source} requires a Standard JSON schema projection`);
  }
}

export function decimalJsonSchema(context: JsonSchemaContext, source: string): JsonSchema {
  requireJsonProtocol(context, source);
  return context.mode === "input"
    ? { type: ["integer", "string"], pattern: DECIMAL_PATTERN }
    : { type: "string", pattern: DECIMAL_PATTERN };
}

export function base64JsonSchema(context: JsonSchemaContext): JsonSchema {
  requireJsonProtocol(context, "v.bytes()");
  return { type: "string", pattern: BASE64_PATTERN, contentEncoding: "base64" };
}

const NULLABLE_MERGE_BLOCKERS = ["enum", "const", "anyOf", "oneOf", "allOf", "not", "$ref"] as const;

export function nullableJsonSchema(inner: JsonSchema): JsonSchema {
  const type = inner.type;
  const mergeable =
    (typeof type === "string" ||
      (Array.isArray(type) && type.every((member) => typeof member === "string"))) &&
    NULLABLE_MERGE_BLOCKERS.every((key) => !(key in inner));
  if (!mergeable) return { anyOf: [inner, { type: "null" }] };
  const types = typeof type === "string" ? [type] : (type as readonly string[]);
  return types.includes("null") ? inner : { ...inner, type: [...types, "null"] };
}

export function describedJsonSchema(
  description: string | undefined,
  schema: JsonSchema,
): JsonSchema {
  if (description === undefined || description === "") return schema;
  const inherited = typeof schema.description === "string" ? schema.description : "";
  return {
    ...schema,
    description: inherited === "" || inherited === description
      ? description
      : `${description} ${inherited}`,
  };
}

function schemaUri(target: JsonSchemaTarget | undefined): string {
  if (target === undefined || target === "draft-2020-12") return JSON_SCHEMA_2020_12;
  if (target === "draft-07") return JSON_SCHEMA_DRAFT_07;
  throw new TypeError("AckerDB validators support JSON Schema draft-2020-12 and draft-07");
}

/** Add the dialect declaration to the schema fragment owned by the validator. */
export function validatorJsonSchema<V extends StandardValidator>(
  validator: V,
  options?: JsonSchemaOptions,
): JsonSchemaOf<V>;
export function validatorJsonSchema(
  validator: StandardValidator,
  options: JsonSchemaOptions = {},
): Record<string, unknown> {
  const context = jsonSchemaContext(options);
  return {
    $schema: schemaUri(context.target),
    ...validator.toJsonSchema(context),
  };
}
