import { AsyncLocalStorage } from "node:async_hooks";
import type { Principal } from "./auth.ts";
import { DbzzError } from "./errors.ts";
import type { ProcedureCtx } from "./functions.ts";
import type {
  AnyMcpDeclaration,
  AnyRegisteredMcpTool,
  McpEndpointDeclaration,
} from "./mcp.ts";
import type {
  McpCallToolResult,
  McpJsonValue,
} from "./mcp-content.ts";
import {
  isMcpToolAuthorized,
  normalizeMcpScopeGrant,
} from "./mcp-scopes.ts";
import type { Schema } from "./schema.ts";
import type { StandardJsonProtocolSchema } from "./standard-schema.ts";

type McpAiContent =
  | { type: "text"; text: string }
  | {
      type: "file";
      mediaType: string;
      data: { type: "data"; data: string };
    };

export type McpAiModelOutput =
  | { type: "json"; value: McpJsonValue }
  | { type: "content"; value: McpAiContent[] };

export interface McpAiTool {
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: StandardJsonProtocolSchema;
  readonly outputSchema?: StandardJsonProtocolSchema;
  readonly execute: (input: unknown, options?: unknown) => Promise<unknown>;
  readonly toModelOutput: (options: {
    readonly toolCallId: string;
    readonly input: unknown;
    readonly output: unknown;
  }) => McpAiModelOutput;
}

export type McpAiToolSet = Readonly<Record<string, McpAiTool>>;

export type McpAiContext<S extends Schema = Schema> = Pick<
  ProcedureCtx<S>,
  "auth" | "abortSignal" | "tx"
>;

export type McpAiToolsOptions<Scope extends string = never> = Readonly<
  { readonly includeUnavailable?: boolean } &
    ([Scope] extends [never]
      ? { readonly scopes?: never }
      : { readonly scopes?: readonly Scope[] })
>;

export interface McpAiRuntimeCapability {
  readonly toolsFor: (
    mcp: AnyMcpDeclaration,
  ) => readonly AnyRegisteredMcpTool[] | undefined;
  readonly execute: (
    mcp: AnyMcpDeclaration,
    tool: AnyRegisteredMcpTool,
    args: unknown,
    scopes: readonly string[],
  ) => Promise<McpCallToolResult>;
}

interface BoundMcpAiCapability extends McpAiRuntimeCapability {
  readonly assertActive: () => void;
}

interface McpLocalAuthority {
  readonly principal: Principal;
  readonly mcp: AnyMcpDeclaration;
  readonly scopes: readonly string[];
}

const EMPTY_SCOPES: readonly string[] = Object.freeze([]);
const capabilities = new WeakMap<McpAiContext, BoundMcpAiCapability>();
const localAuthority = new AsyncLocalStorage<McpLocalAuthority>();

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

/** Run one local call with an immutable grant bound to its exact parent and MCP. */
export function withMcpLocalAuthority<T>(
  principal: Principal,
  mcp: AnyMcpDeclaration,
  scopes: readonly string[],
  work: () => T,
): T {
  return localAuthority.run(Object.freeze({ principal, mcp, scopes }), work);
}

/** Resolve the local grant without allowing it to leak to another context or endpoint. */
export function mcpLocalGrant(
  principal: Principal,
  mcp: McpEndpointDeclaration,
): readonly string[] | undefined {
  const authority = localAuthority.getStore();
  if (authority === undefined) return undefined;
  return authority.principal === principal && authority.mcp === mcp
    ? authority.scopes
    : EMPTY_SCOPES;
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
  if (!("scopes" in mcp)) {
    if ("scopes" in value) {
      throw new TypeError(`MCP "${mcp.name}" declares no scopes`);
    }
    return Object.freeze({
      includeUnavailable: value.includeUnavailable ?? false,
      scopes: EMPTY_SCOPES,
    });
  }
  let scopes: readonly string[];
  try {
    scopes = normalizeMcpScopeGrant(
      mcp.scopes,
      value.scopes ?? EMPTY_SCOPES,
      `MCP "${mcp.name}" local scopes`,
    );
  } catch (error) {
    if (error instanceof DbzzError) throw new TypeError(error.message);
    throw error;
  }
  return Object.freeze({
    includeUnavailable: value.includeUnavailable ?? false,
    scopes,
  });
}

function effectiveGrant(
  principal: Principal,
  requested: readonly string[],
): readonly string[] {
  if (principal.kind === "user") return requested;
  if (principal.kind !== "mcp") return EMPTY_SCOPES;
  return Object.freeze(requested.filter((scope) => principal.scopes.includes(scope)));
}

function richModelOutput(result: McpCallToolResult): McpAiModelOutput {
  return {
    type: "content",
    value: result.content.map((part): McpAiContent => {
      if (part.type === "text") return { type: "text", text: part.text };
      if (part.type === "image") {
        return {
          type: "file",
          mediaType: part.mimeType,
          data: { type: "data", data: part.data },
        };
      }
      return { type: "text", text: JSON.stringify(part) };
    }),
  };
}

/** Materialize the registry-owned tools available under one explicit local delegation. */
export function createMcpAiTools(
  mcp: AnyMcpDeclaration,
  context: McpAiContext,
  options?: McpAiToolsOptions<string>,
): McpAiToolSet {
  const capability = capabilities.get(context);
  if (capability === undefined) {
    throw new TypeError("mcp.aiTools(ctx) requires an active DBZZ procedure context");
  }
  capability.assertActive();
  const registered = capability.toolsFor(mcp);
  if (registered === undefined) {
    throw new TypeError(`MCP "${mcp.name}" is not exported by this Runtime`);
  }
  const normalized = normalizeOptions(mcp, options);
  const scopes = effectiveGrant(context.auth, normalized.scopes);
  const endpointAvailable = context.auth.kind !== "mcp" || context.auth.mcp === mcp.name;

  const runInParent = AsyncLocalStorage.snapshot();
  const tools: Record<string, McpAiTool> = Object.create(null) as Record<string, McpAiTool>;
  for (const tool of registered) {
    const available = endpointAvailable && isMcpToolAuthorized(
      tool.accessPolicy,
      context.auth,
      scopes,
    );
    if (!available && !normalized.includeUnavailable) continue;
    const structured = tool.outputCodec !== undefined;
    tools[tool.name] = Object.freeze({
      ...(tool.title === undefined ? {} : { title: tool.title }),
      description: tool.description,
      inputSchema: tool.inputCodec.inputProtocolSchema,
      ...(structured ? { outputSchema: tool.outputCodec!.outputProtocolSchema } : {}),
      execute(input: unknown): Promise<unknown> {
        return runInParent(async () => {
          capability.assertActive();
          context.abortSignal.throwIfAborted();
          const result = await capability.execute(mcp, tool, input, scopes);
          return structured ? result.structuredContent! : result;
        });
      },
      toModelOutput({ output }: { readonly output: unknown }): McpAiModelOutput {
        return structured
          ? { type: "json", value: output as McpJsonValue }
          : richModelOutput(output as McpCallToolResult);
      },
    });
  }
  return Object.freeze(tools);
}
