import type { RegisteredServerOnly } from "@dbzz/core";
import {
  dbz,
  type Expand,
  type InferShape,
  type InferValidator,
  type ObjectShape,
  type ObjectValidator,
  ValidationError,
} from "./dbz.ts";
import type { Invocable } from "./functions.ts";
import { validateArgsShape } from "./functions.ts";
import { brand, hasBrand } from "./identity.ts";
import { compileInvocation } from "./invocation.ts";
import type { Schema } from "./schema.ts";
import type { ProcedureCtx } from "./functions.ts";
import { mcpObjectSchema, type JsonObjectSchema } from "./standard-schema.ts";

const MCP_IDENTITY = Symbol.for("@dbzz/server/Mcp/v1");
const MCP_TOOL_IDENTITY = Symbol.for("@dbzz/server/McpTool/v1");
const MCP_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const TOOL_NAME = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

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
  readonly inputSchema: McpInputSchema;
  readonly outputValidator: O;
  readonly outputSchema: O extends ObjectValidator ? McpOutputSchema : undefined;
}

export interface McpDeclaration<
  Name extends string = string,
  S extends Schema = Schema,
> extends RegisteredServerOnly {
  readonly serverKind: "mcp";
  readonly name: Name;
  readonly path: "/mcp";
  tool<A extends ObjectShape, O extends ObjectValidator | undefined = undefined>(
    definition: McpToolDefinition<A, O, S>,
  ): RegisteredMcpTool<A, O, S>;
}

export type McpBuilder<S extends Schema> = <const Name extends string>(config: {
  readonly name: Name;
}) => McpDeclaration<Name, S>;

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

function assertStandardJson(value: unknown, path: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      assertStandardJson(value[index], `${path}[${index}]`);
    }
    return;
  }
  if (typeof value === "object" && !(value instanceof Uint8Array)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      for (const [key, field] of Object.entries(value)) {
        assertStandardJson(field, `${path}.${key}`);
      }
      return;
    }
  }
  throw new ValidationError(`${path}: expected a standard JSON value`);
}

/** Validate and normalize the handler result once before either adapter consumes it. */
export function finalizeMcpToolResult(tool: AnyRegisteredMcpTool, value: unknown): McpToolResult {
  if (tool.outputValidator === undefined) return validateMcpContentResult(value);
  const structuredContent = tool.outputValidator.check(value, "output") as Readonly<
    Record<string, unknown>
  >;
  assertStandardJson(structuredContent, "output");
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

export function createMcp<const Name extends string>(config: {
  readonly name: Name;
}): McpDeclaration<Name> {
  if (config === null || typeof config !== "object") {
    throw new TypeError("createMcp config is required");
  }
  if (typeof config.name !== "string" || !MCP_NAME.test(config.name)) {
    throw new TypeError("MCP name must start with a letter and contain at most 64 letters, digits, _ or -");
  }

  let declaration!: McpDeclaration<Name>;
  const value = {
    isDbzzServerOnly: true as const,
    serverKind: "mcp" as const,
    name: config.name,
    path: "/mcp" as const,
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
      validateArgsShape(definition.args, `MCP tool ${definition.name} args`);
      if (definition.output !== undefined && definition.output.kind !== "object") {
        throw new TypeError(`MCP tool "${definition.name}" output must be dbz.object(...)`);
      }
      const inputValidator = dbz.object(definition.args);
      const outputValidator = definition.output;
      const tool = {
        isDbzzServerOnly: true as const,
        serverKind: "mcp-tool" as const,
        kind: "mcp-tool" as const,
        name: definition.name,
        description: definition.description,
        mcp: declaration,
        args: definition.args,
        inputValidator,
        inputSchema: mcpObjectSchema(inputValidator, "input"),
        outputValidator,
        outputSchema: outputValidator === undefined
          ? undefined
          : mcpObjectSchema(outputValidator, "output"),
        access: "public" as const,
        handler: definition.handler,
      };
      brand(tool, MCP_TOOL_IDENTITY);
      compileInvocation(tool);
      return Object.freeze(tool) as RegisteredMcpTool;
    },
  };
  brand(value, MCP_IDENTITY);
  declaration = Object.freeze(value) as McpDeclaration<Name>;
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
