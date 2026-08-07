import { AsyncLocalStorage } from "node:async_hooks";
import type { Principal } from "../auth/credentials.ts";
import { CREDENTIAL_ISSUER } from "../auth/credential-token.ts";
import { isScopeGrant } from "../auth/scopes.ts";
import { effectiveChildScopes } from "../auth/child-credentials.ts";
import { AckerDBError, throwIfAborted } from "../shared/errors.ts";
import type { ProcedureCtx } from "../app/functions.ts";
import type {
  AnyMcpDeclaration,
  AnyMcpToolEntryRecord,
  AnyRegisteredMcpTool,
  McpDeclaration,
  McpEndpointDeclaration,
} from "./index.ts";
import type { Registered } from "../app/functions.ts";
import type {
  McpCallToolResult,
  McpJsonValue,
} from "./content.ts";
import { isMcpToolAuthorized } from "./tool-access.ts";
import type { Schema } from "../schema/definition.ts";
import type {
  StandardJsonInput,
  StandardJsonOutput,
  StandardJsonProtocolSchema,
} from "../validation/standard-schema.ts";
import type { ObjectShape, ObjectValidator } from "../validation/composites.ts";

/**
 * Every tool declares `returns`, so every local result is structured JSON.
 * Content blocks have no path here until they return as a function contract.
 */
type McpAiContent =
  | { type: "text"; text: string }
  | { type: "file"; mediaType: string; data: { type: "data"; data: string } };

export type McpAiModelOutput =
  | { type: "json"; value: McpJsonValue }
  | { type: "content"; value: McpAiContent[] };

export interface McpAiTool<Input = unknown, Output = unknown> {
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: StandardJsonProtocolSchema<Input>;
  readonly outputSchema?: StandardJsonProtocolSchema<Output>;
  readonly execute: (
    input: Input,
    options?: { readonly abortSignal?: AbortSignal },
  ) => Promise<Output>;
  readonly toModelOutput: (options: {
    readonly toolCallId: string;
    readonly input: Input;
    readonly output: Output;
  }) => McpAiModelOutput;
}

/**
 * What one tool answers with: `structuredContent`, which is the function's
 * return when that already emits a JSON object and `{ value }` otherwise. The
 * branch mirrors `compileMcpToolCodec`'s, read here off the declared data type
 * rather than off the emitted schema.
 *
 * A declared application error does not appear here. `execute` throws it, so a
 * success keeps one exact type instead of a union every caller must narrow.
 */
type McpAiSuccess<R> = R extends { readonly ok: true; readonly data: infer D } ? D : R;

/**
 * The standard-JSON face of a value, mirroring `compileStandardJsonCodec` at the
 * type level: `bigint` (and therefore `Identity`) and `Uint8Array` cross as
 * strings, everything else structurally.
 *
 * This reads the declared *data* type rather than the `returns` validator,
 * because `Registered` erases the validator to `Validator<unknown, string>`.
 * The two agree for every shape `v` can build.
 */
type McpAiStandardJson<T> = T extends bigint ? string
  : T extends Uint8Array ? string
  : T extends string | number | boolean | null | undefined ? T
  : T extends readonly (infer E)[] ? readonly McpAiStandardJson<E>[]
  : T extends Readonly<Record<string, unknown>>
    ? { readonly [K in keyof T]: McpAiStandardJson<T[K]> }
  : T;

type McpAiStructuredOutput<R> = McpAiStandardJson<McpAiSuccess<R>> extends infer D
  ? D extends Readonly<Record<string, unknown>> ? D : { readonly value: D }
  : never;

type McpAiToolFromEntry<Entry> = Entry extends {
  readonly fn: Registered<any, infer A extends ObjectShape, any, infer R, any>;
} ? McpAiTool<StandardJsonInput<ObjectValidator<A>>, McpAiStructuredOutput<R>>
  : never;

export type McpAiToolSet<
  Tools extends AnyMcpToolEntryRecord | undefined = undefined,
> = [Tools] extends [AnyMcpToolEntryRecord]
  ? Readonly<{
    [Name in keyof Tools]: McpAiToolFromEntry<Tools[Name]>;
  }>
  : Readonly<Record<string, McpAiTool<any, any>>>;

export type McpAiContext<S extends Schema = Schema> = Pick<
  ProcedureCtx<S>,
  "auth" | "abortSignal"
>;

type McpAiToolScopesOption<Scope extends string> = [Scope] extends [never]
  ? { readonly scopes?: never }
  : { readonly scopes?: readonly Scope[] };

