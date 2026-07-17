import type { RegisteredServerOnly } from "@dbzz/core";
import {
  dbz,
  type Expand,
  type InferShape,
  type InferValidator,
  type ObjectShape,
  type ObjectValidator,
} from "./dbz.ts";
import type { Invocable } from "./functions.ts";
import { validateArgsShape } from "./functions.ts";
import { brand, hasBrand } from "./identity.ts";
import { compileInvocation } from "./invocation.ts";
import {
  createMcpTokenOperations,
  type CreatedMcpToken,
  type McpTokenCreateInput,
  type McpTokenDescriptor,
  type McpTokenOperations,
} from "./mcp-token-context.ts";
import type { Schema } from "./schema.ts";
import type { ProcedureCtx } from "./functions.ts";
import {
  compileMcpObjectCodec,
  type JsonObjectSchema,
  type StandardJsonCodec,
} from "./standard-schema.ts";

const MCP_IDENTITY = Symbol.for("@dbzz/server/Mcp/v1");
const MCP_TOOL_IDENTITY = Symbol.for("@dbzz/server/McpTool/v1");
const MCP_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const MCP_PATH = /^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/;
const TOOL_NAME = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const DEFAULT_MCP_PATH = "/mcp";
const MAX_MCP_PATH_BYTES = 256;
const MAX_MCP_INSTRUCTIONS_BYTES = 16 * 1_024;
const MAX_MCP_METADATA_BYTES = 4 * 1_024;
const utf8 = new TextEncoder();

export interface McpEndpointMetadata {
  readonly title?: string;
  readonly description?: string;
  readonly websiteUrl?: string;
}

interface McpConfigBase<Name extends string> {
  readonly name: Name;
  readonly instructions?: string;
  readonly metadata?: McpEndpointMetadata;
}

export interface DefaultMcpConfig<Name extends string> extends McpConfigBase<Name> {
  readonly path?: undefined;
}

export interface CustomMcpConfig<Name extends string, Path extends string>
  extends McpConfigBase<Name> {
  readonly path: Path;
}

export interface McpTextContent {
  readonly type: "text";
  readonly text: string;
}

/** Text-only result for the first tools tracer; later content kinds extend this union. */
export interface McpToolResult {
  readonly content: readonly McpTextContent[];
  readonly structuredContent?: Readonly<Record<string, unknown>>;
  readonly isError?: boolean;
}

export type McpToolCtx<S extends Schema = Schema> = Pick<
  ProcedureCtx<S>,
  "auth" | "abortSignal" | "tx"
>;

export type McpInputSchema = JsonObjectSchema;
export type McpOutputSchema = JsonObjectSchema;

interface McpToolDefinitionBase<A extends ObjectShape> {
  readonly name: string;
  readonly description: string;
  readonly access?: "public" | "authenticated";
  readonly args: A;
}

interface McpToolDefinition<
  A extends ObjectShape,
  O extends ObjectValidator | undefined,
  S extends Schema,
> extends McpToolDefinitionBase<A> {
  readonly output?: O;
  readonly handler: (
    ctx: McpToolCtx<S>,
    args: Expand<InferShape<A>>,
  ) => McpHandlerResult<O> | Promise<McpHandlerResult<O>>;
}

type McpHandlerResult<O extends ObjectValidator | undefined> =
  O extends ObjectValidator ? Expand<InferValidator<O>> : McpToolResult;

export interface RegisteredMcpTool<
  A extends ObjectShape = ObjectShape,
  O extends ObjectValidator | undefined = ObjectValidator | undefined,
  S extends Schema = Schema,
> extends RegisteredServerOnly,
    Invocable<"mcp-tool", A, McpToolCtx<S>, McpToolResult, McpHandlerResult<O>> {
  readonly serverKind: "mcp-tool";
  readonly name: string;
  readonly description: string;
  readonly mcp: McpDeclaration<string, S>;
  readonly inputValidator: ObjectValidator<A>;
  readonly inputCodec: StandardJsonCodec<Expand<InferShape<A>>>;
  readonly inputSchema: McpInputSchema;
  readonly outputValidator: O;
  readonly outputCodec: O extends ObjectValidator
    ? StandardJsonCodec<Expand<InferValidator<O>>>
    : undefined;
  readonly outputSchema: O extends ObjectValidator ? McpOutputSchema : undefined;
}

