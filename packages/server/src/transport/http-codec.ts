/**
 * The wire format of the exposed HTTP surface: standard JSON, derived from the
 * function's own contract. `v.bigint()` and `v.identity()` cross as canonical
 * decimal strings and `v.bytes()` as base64 — exactly what
 * `validation/json-schema.ts` publishes — so a caller obeying the OpenAPI
 * document is understood and a generated client receives what it was promised.
 *
 * This is deliberately not Protocol-2's escape form (`{"$":"b","v":"1"}`),
 * which the WebSocket session keeps: that form carries values JSON cannot, and
 * it is unreadable to the external callers this surface exists for.
 *
 * Every codec is compiled once per exposed function at registration, so a
 * contract no standard-JSON boundary can carry fails the load rather than the
 * first caller, and no request pays for compilation.
 */
import { toStandardJson, type ApplicationError } from "@ackerdb/core";
import type { AnyRegistered, AnyRegisteredSse } from "../app/functions.ts";
import { compileStandardJsonCodec, type StandardJsonCodec } from "../validation/standard-schema.ts";
import { v, type StandardValidator, type Validator } from "../validation/v.ts";

/** One exposed function's standard-JSON boundary, both directions. */
export interface ExposedHttpCodec {
  /** Caller JSON → the native args the invocation path validates. */
  readonly decodeArgs: (args: unknown) => unknown;
  /** A return value, or one sse chunk, as the JSON the document publishes. */
  readonly encodeValue: (value: unknown) => unknown;
  /** An application error, its body converted through the declaration it names. */
  readonly encodeError: (error: ApplicationError) => unknown;
}

/**
 * A contract no standard-JSON boundary can carry is refused where it is
 * declared, naming the function and the part of its contract that cannot cross.
 */
function contractCodec(
  validator: Validator<unknown, string>,
  where: string,
): StandardJsonCodec<unknown> {
  try {
    // Declarations type their validators as the erased `Validator` face;
    // registration already refuses anything `v` did not build.
    return compileStandardJsonCodec(validator as StandardValidator);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new TypeError(
      `${where} cannot cross the HTTP surface's standard-JSON boundary: ${detail}`,
      { cause },
    );
  }
}

/** How one value crosses: a compiled contract codec, or the structural mapping. */
type ValueEncoder = (value: unknown, path?: string) => unknown;

export function compileExposedHttpCodec(address: string, fn: AnyRegistered): ExposedHttpCodec {
  const where = `HTTP-exposed function "${address}"`;
  const args = contractCodec(v.object(fn.args), `${where} args`);
  const sse = fn.kind === "sse";
  // `returns` is optional, and a value with no validator to describe it crosses
  // through the same structural mapping a declared one produces: declaring a
  // validator changes what a caller is promised, never what one receives.
  const encodeValue: ValueEncoder = sse
    ? contractCodec((fn as AnyRegisteredSse).yields, `${where} yields`).encode
    : fn.returns === undefined
      ? toStandardJson
      : contractCodec(fn.returns, `${where} returns`).encode;
  const valuePath = sse ? "chunk" : "returns";
  const errors = new Map<string, ValueEncoder>(
    Object.entries(fn.errors ?? {}).map(([code, declaration]) => [
      code,
      contractCodec(declaration.body, `${where} errors.${code}.body`).encode,
    ]),
  );
  return Object.freeze({
    decodeArgs: (raw: unknown) => args.decode(raw, "args"),
    encodeValue: (raw: unknown) => encodeValue(raw, valuePath),
    encodeError: (error: ApplicationError) => ({
      ...error,
      // An undeclared code reaches here only where the function declares no
      // errors at all; the invocation boundary rejects every other mismatch.
      body: (errors.get(error.code) ?? toStandardJson)(
        error.body,
        `errors.${error.code}.body`,
      ),
    }),
  });
}