export type McpAiToolsFilteredOptions<Scope extends string = never> = Readonly<
  { readonly includeUnavailable?: false } & McpAiToolScopesOption<Scope>
>;

export type McpAiToolsCompleteOptions<Scope extends string = never> = Readonly<
  { readonly includeUnavailable: true } & McpAiToolScopesOption<Scope>
>;

export type McpAiToolsOptions<Scope extends string = never> =
  | McpAiToolsFilteredOptions<Scope>
  | McpAiToolsCompleteOptions<Scope>;

export interface McpAiRuntimeCapability {
  /** The known scope vocabulary; a local delegation must draw from it. */
  readonly vocabulary: readonly string[];
  readonly toolsFor: (
    mcp: AnyMcpDeclaration,
  ) => readonly AnyRegisteredMcpTool[] | undefined;
  readonly execute: (
    mcp: AnyMcpDeclaration,
    tool: AnyRegisteredMcpTool,
    args: unknown,
    scopes: readonly string[],
    signal: AbortSignal,
  ) => Promise<McpCallToolResult>;
}

interface BoundMcpAiCapability extends McpAiRuntimeCapability {
  readonly assertActive: () => void;
}

const EMPTY_SCOPES: readonly string[] = Object.freeze([]);
const capabilities = new WeakMap<McpAiContext, BoundMcpAiCapability>();

/** Bind same-process MCP authority to one Runtime-owned server-function lifecycle. */
export function bindMcpAiContext(
  context: McpAiContext,
  capability: McpAiRuntimeCapability,
): () => void {
  if (capabilities.has(context)) {
    throw new TypeError("procedure context already has an MCP AI capability");
  }
  let active = true;
  const bound = Object.freeze({
    ...capability,
    assertActive() {
      if (!active) throw new TypeError("MCP AI tools are no longer active");
    },
  });
  capabilities.set(context, bound);
  return () => {
    if (!active) return;
    active = false;
    if (capabilities.get(context) === bound) capabilities.delete(context);
  };
}

interface NormalizedMcpAiToolsOptions {
  readonly includeUnavailable: boolean;
  readonly scopes: readonly string[];
}

