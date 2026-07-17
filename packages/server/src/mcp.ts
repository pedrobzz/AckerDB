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
  createSystemMcpTokenOperations,
  type CreatedMcpToken,
  type McpTokenCreateInput,
  type McpTokenDescriptor,
  type McpTokenOperations,
  type SystemMcpTokenOperations,
} from "./mcp-token-context.ts";
import {
  createMcpScopeDescriptor,
  isMcpToolAuthorized,
  normalizeMcpToolAccess,
  type McpScopeDescriptor,
  type McpScopeValues,
  type McpToolAccessPolicy,
  type NormalizedMcpToolAccessPolicy,
} from "./mcp-scopes.ts";
import type { Schema } from "./schema.ts";
import type { ProcedureCtx } from "./functions.ts";
import {
  compileMcpObjectCodec,
  type JsonObjectSchema,
  type StandardJsonCodec,
} from "./standard-schema.ts";
import {
  type McpCallToolResult,
  type McpToolResult,
  validateMcpContentResult,
} from "./mcp-content.ts";

export type {
  McpAudioContent,
  McpBlobResourceContents,
  McpContentAnnotations,
  McpContentBlock,
  McpContentRole,
  McpEmbeddedResourceContent,
  McpIcon,
  McpImageContent,
  McpJsonValue,
  McpMetadata,
  McpResourceLinkContent,
  McpTextContent,
  McpTextResourceContents,
  McpToolResult,
} from "./mcp-content.ts";

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
  readonly scopes?: undefined;
}

export interface CustomMcpConfig<Name extends string, Path extends string>
  extends McpConfigBase<Name> {
  readonly path: Path;
  readonly scopes?: undefined;
}

export interface ScopedDefaultMcpConfig<
  Name extends string,
  Scopes extends McpScopeValues,
> extends McpConfigBase<Name> {
  readonly path?: undefined;
  readonly scopes: Scopes;
}

export interface ScopedCustomMcpConfig<
  Name extends string,
  Path extends string,
  Scopes extends McpScopeValues,
> extends McpConfigBase<Name> {
  readonly path: Path;
  readonly scopes: Scopes;
}

