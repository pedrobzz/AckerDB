import type { RegisteredServerOnly } from "@dbzz/core";
import {
  v,
  type Expand,
  type InferShape,
  type InferValidator,
  type ObjectShape,
  type ObjectValidator,
} from "./v.ts";
import type { Invocable } from "./functions.ts";
import { validateArgsShape } from "./functions.ts";
import { brand, hasBrand } from "./identity.ts";
import { compileInvocation } from "./invocation.ts";
import {
  createMcpAiTools,
  mcpLocalGrant,
  type McpAiContext,
  type McpAiToolsCompleteOptions,
  type McpAiToolsFilteredOptions,
  type McpAiToolsOptions,
  type McpAiToolSet,
} from "./mcp-ai.ts";
import {
  createMcpTokenOperations,
  createSystemMcpTokenOperations,
  type CreatedMcpToken,
  type McpTokenCreateInput,
  type McpTokenDescriptor,
  type McpTokenOperations,
  type McpTokenUpdateInput,
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
  type StandardJsonInput,
  type StandardJsonOutput,
} from "./standard-schema.ts";
import {
  type McpCallToolResult,
  type McpToolResult,
  validateMcpContentResult,
} from "./mcp-content.ts";

export type {
  McpAudioContent,
  McpBlobResourceContents,
  McpCallToolResult,
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
export type {
  McpAiContext,
  McpAiModelOutput,
  McpAiToolsCompleteOptions,
  McpAiToolsFilteredOptions,
  McpAiToolsOptions,
  McpAiTool,
  McpAiToolSet,
} from "./mcp-ai.ts";

const MCP_IDENTITY = Symbol.for("@dbzz/server/Mcp/v1");
const MCP_TOOL_IDENTITY = Symbol.for("@dbzz/server/McpTool/v1");
const mcpToolBlueprintDefinitions = new WeakMap<object, unknown>();
const MCP_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const MCP_PATH = /^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/;
const TOOL_NAME = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const DEFAULT_MCP_PATH = "/mcp";
const MAX_MCP_PATH_BYTES = 256;
const MAX_MCP_INSTRUCTIONS_BYTES = 16 * 1_024;
const MAX_MCP_METADATA_BYTES = 4 * 1_024;
const MAX_MCP_TOOL_NAME_BYTES = 63;
const MAX_MCP_TOOL_TITLE_BYTES = 256;
const MAX_MCP_TOOL_DESCRIPTION_BYTES = 4 * 1_024;
const utf8 = new TextEncoder();

export interface McpEndpointMetadata {
  readonly title?: string;
  readonly description?: string;
  readonly websiteUrl?: string;
}

interface McpConfigBase<
  Name extends string,
  Tools extends AnyMcpToolBlueprintRecord,
> {
  readonly name: Name;
  readonly tools: Tools;
  readonly instructions?: string;
  readonly metadata?: McpEndpointMetadata;
}

export interface DefaultMcpConfig<
  Name extends string,
  Tools extends AnyMcpToolBlueprintRecord = AnyMcpToolBlueprintRecord,
> extends McpConfigBase<Name, Tools> {
  readonly path?: undefined;
  readonly scopes?: undefined;
}

export interface CustomMcpConfig<
  Name extends string,
  Path extends string,
  Tools extends AnyMcpToolBlueprintRecord = AnyMcpToolBlueprintRecord,
> extends McpConfigBase<Name, Tools> {
  readonly path: Path;
  readonly scopes?: undefined;
}

export interface ScopedDefaultMcpConfig<
  Name extends string,
  Scopes extends McpScopeValues,
  Tools extends AnyMcpToolBlueprintRecord = AnyMcpToolBlueprintRecord,
> extends McpConfigBase<Name, Tools> {
  readonly path?: undefined;
  readonly scopes: Scopes;
}

export interface ScopedCustomMcpConfig<
  Name extends string,
  Path extends string,
  Scopes extends McpScopeValues,
  Tools extends AnyMcpToolBlueprintRecord = AnyMcpToolBlueprintRecord,
> extends McpConfigBase<Name, Tools> {
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

type McpToolBlueprintAccess =
  | "public"
  | "authenticated"
  | { readonly anyOf: readonly [string, ...string[]] }
  | { readonly allOf: readonly [string, ...string[]] };

type McpToolAccessScopes<Access> = Access extends {
  readonly anyOf: readonly (infer Scope extends string)[];
} ? Scope
  : Access extends { readonly allOf: readonly (infer Scope extends string)[] } ? Scope
  : never;

interface McpToolDefinitionBase<
  A extends ObjectShape,
  Access extends McpToolBlueprintAccess | undefined,
> {
  readonly title?: string;
  readonly description: string;
  readonly annotations?: McpToolAnnotations;
  readonly access?: Access;
  readonly args: A;
}

export interface McpToolDefinition<
  A extends ObjectShape,
  O extends ObjectValidator | undefined,
  S extends Schema,
  Access extends McpToolBlueprintAccess | undefined = undefined,
> extends McpToolDefinitionBase<A, Access> {
  readonly output?: O;
  readonly handler: (
    ctx: McpToolCtx<S>,
    args: Expand<InferShape<A>>,
  ) => McpHandlerResult<O> | Promise<McpHandlerResult<O>>;
}

type McpHandlerResult<O extends ObjectValidator | undefined> =
  O extends ObjectValidator ? Expand<InferValidator<O>> : McpToolResult;

/** An inert, reusable tool contract. Endpoint assembly gives it a wire name and identity. */
export interface McpToolBlueprint<
  A extends ObjectShape = ObjectShape,
  O extends ObjectValidator | undefined = ObjectValidator | undefined,
  S extends Schema = Schema,
  RequiredScope extends string = never,
> extends RegisteredServerOnly {
  readonly serverKind: "mcp-tool-blueprint";
  readonly _args?: A;
  readonly _output?: O;
  /** Compile-only invariant marker: handlers both consume and produce capabilities from S. */
  readonly _schema?: (schema: S) => S;
  readonly _requiredScope?: RequiredScope;
}

export type McpToolBlueprintRecord<
  S extends Schema = Schema,
  Scope extends string = string,
> = Readonly<Record<string, McpToolBlueprint<ObjectShape, ObjectValidator | undefined, S, Scope>>>;

export type AnyMcpToolBlueprint = McpToolBlueprint<
  ObjectShape,
  ObjectValidator | undefined,
  any,
  string
>;
export type AnyMcpToolBlueprintRecord = Readonly<Record<string, AnyMcpToolBlueprint>>;

export interface McpToolBuilder<S extends Schema> {
  <
    const A extends ObjectShape,
    const O extends ObjectValidator | undefined = undefined,
    const Access extends McpToolBlueprintAccess | undefined = undefined,
  >(
    definition: McpToolDefinition<A, O, S, Access>,
  ): McpToolBlueprint<A, O, S, McpToolAccessScopes<Access>>;
}

type RegisteredMcpToolFromBlueprint<
  Blueprint,
  Name extends string,
> = Blueprint extends McpToolBlueprint<infer A, infer O, infer S, infer _Scope>
  ? RegisteredMcpTool<A, O, S, Name>
  : never;

export type RegisteredMcpTools<Tools extends AnyMcpToolBlueprintRecord> = Readonly<{
  [Name in keyof Tools]: RegisteredMcpToolFromBlueprint<Tools[Name], Name & string>;
}>;

export interface RegisteredMcpTool<
  A extends ObjectShape = ObjectShape,
  O extends ObjectValidator | undefined = ObjectValidator | undefined,
  S extends Schema = Schema,
  Name extends string = string,
> extends RegisteredServerOnly,
    Invocable<"mcp-tool", A, McpToolCtx<S>, McpCallToolResult, McpHandlerResult<O>> {
  readonly serverKind: "mcp-tool";
  readonly name: Name;
  readonly title?: string;
  readonly description: string;
  readonly annotations?: McpToolAnnotations;
  readonly mcp: McpEndpointDeclaration<string, string>;
  readonly accessPolicy: NormalizedMcpToolAccessPolicy;
  readonly inputValidator: ObjectValidator<A>;
  readonly inputCodec: StandardJsonCodec<
    Expand<InferShape<A>>,
    StandardJsonInput<ObjectValidator<A>>,
    StandardJsonOutput<ObjectValidator<A>>
  >;
  readonly inputSchema: McpInputSchema;
  readonly outputValidator: O;
  readonly outputCodec: O extends ObjectValidator
    ? StandardJsonCodec<
      Expand<InferValidator<O>>,
      StandardJsonInput<O>,
      StandardJsonOutput<O>
    >
    : undefined;
  readonly outputSchema: O extends ObjectValidator ? McpOutputSchema : undefined;
}

export interface McpEndpointDeclaration<
  Name extends string = string,
  Path extends string = string,
  Tools extends AnyMcpToolBlueprintRecord | undefined = undefined,
> extends RegisteredServerOnly {
  readonly serverKind: "mcp";
  readonly name: Name;
  readonly path: Path;
  readonly instructions?: string;
  readonly metadata: McpEndpointMetadata;
  readonly tools: [Tools] extends [AnyMcpToolBlueprintRecord]
    ? RegisteredMcpTools<Tools>
    : Readonly<Record<string, RegisteredMcpTool<any, any, any>>>;
}

type McpDeclarationOperations<
  S extends Schema,
  Scope extends string,
  Tools extends AnyMcpToolBlueprintRecord,
> = {
  readonly tokens: McpTokenOperations<S, Scope>;
  readonly systemTokens: SystemMcpTokenOperations<S, Scope>;
  aiTools(
    ctx: McpAiContext<S>,
    options: McpAiToolsCompleteOptions<Scope>,
  ): McpAiToolSet<Tools>;
  aiTools(
    ctx: McpAiContext<S>,
    options?: McpAiToolsFilteredOptions<Scope>,
  ): Readonly<Partial<McpAiToolSet<Tools>>>;
};

export type McpDeclaration<
  Name extends string = string,
  S extends Schema = Schema,
  Path extends string = string,
  Scope extends string = never,
  Tools extends AnyMcpToolBlueprintRecord = AnyMcpToolBlueprintRecord,
> = McpEndpointDeclaration<Name, Path, Tools> & McpDeclarationOperations<S, Scope, Tools> &
  ([Scope] extends [never] ? object : { readonly scopes: McpScopeDescriptor<Scope> });

/** Runtime-facing endpoint shape with schema, scopes, and exact tool keys deliberately erased. */
export type AnyMcpDeclaration = McpEndpointDeclaration<string, string> & {
  readonly scopes?: McpScopeDescriptor<string>;
};

export interface McpBuilder<S extends Schema> {
  <const Name extends string, const Tools extends McpToolBlueprintRecord<S, never>>(
    config: DefaultMcpConfig<Name, Tools>,
  ): McpDeclaration<Name, S, "/mcp", never, Tools>;
  <
    const Name extends string,
    const Path extends string,
    const Tools extends McpToolBlueprintRecord<S, never>,
  >(
    config: CustomMcpConfig<Name, Path, Tools>,
  ): McpDeclaration<Name, S, Path, never, Tools>;
  <
    const Name extends string,
    const Scopes extends McpScopeValues,
    const Tools extends McpToolBlueprintRecord<S, Scopes[number]>,
  >(
    config: ScopedDefaultMcpConfig<Name, Scopes, Tools>,
  ): McpDeclaration<Name, S, "/mcp", Scopes[number], Tools>;
  <
    const Name extends string,
    const Path extends string,
    const Scopes extends McpScopeValues,
    const Tools extends McpToolBlueprintRecord<S, Scopes[number]>,
  >(
    config: ScopedCustomMcpConfig<Name, Path, Scopes, Tools>,
  ): McpDeclaration<Name, S, Path, Scopes[number], Tools>;
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

export function mcpTool<
  const A extends ObjectShape,
  const O extends ObjectValidator | undefined = undefined,
  const Access extends McpToolBlueprintAccess | undefined = undefined,
  S extends Schema = Schema,
>(
  definition: McpToolDefinition<A, O, S, Access>,
): McpToolBlueprint<A, O, S, McpToolAccessScopes<Access>>;
export function mcpTool(
  definition: McpToolDefinition<
    ObjectShape,
    ObjectValidator | undefined,
    Schema,
    McpToolBlueprintAccess | undefined
  >,
): AnyMcpToolBlueprint {
  const blueprint = Object.freeze({
    isDbzzServerOnly: true as const,
    serverKind: "mcp-tool-blueprint" as const,
  });
  let captured: unknown = definition;
  if (definition !== null && typeof definition === "object") {
    const source = definition as unknown as Record<string, unknown>;
    const args = source.args !== null && typeof source.args === "object" &&
        !Array.isArray(source.args)
      ? Object.freeze({ ...(source.args as Record<string, unknown>) })
      : source.args;
    const annotations = source.annotations !== null &&
        typeof source.annotations === "object" &&
        !Array.isArray(source.annotations)
      ? Object.freeze({ ...(source.annotations as Record<string, unknown>) })
      : source.annotations;
    let access = source.access;
    if (access !== null && typeof access === "object" && !Array.isArray(access)) {
      const accessRecord = access as Record<string, unknown>;
      access = Object.freeze({
        ...accessRecord,
        ...(Array.isArray(accessRecord.anyOf)
          ? { anyOf: Object.freeze([...accessRecord.anyOf]) }
          : {}),
        ...(Array.isArray(accessRecord.allOf)
          ? { allOf: Object.freeze([...accessRecord.allOf]) }
          : {}),
      });
    }
    captured = Object.freeze({
      ...source,
      args,
      ...(source.annotations === undefined ? {} : { annotations }),
      ...(source.access === undefined ? {} : { access }),
    });
  }
  mcpToolBlueprintDefinitions.set(blueprint, captured);
  return blueprint;
}

export function isMcpToolBlueprint(value: unknown): value is AnyMcpToolBlueprint {
  return (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    mcpToolBlueprintDefinitions.has(value);
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

function assembleMcpTool(
  name: string,
  blueprint: AnyMcpToolBlueprint,
  mcp: AnyMcpDeclaration,
  scopeDescriptor: McpScopeDescriptor | undefined,
): AnyRegisteredMcpTool {
  if (!TOOL_NAME.test(name) || byteLength(name) > MAX_MCP_TOOL_NAME_BYTES) {
    throw new TypeError(
      `MCP tool names must be lower_snake_case of at most ${MAX_MCP_TOOL_NAME_BYTES} UTF-8 bytes`,
    );
  }
  const captured = mcpToolBlueprintDefinitions.get(blueprint);
  if (captured === undefined || captured === null || typeof captured !== "object") {
    throw new TypeError(`MCP tool "${name}" has an invalid blueprint definition`);
  }
  const definition = captured as Record<string, unknown>;
  for (const key of Object.keys(definition)) {
    if (
      key !== "title" &&
      key !== "description" &&
      key !== "annotations" &&
      key !== "access" &&
      key !== "args" &&
      key !== "output" &&
      key !== "handler"
    ) {
      throw new TypeError(`unknown MCP tool "${name}" definition field "${key}"`);
    }
  }
  if (typeof definition.description !== "string" || definition.description.trim() === "") {
    throw new TypeError(`MCP tool "${name}" requires a description`);
  }
  if (byteLength(definition.description) > MAX_MCP_TOOL_DESCRIPTION_BYTES) {
    throw new TypeError(
      `MCP tool "${name}" description exceeds ${MAX_MCP_TOOL_DESCRIPTION_BYTES} UTF-8 bytes`,
    );
  }
  const title = definition.title === undefined
    ? undefined
    : nonEmptyString(definition.title, `MCP tool "${name}" title`);
  if (title !== undefined && byteLength(title) > MAX_MCP_TOOL_TITLE_BYTES) {
    throw new TypeError(
      `MCP tool "${name}" title exceeds ${MAX_MCP_TOOL_TITLE_BYTES} UTF-8 bytes`,
    );
  }
  const annotations = toolAnnotations(definition.annotations);
  if (typeof definition.handler !== "function") {
    throw new TypeError(`MCP tool "${name}" requires a handler`);
  }
  const accessPolicy = normalizeMcpToolAccess(
    definition.access,
    scopeDescriptor,
    name,
  );
  const args = definition.args as ObjectShape;
  validateArgsShape(args, `MCP tool ${name} args`);
  if (definition.output !== undefined &&
    (definition.output === null ||
      typeof definition.output !== "object" ||
      (definition.output as { readonly kind?: unknown }).kind !== "object")) {
    throw new TypeError(`MCP tool "${name}" output must be v.object(...)`);
  }
  const outputValidator = definition.output as ObjectValidator | undefined;
  const inputValidator = v.object(args);
  const inputCodec = compileMcpObjectCodec(inputValidator);
  const outputCodec = outputValidator === undefined
    ? undefined
    : compileMcpObjectCodec(outputValidator);
  const tool = {
    isDbzzServerOnly: true as const,
    serverKind: "mcp-tool" as const,
    kind: "mcp-tool" as const,
    name,
    ...(title === undefined ? {} : { title }),
    description: definition.description,
    ...(annotations === undefined ? {} : { annotations }),
    mcp,
    accessPolicy,
    args,
    inputValidator,
    inputCodec,
    inputSchema: inputCodec.inputSchema,
    outputValidator,
    outputCodec,
    outputSchema: outputCodec?.outputSchema,
    access: (ctx: McpToolCtx) => isMcpToolAuthorized(
      accessPolicy,
      ctx.auth,
      mcpLocalGrant(ctx.auth, mcp),
    ),
    handler: definition.handler as AnyRegisteredMcpTool["handler"],
  };
  brand(tool, MCP_TOOL_IDENTITY);
  compileInvocation(tool, inputCodec.decode);
  return Object.freeze(tool) as AnyRegisteredMcpTool;
}

export function createMcp<
  const Name extends string,
  const Tools extends McpToolBlueprintRecord<Schema, never>,
>(
  config: DefaultMcpConfig<Name, Tools>,
): McpDeclaration<Name, Schema, "/mcp", never, Tools>;
export function createMcp<
  const Name extends string,
  const Path extends string,
  const Tools extends McpToolBlueprintRecord<Schema, never>,
>(
  config: CustomMcpConfig<Name, Path, Tools>,
): McpDeclaration<Name, Schema, Path, never, Tools>;
export function createMcp<
  const Name extends string,
  const Scopes extends McpScopeValues,
  const Tools extends McpToolBlueprintRecord<Schema, Scopes[number]>,
>(
  config: ScopedDefaultMcpConfig<Name, Scopes, Tools>,
): McpDeclaration<Name, Schema, "/mcp", Scopes[number], Tools>;
export function createMcp<
  const Name extends string,
  const Path extends string,
  const Scopes extends McpScopeValues,
  const Tools extends McpToolBlueprintRecord<Schema, Scopes[number]>,
>(
  config: ScopedCustomMcpConfig<Name, Path, Scopes, Tools>,
): McpDeclaration<Name, Schema, Path, Scopes[number], Tools>;
export function createMcp(
  config:
    | DefaultMcpConfig<string, McpToolBlueprintRecord<Schema, never>>
    | CustomMcpConfig<string, string, McpToolBlueprintRecord<Schema, never>>
    | ScopedDefaultMcpConfig<string, McpScopeValues, AnyMcpToolBlueprintRecord>
    | ScopedCustomMcpConfig<string, string, McpScopeValues, AnyMcpToolBlueprintRecord>,
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
      key !== "scopes" &&
      key !== "tools"
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
    aiTools(
      context: McpAiContext,
      options?: McpAiToolsOptions<string>,
    ): McpAiToolSet {
      return createMcpAiTools(declaration, context, options);
    },
  } as Record<string, unknown>;
  brand(value, MCP_IDENTITY);
  declaration = value as unknown as AnyMcpDeclaration;

  if (
    config.tools === null ||
    typeof config.tools !== "object" ||
    Array.isArray(config.tools) ||
    (Object.getPrototypeOf(config.tools) !== Object.prototype &&
      Object.getPrototypeOf(config.tools) !== null)
  ) {
    throw new TypeError("MCP tools must be a plain object");
  }
  const tools: Record<string, AnyRegisteredMcpTool> = Object.create(null) as Record<
    string,
    AnyRegisteredMcpTool
  >;
  for (const name of Object.keys(config.tools).sort()) {
    const blueprint = config.tools[name];
    if (!isMcpToolBlueprint(blueprint)) {
      throw new TypeError(`MCP tool "${name}" must be created with mcpTool(...)`);
    }
    tools[name] = assembleMcpTool(name, blueprint, declaration, scopeDescriptor);
  }
  Object.defineProperty(value, "tools", {
    enumerable: true,
    value: Object.freeze(tools),
  });
  declaration = Object.freeze(value) as unknown as AnyMcpDeclaration;
  return declaration;
}

export function isMcpDeclaration(value: unknown): value is AnyMcpDeclaration {
  return hasBrand(value, MCP_IDENTITY);
}

export function isRegisteredMcpTool(value: unknown): value is RegisteredMcpTool {
  return hasBrand(value, MCP_TOOL_IDENTITY);
}

export type AnyRegisteredMcpTool = RegisteredMcpTool<
  any,
  any,
  any
>;

export type {
  CreatedMcpToken,
  McpTokenCreateInput,
  McpTokenDescriptor,
  McpTokenOperations,
  McpTokenUpdateInput,
  SystemMcpTokenOperations,
};
export type {
  McpScopeDescriptor,
  McpScopeValues,
  McpToolAccessPolicy,
  NormalizedMcpToolAccessPolicy,
};