export interface McpDeclaration<
  Name extends string = string,
  S extends Schema = Schema,
  Path extends string = string,
> extends RegisteredServerOnly {
  readonly serverKind: "mcp";
  readonly name: Name;
  readonly path: Path;
  readonly instructions?: string;
  readonly metadata: McpEndpointMetadata;
  readonly tokens: McpTokenOperations<S>;
  tool<A extends ObjectShape, O extends ObjectValidator | undefined = undefined>(
    definition: McpToolDefinition<A, O, S>,
  ): RegisteredMcpTool<A, O, S>;
}

export interface McpBuilder<S extends Schema> {
  <const Name extends string>(config: DefaultMcpConfig<Name>): McpDeclaration<Name, S, "/mcp">;
  <const Name extends string, const Path extends string>(
    config: CustomMcpConfig<Name, Path>,
  ): McpDeclaration<Name, S, Path>;
}

function byteLength(value: string): number {
  return utf8.encode(value).byteLength;
}

function nonEmptyString(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${where} must be a non-empty string`);
  }
  return value;
}

function endpointMetadata(value: unknown): McpEndpointMetadata {
  if (value === undefined) return Object.freeze({});
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("MCP metadata must be an object");
  }
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (key !== "title" && key !== "description" && key !== "websiteUrl") {
      throw new TypeError(`unknown MCP metadata field "${key}"`);
    }
  }

  const metadata: { title?: string; description?: string; websiteUrl?: string } = {};
  if (input.title !== undefined) {
    metadata.title = nonEmptyString(input.title, "MCP metadata title");
  }
  if (input.description !== undefined) {
    metadata.description = nonEmptyString(input.description, "MCP metadata description");
  }
  if (input.websiteUrl !== undefined) {
    metadata.websiteUrl = nonEmptyString(input.websiteUrl, "MCP metadata websiteUrl");
    try {
      new URL(metadata.websiteUrl);
    } catch {
      throw new TypeError("MCP metadata websiteUrl must be an absolute URL");
    }
  }
  if (byteLength(JSON.stringify(metadata)) > MAX_MCP_METADATA_BYTES) {
    throw new TypeError(`MCP metadata must be at most ${MAX_MCP_METADATA_BYTES} UTF-8 bytes`);
  }
  return Object.freeze(metadata);
}

function validateMcpContentResult(value: unknown): McpToolResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("MCP tool handlers must return an MCP content result");
  }
  const result = value as { readonly content?: unknown; readonly isError?: unknown };
  if (!Array.isArray(result.content)) {
    throw new TypeError("MCP tool result content must be an array");
  }
  for (const item of result.content) {
    if (
      item === null ||
      typeof item !== "object" ||
      (item as { readonly type?: unknown }).type !== "text" ||
      typeof (item as { readonly text?: unknown }).text !== "string"
    ) {
      throw new TypeError("MCP tool result content currently supports only text items");
    }
  }
  if (result.isError !== undefined && typeof result.isError !== "boolean") {
    throw new TypeError("MCP tool result isError must be a boolean");
  }
  return value as McpToolResult;
}

/** Validate and normalize the handler result once before either adapter consumes it. */
export function finalizeMcpToolResult(tool: AnyRegisteredMcpTool, value: unknown): McpToolResult {
  if (tool.outputCodec === undefined) return validateMcpContentResult(value);
  const structuredContent = tool.outputCodec.encode(value, "output") as Readonly<
    Record<string, unknown>
  >;
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

export function createMcp<const Name extends string>(
  config: DefaultMcpConfig<Name>,
): McpDeclaration<Name, Schema, "/mcp">;
export function createMcp<const Name extends string, const Path extends string>(
  config: CustomMcpConfig<Name, Path>,
): McpDeclaration<Name, Schema, Path>;
export function createMcp(
  config: DefaultMcpConfig<string> | CustomMcpConfig<string, string>,
): McpDeclaration {
  if (config === null || typeof config !== "object") {
    throw new TypeError("createMcp config is required");
  }
  for (const key of Object.keys(config).sort()) {
    if (key !== "name" && key !== "path" && key !== "instructions" && key !== "metadata") {
      throw new TypeError(`unknown MCP config field "${key}"`);
    }
  }
  if (typeof config.name !== "string" || !MCP_NAME.test(config.name)) {
    throw new TypeError("MCP name must start with a letter and contain at most 64 letters, digits, _ or -");
  }
  const path = config.path === undefined ? DEFAULT_MCP_PATH : config.path;
  if (
    typeof path !== "string" ||
    !MCP_PATH.test(path) ||
    byteLength(path) > MAX_MCP_PATH_BYTES
  ) {
    throw new TypeError(
      `MCP path must be an absolute static path of at most ${MAX_MCP_PATH_BYTES} UTF-8 bytes`,
    );
  }
  const instructions = config.instructions === undefined
    ? undefined
    : nonEmptyString(config.instructions, "MCP instructions");
  if (instructions !== undefined && byteLength(instructions) > MAX_MCP_INSTRUCTIONS_BYTES) {
    throw new TypeError(
      `MCP instructions must be at most ${MAX_MCP_INSTRUCTIONS_BYTES} UTF-8 bytes`,
    );
  }
  const metadata = endpointMetadata(config.metadata);
  const tokens = createMcpTokenOperations(config.name);

  let declaration!: McpDeclaration;
  const value = {
    isDbzzServerOnly: true as const,
    serverKind: "mcp" as const,
    name: config.name,
    path,
    ...(instructions === undefined ? {} : { instructions }),
    metadata,
    tokens,
    tool(definition: McpToolDefinition<
      ObjectShape,
      ObjectValidator | undefined,
      Schema
    >): RegisteredMcpTool {
      if (definition === null || typeof definition !== "object") {
        throw new TypeError("MCP tool definition is required");
      }
      if (typeof definition.name !== "string" || !TOOL_NAME.test(definition.name)) {
        throw new TypeError("MCP tool names must be lower_snake_case");
      }
      if (typeof definition.description !== "string" || definition.description.trim() === "") {
        throw new TypeError(`MCP tool "${definition.name}" requires a description`);
      }
      if (typeof definition.handler !== "function") {
        throw new TypeError(`MCP tool "${definition.name}" requires a handler`);
      }
      if (
        definition.access !== undefined &&
        definition.access !== "public" &&
        definition.access !== "authenticated"
      ) {
        throw new TypeError(`MCP tool "${definition.name}" access must be public or authenticated`);
      }
      validateArgsShape(definition.args, `MCP tool ${definition.name} args`);
      if (definition.output !== undefined && definition.output.kind !== "object") {
        throw new TypeError(`MCP tool "${definition.name}" output must be dbz.object(...)`);
      }
      const inputValidator = dbz.object(definition.args);
      const outputValidator = definition.output;
      const inputCodec = compileMcpObjectCodec(inputValidator);
      const outputCodec = outputValidator === undefined
        ? undefined
        : compileMcpObjectCodec(outputValidator);
      const tool = {
        isDbzzServerOnly: true as const,
        serverKind: "mcp-tool" as const,
        kind: "mcp-tool" as const,
        name: definition.name,
        description: definition.description,
        mcp: declaration,
        args: definition.args,
        inputValidator,
        inputCodec,
        inputSchema: inputCodec.inputSchema,
        outputValidator,
        outputCodec,
        outputSchema: outputCodec?.outputSchema,
        access: definition.access ?? "public",
        handler: definition.handler,
      };
      brand(tool, MCP_TOOL_IDENTITY);
      compileInvocation(tool);
      return Object.freeze(tool) as RegisteredMcpTool;
    },
  };
  brand(value, MCP_IDENTITY);
  declaration = Object.freeze(value) as McpDeclaration;
  return declaration;
}

export function isMcpDeclaration(value: unknown): value is McpDeclaration {
  return hasBrand(value, MCP_IDENTITY);
}

export function isRegisteredMcpTool(value: unknown): value is RegisteredMcpTool {
  return hasBrand(value, MCP_TOOL_IDENTITY);
}

export type AnyRegisteredMcpTool = RegisteredMcpTool<
  ObjectShape,
  ObjectValidator | undefined,
  Schema
>;

export type {
  CreatedMcpToken,
  McpTokenCreateInput,
  McpTokenDescriptor,
  McpTokenOperations,
};