function normalizeOptions(
  mcp: AnyMcpDeclaration,
  value: McpAiToolsOptions<string> | undefined,
): NormalizedMcpAiToolsOptions {
  if (value === undefined) {
    return Object.freeze({ includeUnavailable: false, scopes: EMPTY_SCOPES });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("MCP AI tools options must be an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("MCP AI tools options must be a plain object");
  }
  for (const key of Object.keys(value)) {
    if (key !== "scopes" && key !== "includeUnavailable") {
      throw new TypeError(`unknown MCP AI tools option ${JSON.stringify(key)}`);
    }
  }
  if (
    value.includeUnavailable !== undefined &&
    typeof value.includeUnavailable !== "boolean"
  ) {
    throw new TypeError("MCP AI tools includeUnavailable must be a boolean");
  }
  const scopes = value.scopes ?? EMPTY_SCOPES;
  if (!isScopeGrant(scopes)) {
    throw new TypeError(
      `MCP "${mcp.name}" local scopes must be an array of unique scope strings`,
    );
  }
  return Object.freeze({
    includeUnavailable: value.includeUnavailable ?? false,
    scopes: Object.freeze([...scopes]),
  });
}

/**
 * Authority never exceeds its source — and the source differs by caller.
 *
 * A server-side procedure delegates the APPLICATION's authority to the model:
 * the requested scopes are a literal in application code, never caller input,
 * and the procedure has already passed its own access policy. So for an
 * ordinary user the delegation carries what the application asked for, exactly
 * as calling the function directly would.
 *
 * A credential-backed principal is itself a delegate, so its source is the
 * credential: the local grant intersects with what that credential holds, or
 * the child invariant would be sidesteppable through this adapter.
 */
function effectiveGrant(
  principal: Principal,
  requested: readonly string[],
): readonly string[] {
  if (principal.kind !== "user") return EMPTY_SCOPES;
  return principal.issuer === CREDENTIAL_ISSUER
    ? effectiveChildScopes(requested, principal.scopes)
    : requested;
}

function richModelOutput(result: McpCallToolResult): McpAiModelOutput {
  return {
    type: "content",
    value: result.content.map((part): McpAiContent => {
      if (part.type === "text") return { type: "text", text: part.text };
      if (part.type === "image") {
        return { type: "file", mediaType: part.mimeType, data: { type: "data", data: part.data } };
      }
      return { type: "text", text: JSON.stringify(part) };
    }),
  };
}

/**
 * The thrown face of a declared application error. The text is the same JSON
 * the remote surface puts in its `isError` content block, so a model reading a
 * local tool failure and one reading a remote one see the same words.
 */
function localToolError(
  tool: AnyRegisteredMcpTool,
  result: McpCallToolResult,
): AckerDBError {
  const detail = result.content.find((part) => part.type === "text");
  return new AckerDBError(
    "validation",
    `MCP tool "${tool.name}" failed: ${detail === undefined ? "unknown error" : detail.text}`,
  );
}

/** Materialize the registry-owned tools available under one explicit local delegation. */
export function createMcpAiTools<
  S extends Schema,
  Scope extends string,
  Tools extends AnyMcpToolEntryRecord,
>(
  mcp: McpDeclaration<string, S, string | null, Scope, Tools>,
  context: McpAiContext<S>,
  options: McpAiToolsCompleteOptions<Scope>,
): McpAiToolSet<Tools>;
export function createMcpAiTools<
  S extends Schema,
  Scope extends string,
  Tools extends AnyMcpToolEntryRecord,
>(
  mcp: McpDeclaration<string, S, string | null, Scope, Tools>,
  context: McpAiContext<S>,
  options?: McpAiToolsFilteredOptions<Scope>,
): Readonly<Partial<McpAiToolSet<Tools>>>;
export function createMcpAiTools(
  mcp: AnyMcpDeclaration,
  context: McpAiContext,
  options?: McpAiToolsOptions<string>,
): McpAiToolSet;
export function createMcpAiTools(
  mcp: AnyMcpDeclaration,
  context: McpAiContext,
  options?: McpAiToolsOptions<string>,
): McpAiToolSet {
  const capability = capabilities.get(context);
  if (capability === undefined) {
    throw new TypeError("mcp.aiTools(ctx) requires an active AckerDB procedure context");
  }
  capability.assertActive();
  const registered = capability.toolsFor(mcp);
  if (registered === undefined) {
    throw new TypeError(`MCP "${mcp.name}" is not exported by this Runtime`);
  }
  const normalized = normalizeOptions(mcp, options);
  for (const scope of normalized.scopes) {
    if (!capability.vocabulary.includes(scope)) {
      throw new TypeError(
        `MCP "${mcp.name}" local scopes contains undeclared scope ${JSON.stringify(scope)}`,
      );
    }
  }
  const scopes = effectiveGrant(context.auth, normalized.scopes);

  const runInParent = AsyncLocalStorage.snapshot();
  const tools: Record<string, McpAiTool> = Object.create(null) as Record<string, McpAiTool>;
  for (const tool of registered) {
    const available = isMcpToolAuthorized(tool.accessPolicy, context.auth, scopes);
    if (!available && !normalized.includeUnavailable) continue;
    tools[tool.name] = Object.freeze({
      ...(tool.title === undefined ? {} : { title: tool.title }),
      description: tool.description,
      inputSchema: tool.codec.inputProtocolSchema,
      ...(tool.codec.returnsContent
        ? {}
        : { outputSchema: tool.codec.outputProtocolSchema }),
      execute(
        input: unknown,
        execution?: { readonly abortSignal?: AbortSignal },
      ): Promise<unknown> {
        return runInParent(async () => {
          capability.assertActive();
          const signal = AbortSignal.any([
            context.abortSignal,
            ...(execution?.abortSignal === undefined ? [] : [execution.abortSignal]),
          ]);
          throwIfAborted(signal);
          const result = await capability.execute(mcp, tool, input, scopes, signal);
          throwIfAborted(signal);
          // A declared application error is thrown locally rather than
          // returned: a model SDK renders a thrown tool error as a tool-error
          // part the model can still recover from, and a success keeps one
          // exact structured type instead of a union every caller must narrow.
          // The remote surface answers the same information as `isError`.
          if (result.isError === true) throw localToolError(tool, result);
          // A content tool has no structured face; the model reads the blocks.
          return tool.codec.returnsContent ? result : result.structuredContent!;
        });
      },
      toModelOutput({ output }: { readonly output: unknown }): McpAiModelOutput {
        return tool.codec.returnsContent
          ? richModelOutput(output as McpCallToolResult)
          : { type: "json", value: output as McpJsonValue };
      },
    });
  }
  return Object.freeze(tools) as unknown as McpAiToolSet;
}
