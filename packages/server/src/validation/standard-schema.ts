import type {
  InferValidatorJsonInput,
  InferValidatorJsonOutput,
  StandardValidator,
} from "./validator.ts";
import { validatorJsonSchema, type JsonSchemaTarget } from "./json-schema.ts";

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

export type StandardJsonInput<V extends StandardValidator> = InferValidatorJsonInput<V>;
export type StandardJsonOutput<V extends StandardValidator> = InferValidatorJsonOutput<V>;

export function createStandardSchemaProperties<Input, Output, JsonInput, JsonOutput>(
  validator: StandardValidator<Output, string, Input, JsonInput, JsonOutput>,
  validationError: (value: unknown) => value is Error,
): StandardSchemaProperties<Input, Output> {
  return Object.freeze({
    version: 1 as const,
    vendor: "ackerdb" as const,
    validate(value: unknown): StandardSchemaResult<Output> {
      try {
        return { value: validator.parse(value, "$input") };
      } catch (error) {
        if (!validationError(error)) throw error;
        return { issues: [{ message: error.message }] };
      }
    },
    jsonSchema: Object.freeze({
      input: (options: StandardJsonSchemaOptions) =>
        validatorJsonSchema(validator, {
          mode: "input",
          target: options.target,
          protocol: false,
        }),
      output: (options: StandardJsonSchemaOptions) =>
        validatorJsonSchema(validator, {
          mode: "output",
          target: options.target,
          protocol: false,
        }),
    }),
  });
}
