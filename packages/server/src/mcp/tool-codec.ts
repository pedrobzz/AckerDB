/**
 * The standard-JSON boundary of one MCP tool, compiled once at declaration.
 *
 * The wire format is the HTTP surface's: `compileStandardJsonCodec` and
 * `validation/json-schema.ts` — the same codec and the same emitter — so a tool
 * and an `http: true` route on the same function describe one contract.
 *
 * MCP adds one rule HTTP does not need. `Tool.outputSchema` must be
 * `{"type":"object"}` and `structuredContent` must be an object, so a `returns`
 * that is not an object validator crosses wrapped under a single key. That key
 * is `value`, matching `ExposedHttpCodec.encodeValue` and an sse chunk frame's
 * `value`, so the same idea is spelled the same way everywhere.
 */
import { toStandardJson, type ApplicationError } from "@ackerdb/core";
import type { AnyRegistered } from "../app/functions.ts";
import {
  compileContractCodec,
  type StandardJsonCodec,
} from "../validation/standard-schema.ts";
import {
  argsJsonSchema,
  validatorJsonSchema,
  type JsonObjectSchema,
} from "../validation/json-schema.ts";
import type { StandardValidator } from "../validation/validator.ts";
import { v } from "../validation/v.ts";
import { isMcpContentValidator } from "./content.ts";
import { deepFreeze } from "../shared/immutable.ts";

/** The single key a non-object return crosses under. */
export const MCP_OUTPUT_WRAP_KEY = "value";

export interface McpToolCodec {
  /** Caller JSON → the native args the invocation path validates. */
  readonly decodeArgs: (args: unknown) => unknown;
  /** A return value as the object `structuredContent` requires. */
  readonly encodeOutput: (value: unknown) => Readonly<Record<string, unknown>>;
  /** A declared application error, its body converted through its declaration. */
  readonly encodeError: (error: ApplicationError) => unknown;
  readonly inputSchema: JsonObjectSchema;
  /** Absent for a content-block return: there is no JSON shape to publish. */
  readonly outputSchema: JsonObjectSchema | undefined;
  /** True when the function returns MCP content blocks rather than a value. */
  readonly returnsContent: boolean;
  /** True when a non-object `returns` is being wrapped under {@link MCP_OUTPUT_WRAP_KEY}. */
  readonly wrapsOutput: boolean;
  /** Standard Schema faces the local AI adapter hands to a model SDK. */
  readonly inputProtocolSchema: StandardJsonCodec<unknown>["inputProtocolSchema"];
  readonly outputProtocolSchema: StandardJsonCodec<unknown>["outputProtocolSchema"];
}

function wrappedOutputSchema(inner: Record<string, unknown>): JsonObjectSchema {
  // The inner document carries its own `$schema`; only the envelope declares one.
  const { $schema, ...schema } = inner;
  return {
    $schema,
    type: "object",
    properties: { [MCP_OUTPUT_WRAP_KEY]: schema },
    required: [MCP_OUTPUT_WRAP_KEY],
    additionalProperties: false,
  } as JsonObjectSchema;
}

export function compileMcpToolCodec(where: string, fn: AnyRegistered): McpToolCodec {
  const codec = (validator: Parameters<typeof compileContractCodec>[0], at: string) =>
    compileContractCodec(validator, at, "MCP surface");
  const args = codec(v.object(fn.args), `${where} args`);
  if (fn.returns === undefined) {
    throw new TypeError(
      `${where} must declare \`returns\`: a tool with no outputSchema gives a model nothing to reason about`,
    );
  }
  const returns = fn.returns;
  // Content blocks are wider than any JSON contract, so they bypass the
  // structured path entirely: no codec, no schema, no structuredContent.
  if (isMcpContentValidator(returns)) {
    return Object.freeze({
      decodeArgs: (raw: unknown) => args.decode(raw, "args"),
      encodeOutput: (raw: unknown) => returns.check(raw, "returns") as never,
      encodeError: contentError(fn, where, codec),
      inputSchema: deepFreeze(argsJsonSchema(fn.args)),
      outputSchema: undefined,
      wrapsOutput: false,
      returnsContent: true,
      inputProtocolSchema: args.inputProtocolSchema,
      outputProtocolSchema: args.outputProtocolSchema,
    });
  }
  const output = codec(returns, `${where} returns`);
  const declared = validatorJsonSchema(returns as StandardValidator, { mode: "output" }) as
    Record<string, unknown>;
  // The decision is the protocol's own rule, read off the document rather than
  // guessed from the validator's kind: `structuredContent` must be an object,
  // so a return that already emits one passes through and everything else is
  // wrapped. `v.record()` is an object here exactly as `v.object()` is.
  const wrapsOutput = declared.type !== "object";
  const errors = new Map<string, (value: unknown, path?: string) => unknown>(
    Object.entries(fn.errors ?? {}).map(([code, declaration]) => [
      code,
      codec(declaration.body, `${where} errors.${code}.body`).encode,
    ]),
  );
  return Object.freeze({
    decodeArgs: (raw: unknown) => args.decode(raw, "args"),
    encodeOutput: (raw: unknown) => {
      const encoded = output.encode(raw, "returns");
      return (wrapsOutput
        ? { [MCP_OUTPUT_WRAP_KEY]: encoded }
        : encoded) as Readonly<Record<string, unknown>>;
    },
    encodeError: (error: ApplicationError) => ({
      ...error,
      // An undeclared code reaches here only where the function declares no
      // errors at all; the invocation boundary rejects every other mismatch.
      body: (errors.get(error.code) ?? toStandardJson)(
        error.body,
        `errors.${error.code}.body`,
      ),
    }),
    // Wire schemas are published to every client, so they are deep-frozen
    // rather than handed to an SDK as mutable graphs.
    inputSchema: deepFreeze(argsJsonSchema(fn.args)),
    outputSchema: deepFreeze(
      wrapsOutput ? wrappedOutputSchema(declared) : (declared as JsonObjectSchema),
    ),
    wrapsOutput,
    returnsContent: false,
    inputProtocolSchema: args.inputProtocolSchema,
    outputProtocolSchema: output.outputProtocolSchema,
  });
}

/** Declared application errors cross the same way whichever return shape a tool has. */
function contentError(
  fn: AnyRegistered,
  where: string,
  codec: (validator: Parameters<typeof compileContractCodec>[0], at: string) => StandardJsonCodec<unknown>,
): (error: ApplicationError) => unknown {
  const errors = new Map<string, (value: unknown, path?: string) => unknown>(
    Object.entries(fn.errors ?? {}).map(([code, declaration]) => [
      code,
      codec(declaration.body, `${where} errors.${code}.body`).encode,
    ]),
  );
  return (error: ApplicationError) => ({
    ...error,
    body: (errors.get(error.code) ?? toStandardJson)(error.body, `errors.${error.code}.body`),
  });
}
