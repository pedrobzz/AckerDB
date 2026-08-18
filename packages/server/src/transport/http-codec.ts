/** Standard-JSON operations derived from registered function contracts. */
import { toStandardJson, type ApplicationError } from "@ackerdb/core";
import type { AnyRegistered, AnyRegisteredSse } from "../app/functions.ts";
import { compileContractCodec } from "../validation/standard-schema.ts";
import { v } from "../validation/v.ts";

interface HttpContract {
  readonly decodeArgs: (args: unknown) => unknown;
  readonly encodeValue: (value: unknown) => unknown;
  readonly encodeError: (error: ApplicationError) => unknown;
}

type ValueEncoder = (value: unknown, path?: string) => unknown;

const contracts = new WeakMap<AnyRegistered, HttpContract>();

/** Compile and cache the complete boundary before Runtime autonomous work starts. */
export function prepareHttpContract(address: string, fn: AnyRegistered): void {
  if (contracts.has(fn)) return;

  const where = `HTTP-exposed function "${address}"`;
  const compile = (validator: Parameters<typeof compileContractCodec>[0], at: string) =>
    compileContractCodec(validator, at, "HTTP surface");
  const args = compile(v.object(fn.args), `${where} args`);
  const sse = fn.kind === "sse";
  const encodeValue: ValueEncoder = sse
    ? compile((fn as AnyRegisteredSse).yields, `${where} yields`).encode
    : fn.returns === undefined
      ? toStandardJson
      : compile(fn.returns, `${where} returns`).encode;
  const valuePath = sse ? "chunk" : "returns";
  const errors = new Map<string, ValueEncoder>(
    Object.entries(fn.errors ?? {}).map(([code, declaration]) => [
      code,
      compile(declaration.body, `${where} errors.${code}.body`).encode,
    ]),
  );
  const compiled = Object.freeze({
    decodeArgs: (raw: unknown) => args.decode(raw, "args"),
    encodeValue: (raw: unknown) => encodeValue(raw, valuePath),
    encodeError: (error: ApplicationError) => ({
      ...error,
      body: (errors.get(error.code) ?? toStandardJson)(
        error.body,
        `errors.${error.code}.body`,
      ),
    }),
  });
  contracts.set(fn, compiled);
}

function contract(address: string, fn: AnyRegistered): HttpContract {
  prepareHttpContract(address, fn);
  return contracts.get(fn)!;
}

export function decodeHttpArgs(address: string, fn: AnyRegistered, value: unknown): unknown {
  return contract(address, fn).decodeArgs(value);
}

export function encodeHttpValue(address: string, fn: AnyRegistered, value: unknown): unknown {
  return contract(address, fn).encodeValue(value);
}

export function encodeHttpError(
  address: string,
  fn: AnyRegistered,
  error: ApplicationError,
): unknown {
  return contract(address, fn).encodeError(error);
}
