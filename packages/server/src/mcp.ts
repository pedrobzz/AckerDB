import type { RegisteredServerOnly } from "@dbzz/core";
import {
  type Expand,
  type InferShape,
  type ObjectShape,
  type Validator,
} from "./dbz.ts";
import type { Invocable } from "./functions.ts";
import { validateArgsShape } from "./functions.ts";
import { brand, hasBrand } from "./identity.ts";
import { compileInvocation } from "./invocation.ts";
import type { Schema } from "./schema.ts";
import type { ProcedureCtx } from "./functions.ts";

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
  readonly isError?: boolean;
}

export type McpToolCtx<S extends Schema = Schema> = Pick<
  ProcedureCtx<S>,
  "auth" | "abortSignal" | "tx"
>;

export interface McpInputSchema extends Readonly<Record<string, unknown>> {
  readonly type: "object";
  readonly properties: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly required?: readonly string[];
  readonly additionalProperties: false;
}

interface McpToolDefinition<A extends ObjectShape, S extends Schema> {
  readonly name: string;
  readonly description: string;
  readonly args: A;
  readonly handler: (
    ctx: McpToolCtx<S>,
    args: Expand<InferShape<A>>,
  ) => McpToolResult | Promise<McpToolResult>;
}

export interface RegisteredMcpTool<
  A extends ObjectShape = ObjectShape,
  S extends Schema = Schema,
> extends RegisteredServerOnly,
    Invocable<"mcp-tool", A, McpToolCtx<S>, McpToolResult> {
  readonly serverKind: "mcp-tool";
  readonly name: string;
  readonly description: string;
  readonly mcp: McpDeclaration<string, S>;
  readonly inputSchema: McpInputSchema;
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
  tool<A extends ObjectShape>(definition: McpToolDefinition<A, S>): RegisteredMcpTool<A, S>;
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

function propertySchema(validator: Validator<unknown, string>, where: string): Record<string, unknown> {
  switch (validator.kind) {
    case "string":
      return { type: "string" };
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "jsonb":
      return {};
    case "enum":
      return {
        type: "string",
        enum: [...(validator as Validator & { readonly values: readonly string[] }).values],
      };
    case "literal": {
      const value = validator.descriptor()["v"];
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return { const: value };
      }
      break;
    }
    case "array":
      return {
        type: "array",
        items: propertySchema(
          (validator as Validator & { readonly element: Validator }).element,
          `${where}[]`,
        ),
      };
    case "object":
      return objectSchema(
        (validator as Validator & { readonly shape: ObjectShape }).shape,
        where,
      );
    case "nullable":
      return {
        anyOf: [
          propertySchema(
            (validator as Validator & { readonly inner: Validator }).inner,
            where,
          ),
          { type: "null" },
        ],
      };
  }
  throw new Error(
    `${where}: dbz.${validator.kind}() does not yet have a lossless standard-JSON MCP representation`,
  );
}

function objectSchema(shape: ObjectShape, where: string): McpInputSchema {
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];
  for (const [name, validator] of Object.entries(shape)) {
    properties[name] = propertySchema(validator, `${where}.${name}`);
    if (validator.kind !== "nullable") required.push(name);
  }
  return Object.freeze({
    type: "object" as const,
    properties: Object.freeze(properties),
    ...(required.length === 0 ? {} : { required: Object.freeze(required) }),
    additionalProperties: false as const,
  });
}

export function validateMcpToolResult(value: unknown): McpToolResult {
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

  let declaration!: McpDeclaration;
  const value = {
    isDbzzServerOnly: true as const,
    serverKind: "mcp" as const,
    name: config.name,
    path,
    ...(instructions === undefined ? {} : { instructions }),
    metadata,
    tool<A extends ObjectShape>(definition: McpToolDefinition<A, Schema>): RegisteredMcpTool<A> {
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
      validateArgsShape(definition.args, `MCP tool ${definition.name} args`);
      const tool = {
        isDbzzServerOnly: true as const,
        serverKind: "mcp-tool" as const,
        kind: "mcp-tool" as const,
        name: definition.name,
        description: definition.description,
        mcp: declaration,
        args: definition.args,
        inputSchema: objectSchema(definition.args, `MCP tool ${definition.name} args`),
        access: "public" as const,
        handler: definition.handler,
      };
      brand(tool, MCP_TOOL_IDENTITY);
      compileInvocation(tool);
      return Object.freeze(tool) as RegisteredMcpTool<A>;
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

export type AnyRegisteredMcpTool = RegisteredMcpTool<ObjectShape, Schema>;
