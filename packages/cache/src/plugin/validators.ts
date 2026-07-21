import {
  type Descriptor,
  type InferValidator,
  type InferValidatorInput,
  type StandardValidator,
} from "@dbzz/server";

type StandardResult<T> =
  | { readonly value: T; readonly issues?: undefined }
  | { readonly issues: readonly { readonly message: string }[] };

function issue(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validator<T, Input, K extends string>(definition: {
  readonly kind: K;
  readonly check: (value: unknown, path: string) => T;
  readonly tsType: () => string;
  readonly descriptor: () => Descriptor;
  readonly fields?: Readonly<Record<string, unknown>>;
}): StandardValidator<T, K, Input> {
  let result: StandardValidator<T, K, Input>;
  const plain = {
    kind: definition.kind,
    check: definition.check,
    tsType: definition.tsType,
    descriptor: definition.descriptor,
    ...(definition.fields ?? {}),
    describe: () => result,
    "~standard": {
      version: 1 as const,
      vendor: "dbzz" as const,
      validate(value: unknown): StandardResult<T> {
        try {
          return { value: definition.check(value, "value") };
        } catch (error) {
          return { issues: [{ message: issue(error) }] };
        }
      },
      jsonSchema: {
        input: () => Object.freeze({}),
        output: () => Object.freeze({}),
      },
    },
  };
  result = Object.freeze(plain) as unknown as StandardValidator<T, K, Input>;
  return result;
}

export function opaqueValidator<T>(
  check: (value: unknown, path: string) => T = (value) => value as T,
): StandardValidator<T, "jsonb", T> {
  return validator<T, T, "jsonb">({
    kind: "jsonb",
    check,
    tsType: () => "unknown",
    descriptor: () => ({ k: "jsonb" }),
  });
}

export function optionalValidator<V extends StandardValidator<unknown, string>>(
  inner: V,
): StandardValidator<
  InferValidator<V> | undefined,
  "optional",
  InferValidatorInput<V> | undefined
> {
  return validator<
    InferValidator<V> | undefined,
    InferValidatorInput<V> | undefined,
    "optional"
  >({
    kind: "optional",
    check(value, path) {
      return value === undefined
        ? undefined
        : inner.check(value, path) as InferValidator<V>;
    },
    tsType: () => `${inner.tsType()} | undefined`,
    descriptor: () => ({ k: "optional", inner: inner.descriptor() }),
    fields: { inner },
  });
}

export function normalizingValidator<
  V extends StandardValidator<unknown, string>,
  Output,
>(
  inner: V,
  normalize: (value: InferValidator<V>) => Output,
): StandardValidator<Output, V["kind"], InferValidatorInput<V>> {
  return validator<Output, InferValidatorInput<V>, V["kind"]>({
    kind: inner.kind,
    check: (value, path) => normalize(inner.check(value, path) as InferValidator<V>),
    tsType: () => inner.tsType(),
    descriptor: () => inner.descriptor(),
  });
}

export function isStandardValidator(
  value: unknown,
): value is StandardValidator<unknown, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { kind?: unknown }).kind === "string" &&
    typeof (value as { check?: unknown }).check === "function" &&
    typeof (value as { tsType?: unknown }).tsType === "function" &&
    typeof (value as { descriptor?: unknown }).descriptor === "function" &&
    typeof (value as { describe?: unknown }).describe === "function" &&
    typeof (value as { "~standard"?: unknown })["~standard"] === "object"
  );
}
