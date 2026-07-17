import type {
  EnumValidator,
  ObjectShape,
  ObjectValidator,
  StandardValidator,
  UnionValidator,
} from "./dbz.ts";
import { deepFreeze } from "./immutable.ts";

const JSON_SCHEMA_2020_12 = "https://json-schema.org/draft/2020-12/schema";
const JSON_SCHEMA_DRAFT_07 = "http://json-schema.org/draft-07/schema#";

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

type SchemaMode = "input" | "output";

function described(
  validator: StandardValidator,
  schema: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return validator.description === undefined
    ? schema
    : { ...schema, description: validator.description };
}

function objectFragment(
  validator: ObjectValidator,
  mode: SchemaMode,
  where: string,
): Omit<JsonObjectSchema, "$schema"> {
  const properties: Record<string, Readonly<Record<string, unknown>>> = {};
  const required: string[] = [];
  for (const [name, field] of Object.entries(validator.shape)) {
    properties[name] = schemaFragment(field, mode, `${where}.${name}`);
    if (mode === "output" || field.kind !== "nullable") required.push(name);
  }
  return {
    type: "object",
    properties,
    ...(required.length === 0 ? {} : { required }),
    additionalProperties: false,
  };
}

function unionFragment(
  validator: UnionValidator,
  mode: SchemaMode,
  where: string,
): Readonly<Record<string, unknown>> {
  return {
    oneOf: Object.entries(validator.members).map(([tag, member]) => ({
      type: "object",
      properties: {
        tag: { const: tag },
        value: member.kind === "tag"
          ? { type: "null" }
          : schemaFragment(member, mode, `${where}.${tag}.value`),
      },
      required: mode === "output" || (member.kind !== "tag" && member.kind !== "nullable")
        ? ["tag", "value"]
        : ["tag"],
      additionalProperties: false,
    })),
  };
}

function schemaFragment(
  validator: StandardValidator,
  mode: SchemaMode,
  where: string,
): Readonly<Record<string, unknown>> {
  let schema: Readonly<Record<string, unknown>>;
  switch (validator.kind) {
    case "string":
      schema = { type: "string" };
      break;
    case "number":
      schema = { type: "number" };
      break;
    case "boolean":
      schema = { type: "boolean" };
      break;
    case "jsonb":
      schema = {};
      break;
    case "enum":
      schema = {
        type: "string",
        enum: [...(validator as EnumValidator).values],
      };
      break;
    case "literal": {
      const value = validator.descriptor()["v"];
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
        throw new TypeError(`${where}: dbz.literal() is not standard-JSON representable`);
      }
      schema = { const: value };
      break;
    }
    case "array":
      schema = {
        type: "array",
        items: schemaFragment(
          (validator as StandardValidator & { readonly element: StandardValidator }).element,
          mode,
          `${where}[]`,
        ),
      };
      break;
    case "object":
      schema = objectFragment(validator as ObjectValidator, mode, where);
      break;
    case "union":
      schema = unionFragment(validator as UnionValidator, mode, where);
      break;
    case "nullable":
      schema = {
        anyOf: [
          schemaFragment(
            (validator as StandardValidator & { readonly inner: StandardValidator }).inner,
            mode,
            where,
          ),
          { type: "null" },
        ],
      };
      break;
    default:
      throw new TypeError(
        `${where}: dbz.${validator.kind}() does not yet have a lossless standard-JSON representation`,
      );
  }
  return described(validator, schema);
}

function schemaUri(options: StandardJsonSchemaOptions): string {
  if (options?.target === "draft-2020-12") return JSON_SCHEMA_2020_12;
  if (options?.target === "draft-07") return JSON_SCHEMA_DRAFT_07;
  throw new TypeError("DBZZ validators support JSON Schema draft-2020-12 and draft-07");
}

function jsonSchema(
  validator: StandardValidator,
  mode: SchemaMode,
  options: StandardJsonSchemaOptions,
): Readonly<Record<string, unknown>> {
  return {
    $schema: schemaUri(options),
    ...schemaFragment(validator, mode, "$"),
  };
}

export function createStandardSchemaProperties<Input, Output>(
  validator: StandardValidator<Output, string, Input>,
  isValidationError: (value: unknown) => value is Error,
): StandardSchemaProperties<Input, Output> {
  return Object.freeze({
    version: 1 as const,
    vendor: "dbzz" as const,
    validate(value: unknown): StandardSchemaResult<Output> {
      try {
        return { value: validator.check(value, "$input") };
      } catch (error) {
        if (!isValidationError(error)) throw error;
        return { issues: [{ message: error.message }] };
      }
    },
    jsonSchema: Object.freeze({
      input: (options: StandardJsonSchemaOptions) => jsonSchema(validator, "input", options),
      output: (options: StandardJsonSchemaOptions) => jsonSchema(validator, "output", options),
    }),
  });
}

export function mcpObjectSchema<S extends ObjectShape>(
  validator: ObjectValidator<S>,
  mode: SchemaMode,
): JsonObjectSchema {
  return deepFreeze(
    jsonSchema(validator, mode, { target: "draft-2020-12" }),
  ) as JsonObjectSchema;
}
