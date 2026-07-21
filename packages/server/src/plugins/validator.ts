import {
  makeValidator,
  type InferValidator,
  type InferValidatorInput,
  type StandardValidator,
} from "../validation/v.ts";

export function isStandardValidator(
  value: unknown,
): value is StandardValidator<unknown, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { kind?: unknown }).kind === "string" &&
    typeof (value as { check?: unknown }).check === "function" &&
    typeof (value as { tsType?: unknown }).tsType === "function" &&
    typeof (value as { descriptor?: unknown }).descriptor === "function"
  );
}

function opaque<T>(
  check: (value: unknown, path: string) => T = (value) => value as T,
): StandardValidator<T, "jsonb", T> {
  return makeValidator<T, "jsonb", object, T>(
    "jsonb",
    {
      check,
      tsType: () => "unknown",
      descriptor: () => ({ k: "jsonb" }),
    },
    undefined,
    "none",
  );
}

function optional<V extends StandardValidator<unknown, string>>(
  inner: V,
): StandardValidator<
  InferValidator<V> | undefined,
  "optional",
  InferValidatorInput<V> | undefined
> {
  return makeValidator<
    InferValidator<V> | undefined,
    "optional",
    { readonly inner: V },
    InferValidatorInput<V> | undefined
  >(
    "optional",
    {
      check(value, path) {
        return value === undefined
          ? undefined
          : inner.check(value, path) as InferValidator<V>;
      },
      tsType: () => `${inner.tsType()} | undefined`,
      descriptor: () => ({ k: "optional", inner: inner.descriptor() }),
    },
    { inner },
    "none",
  );
}

function normalize<
  V extends StandardValidator<unknown, string>,
  Output,
>(
  inner: V,
  normalizer: (value: InferValidator<V>) => Output,
): StandardValidator<Output, V["kind"], InferValidatorInput<V>> {
  return makeValidator<Output, V["kind"], object, InferValidatorInput<V>>(
    inner.kind,
    {
      check: (value, path) => normalizer(inner.check(value, path) as InferValidator<V>),
      tsType: () => inner.tsType(),
      descriptor: () => inner.descriptor(),
    },
    undefined,
    "none",
    inner.description,
  );
}

/** Validator operations whose normalized output remains private to a Plugin handler. */
export const pluginValidator = Object.freeze({
  is: isStandardValidator,
  opaque,
  optional,
  normalize,
});
