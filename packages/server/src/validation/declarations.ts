import {
  isResult,
  type ApplicationError,
  type Result,
} from "@ackerdb/core";
import type {
  Expand,
  InferValidator,
  InferValidatorInput,
  ObjectShape,
  Validator,
} from "./v.ts";

export function validateArgsShape(args: ObjectShape, prefix = "args"): void {
  for (const [name, validator] of Object.entries(args)) {
    if (
      validator.kind === "pk" ||
      validator.kind === "scheduleAt" ||
      validator.kind === "tag"
    ) {
      throw new Error(
        `${prefix}.${name}: v.${validator.kind}() is not a valid argument validator`,
      );
    }
  }
}

export type DeclarationInputs<
  Declarations extends Readonly<Record<string, Validator<unknown, string>>>,
> = {
  readonly [Name in keyof Declarations]: Expand<
    InferValidatorInput<Declarations[Name]>
  >;
};

export type DeclarationOutputs<
  Declarations extends Readonly<Record<string, Validator<unknown, string>>>,
> = {
  readonly [Name in keyof Declarations]: Expand<
    InferValidator<Declarations[Name]>
  >;
};

export type AuthorizationState<Value> =
  Awaited<Value> extends Result<infer State, infer _Error>
    ? State
    : Awaited<Value>;

export type AuthorizationError<Value> =
  Awaited<Value> extends Result<infer _State, infer Error>
    ? Error
    : never;

export function validateDeclaration(
  value: unknown,
  path: string,
): asserts value is Validator<unknown, string> {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as Validator).kind !== "string" ||
    typeof (value as Validator).check !== "function"
  ) {
    throw new TypeError(`${path} must be a v validator`);
  }
}

export function validateEventDeclarations(
  value: unknown,
  path: string,
): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be an event validator map`);
  }
  for (const [name, declaration] of Object.entries(value)) {
    if (name.length === 0) {
      throw new TypeError(`${path} event names must be non-empty`);
    }
    validateDeclaration(declaration, `${path}.${name}`);
  }
}

/** Normalize raw authorization state and typed application rejections. */
export function authorizationResult(
  value: unknown,
): { readonly ok: true; readonly state: unknown } | {
  readonly ok: false;
  readonly error: ApplicationError;
} {
  if (!isResult(value)) return Object.freeze({ ok: true, state: value });
  return value.ok
    ? Object.freeze({ ok: true, state: value.data })
    : Object.freeze({ ok: false, error: value.error as ApplicationError });
}