export interface McpToolAnnotations {
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

export type McpToolCtx<S extends Schema = Schema> = Pick<
  ProcedureCtx<S>,
  "auth" | "abortSignal" | "tx"
>;

export type McpInputSchema = JsonObjectSchema;
export type McpOutputSchema = JsonObjectSchema;

interface McpToolDefinitionBase<A extends ObjectShape, Scope extends string> {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly annotations?: McpToolAnnotations;
  readonly access?: McpToolAccessPolicy<Scope>;
  readonly args: A;
}

interface McpToolDefinition<
  A extends ObjectShape,
  O extends ObjectValidator | undefined,
  S extends Schema,
  Scope extends string,
> extends McpToolDefinitionBase<A, Scope> {
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
    Invocable<"mcp-tool", A, McpToolCtx<S>, McpCallToolResult, McpHandlerResult<O>> {
  readonly serverKind: "mcp-tool";
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly annotations?: McpToolAnnotations;
  readonly mcp: McpEndpointDeclaration<string>;
  readonly accessPolicy: NormalizedMcpToolAccessPolicy;
  readonly inputValidator: ObjectValidator<A>;
  readonly inputCodec: StandardJsonCodec<Expand<InferShape<A>>>;
  readonly inputSchema: McpInputSchema;
  readonly outputValidator: O;
  readonly outputCodec: O extends ObjectValidator
    ? StandardJsonCodec<Expand<InferValidator<O>>>
    : undefined;
  readonly outputSchema: O extends ObjectValidator ? McpOutputSchema : undefined;
}

export interface McpEndpointDeclaration<
  Name extends string = string,
  Path extends string = string,
> extends RegisteredServerOnly {
  readonly serverKind: "mcp";
  readonly name: Name;
  readonly path: Path;
  readonly instructions?: string;
  readonly metadata: McpEndpointMetadata;
}

type McpDeclarationOperations<S extends Schema, Scope extends string> = {
  readonly tokens: McpTokenOperations<S, Scope>;
  readonly systemTokens: SystemMcpTokenOperations<S, Scope>;
  tool<A extends ObjectShape, O extends ObjectValidator | undefined = undefined>(
    definition: McpToolDefinition<A, O, S, Scope>,
  ): RegisteredMcpTool<A, O, S>;
};

export type McpDeclaration<
  Name extends string = string,
  S extends Schema = Schema,
  Path extends string = string,
  Scope extends string = never,
> = McpEndpointDeclaration<Name, Path> & McpDeclarationOperations<S, Scope> &
  ([Scope] extends [never] ? object : { readonly scopes: McpScopeDescriptor<Scope> });

export type AnyMcpDeclaration =
  | McpDeclaration<string, Schema, string, never>
  | McpDeclaration<string, Schema, string, string>;

export interface McpBuilder<S extends Schema> {
  <const Name extends string>(config: DefaultMcpConfig<Name>): McpDeclaration<Name, S, "/mcp">;
  <const Name extends string, const Path extends string>(
    config: CustomMcpConfig<Name, Path>,
  ): McpDeclaration<Name, S, Path>;
  <const Name extends string, const Scopes extends McpScopeValues>(
    config: ScopedDefaultMcpConfig<Name, Scopes>,
  ): McpDeclaration<Name, S, "/mcp", Scopes[number]>;
  <
    const Name extends string,
    const Path extends string,
    const Scopes extends McpScopeValues,
  >(
    config: ScopedCustomMcpConfig<Name, Path, Scopes>,
  ): McpDeclaration<Name, S, Path, Scopes[number]>;
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

function toolAnnotations(value: unknown): McpToolAnnotations | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("MCP tool annotations must be an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("MCP tool annotations must be a plain object");
  }
  const input = value as Record<string, unknown>;
  const fields = [
    "readOnlyHint",
    "destructiveHint",
    "idempotentHint",
    "openWorldHint",
  ] as const;
  for (const key of Object.keys(input)) {
    if (!fields.includes(key as typeof fields[number])) {
      throw new TypeError(`unknown MCP tool annotation "${key}"`);
    }
  }
  const result: Partial<Record<typeof fields[number], boolean>> = {};
  for (const field of fields) {
    if (input[field] === undefined) continue;
    if (typeof input[field] !== "boolean") {
      throw new TypeError(`MCP tool annotation ${field} must be a boolean`);
    }
    result[field] = input[field];
  }
  return Object.freeze(result);
}

/** Validate and normalize the handler result once before either adapter consumes it. */
export function finalizeMcpToolResult(
  tool: { readonly outputCodec: StandardJsonCodec<unknown> | undefined },
  value: unknown,
): McpCallToolResult {
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
export function createMcp<const Name extends string, const Scopes extends McpScopeValues>(
  config: ScopedDefaultMcpConfig<Name, Scopes>,
): McpDeclaration<Name, Schema, "/mcp", Scopes[number]>;
export function createMcp<
  const Name extends string,
  const Path extends string,
  const Scopes extends McpScopeValues,
>(
  config: ScopedCustomMcpConfig<Name, Path, Scopes>,
): McpDeclaration<Name, Schema, Path, Scopes[number]>;
export function createMcp(
  config:
    | DefaultMcpConfig<string>
    | CustomMcpConfig<string, string>
    | ScopedDefaultMcpConfig<string, McpScopeValues>
    | ScopedCustomMcpConfig<string, string, McpScopeValues>,
): AnyMcpDeclaration {
  if (config === null || typeof config !== "object") {
    throw new TypeError("createMcp config is required");
  }
  for (const key of Object.keys(config).sort()) {
    if (
      key !== "name" &&
      key !== "path" &&
      key !== "instructions" &&
      key !== "metadata" &&
      key !== "scopes"
    ) {
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
  const scopeDescriptor = createMcpScopeDescriptor(config.name, config.scopes);
  const tokens = createMcpTokenOperations(config.name, scopeDescriptor);
  const systemTokens = createSystemMcpTokenOperations(config.name, scopeDescriptor);

  let declaration!: AnyMcpDeclaration;
  const value = {
    isDbzzServerOnly: true as const,
    serverKind: "mcp" as const,
    name: config.name,
    path,
    ...(instructions === undefined ? {} : { instructions }),
    metadata,
    ...(scopeDescriptor === undefined ? {} : { scopes: scopeDescriptor }),
    tokens,
    systemTokens,
    tool(definition: McpToolDefinition<
      ObjectShape,
      ObjectValidator | undefined,
      Schema,
      string
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
      const title = definition.title === undefined
        ? undefined
        : nonEmptyString(definition.title, `MCP tool "${definition.name}" title`);
      const annotations = toolAnnotations(definition.annotations);
      if (typeof definition.handler !== "function") {
        throw new TypeError(`MCP tool "${definition.name}" requires a handler`);
      }
      const accessPolicy = normalizeMcpToolAccess(
        definition.access,
        scopeDescriptor,
        definition.name,
      );
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
        ...(title === undefined ? {} : { title }),
        description: definition.description,
        ...(annotations === undefined ? {} : { annotations }),
        mcp: declaration,
        accessPolicy,
        args: definition.args,
        inputValidator,
        inputCodec,
        inputSchema: inputCodec.inputSchema,
        outputValidator,
        outputCodec,
        outputSchema: outputCodec?.outputSchema,
        access: (ctx: McpToolCtx) => isMcpToolAuthorized(accessPolicy, ctx.auth),
        handler: definition.handler,
      };
      brand(tool, MCP_TOOL_IDENTITY);
      compileInvocation(tool, inputCodec.decode);
      return Object.freeze(tool) as RegisteredMcpTool;
    },
  };
  brand(value, MCP_IDENTITY);
  declaration = Object.freeze(value) as AnyMcpDeclaration;
  return declaration;
}

export function isMcpDeclaration(value: unknown): value is AnyMcpDeclaration {
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
  SystemMcpTokenOperations,
};
export type {
  McpScopeDescriptor,
  McpScopeValues,
  McpToolAccessPolicy,
  NormalizedMcpToolAccessPolicy,
};
