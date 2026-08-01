/**
 * MCP endpoints and the tools they publish.
 *
 * A tool is a registered `query`, `mutation`, or `procedure` named in an
 * endpoint's `tools` record. The function stays MCP-unaware: everything the
 * protocol needs — the wire name, the scopes, the annotations, whether a model
 * outside the app may see it — lives on the entry, because the endpoint is the
 * curation surface and a tool list is a prompt.
 *
 * Scopes and tokens live on an `mcpAuth` provider rather than here. See
 * `auth.ts` for why that extraction is structural.
 */
import type { ApplicationError, RegisteredServerOnly, Result } from "@ackerdb/core";
import type { ObjectShape, Validator } from "../validation/v.ts";
import { isRegisteredFunction } from "../app/functions.ts";
import type { AnyRegistered, ErrorDeclarations } from "../app/functions.ts";
import { brand, hasBrand } from "../shared/identity.ts";
import {
  createMcpAiTools,
  type McpAiContext,
  type McpAiToolsCompleteOptions,
  type McpAiToolsFilteredOptions,
  type McpAiToolsOptions,
  type McpAiToolSet,
} from "./ai.ts";
import {
  normalizeMcpToolAccess,
  type McpScopeDescriptor,
  type McpToolAccessPolicy,
  type NormalizedMcpToolAccessPolicy,
} from "./scopes.ts";
import {
  isMcpAuthProvider,
  type AnyMcpAuthProvider,
  type McpAuthScope,
} from "./auth.ts";
import {
  byteLength,
  mcpName,
  nonEmptyString,
  MAX_MCP_INSTRUCTIONS_BYTES,
  MAX_MCP_METADATA_BYTES,
  MAX_MCP_PATH_BYTES,
  MAX_MCP_TOOL_DESCRIPTION_BYTES,
  MAX_MCP_TOOL_NAME_BYTES,
  MAX_MCP_TOOL_TITLE_BYTES,
  MCP_PATH,
  TOOL_NAME,
} from "./naming.ts";
import { compileMcpToolCodec, type McpToolCodec } from "./tool-codec.ts";
import type { JsonObjectSchema } from "../validation/json-schema.ts";
import type { McpCallToolResult } from "./content.ts";
import type { Schema } from "../schema/definition.ts";

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
} from "./content.ts";
export type {
  McpAiContext,
  McpAiModelOutput,
  McpAiToolsCompleteOptions,
  McpAiToolsFilteredOptions,
  McpAiToolsOptions,
  McpAiTool,
  McpAiToolSet,
} from "./ai.ts";
export {
  mcpAuth,
  isMcpAuthProvider,
  type AnyMcpAuthProvider,
  type McpAuthBuilder,
  type McpAuthConfig,
  type McpAuthProvider,
  type McpAuthScope,
  type ScopedMcpAuthConfig,
} from "./auth.ts";
export { MCP_OUTPUT_WRAP_KEY, type McpToolCodec } from "./tool-codec.ts";
export { mcpContent, isMcpContentValidator, type McpContentValidator } from "./content.ts";

const MCP_IDENTITY = Symbol.for("@ackerdb/server/Mcp/v1");
const MCP_TOOL_IDENTITY = Symbol.for("@ackerdb/server/McpTool/v1");
const DEFAULT_MCP_PATH = "/mcp";

export interface McpEndpointMetadata {
  readonly title?: string;
  readonly description?: string;
  readonly websiteUrl?: string;
}

export interface McpToolAnnotations {
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

export type McpInputSchema = JsonObjectSchema;
export type McpOutputSchema = JsonObjectSchema;

/**
 * The kinds a tool may be. `sse` is absent deliberately: MCP has no streaming
 * tool result, so an `sseProcedure` in a tools record fails to type-check
 * rather than failing at call time.
 */
export type McpToolKind = "query" | "mutation" | "procedure";

/**
 * What an entry needs to see of the function it names: the kind, and the parts
 * curation and the codec read. `access` and `handler` are deliberately absent —
 * both put the args shape in a contravariant position, which would reject every
 * concrete function. The runtime reads them off the registered value itself.
 */
export type McpToolFunction<S extends Schema = Schema> = {
  readonly isAckerDB: true;
  readonly kind: McpToolKind;
  readonly args: ObjectShape;
  readonly description?: string;
  readonly title?: string;
  readonly returns?: Validator<unknown, string>;
  readonly errors?: ErrorDeclarations;
  /** Compile-only invariant marker: a tool's function reads this endpoint's schema. */
  readonly _schema?: (schema: S) => S;
};

/**
 * One tool: the function, plus everything about publishing it that belongs to
 * this endpoint rather than to the function.
 *
 * `access` is typed against the endpoint's provider, so a scope the provider
 * never declared is a compile error. It defaults to `"authenticated"` — any
 * valid token on the provider, never an anonymous caller. `"public"` exists and
 * must be written, so opening a tool to unauthenticated callers reads as a
 * decision rather than as an omission.
 */
export interface McpToolEntry<
  S extends Schema = Schema,
  Scope extends string = never,
> {
  readonly fn: McpToolFunction<S>;
  readonly access?: McpToolAccessPolicy<Scope>;
  readonly annotations?: McpToolAnnotations;
  /** In-app callers only: absent from `tools/list` and refused from outside. */
  readonly private?: boolean;
}

export type McpToolEntryRecord<
  S extends Schema = Schema,
  Scope extends string = never,
> = Readonly<Record<string, McpToolEntry<S, Scope>>>;

export type AnyMcpToolEntry = McpToolEntry<any, string>;
export type AnyMcpToolEntryRecord = Readonly<Record<string, AnyMcpToolEntry>>;

export interface RegisteredMcpTool<Name extends string = string>
  extends RegisteredServerOnly {
  readonly serverKind: "mcp-tool";
  readonly name: Name;
  readonly title?: string;
  readonly description: string;
  readonly annotations?: McpToolAnnotations;
  readonly private: boolean;
  readonly mcp: McpEndpointDeclaration;
  readonly accessPolicy: NormalizedMcpToolAccessPolicy;
  /** The registered function this tool calls; it owns args, policy, and handler. */
  readonly fn: AnyRegistered;
  readonly codec: McpToolCodec;
  readonly inputSchema: McpInputSchema;
  readonly outputSchema: McpOutputSchema | undefined;
}

export type AnyRegisteredMcpTool = RegisteredMcpTool<string>;

export type RegisteredMcpTools<Tools extends AnyMcpToolEntryRecord> = Readonly<{
  [Name in keyof Tools]: RegisteredMcpTool<Name & string>;
}>;

interface McpConfigBase<
  Name extends string,
  Auth extends AnyMcpAuthProvider,
  Tools extends AnyMcpToolEntryRecord,
> {
  readonly name: Name;
  /** The provider owning this endpoint's scope vocabulary and its tokens. */
  readonly auth: Auth;
  readonly tools: Tools;
  readonly instructions?: string;
  readonly metadata?: McpEndpointMetadata;
}

export interface DefaultMcpConfig<
  Name extends string,
  Auth extends AnyMcpAuthProvider = AnyMcpAuthProvider,
  Tools extends AnyMcpToolEntryRecord = AnyMcpToolEntryRecord,
> extends McpConfigBase<Name, Auth, Tools> {
  readonly path?: undefined;
  readonly private?: false;
}

export interface CustomMcpConfig<
  Name extends string,
  Path extends string,
  Auth extends AnyMcpAuthProvider = AnyMcpAuthProvider,
  Tools extends AnyMcpToolEntryRecord = AnyMcpToolEntryRecord,
> extends McpConfigBase<Name, Auth, Tools> {
  readonly path: Path;
  readonly private?: false;
}

/**
 * A private endpoint claims no path and is never served: it is reachable only
 * through `aiTools`. `path` is `never` here rather than merely ignored, so
 * "private but somehow addressable" cannot be written down.
 */
export interface PrivateMcpConfig<
  Name extends string,
  Auth extends AnyMcpAuthProvider = AnyMcpAuthProvider,
  Tools extends AnyMcpToolEntryRecord = AnyMcpToolEntryRecord,
> extends McpConfigBase<Name, Auth, Tools> {
  readonly private: true;
  readonly path?: never;
}

export interface McpEndpointDeclaration<
  Name extends string = string,
  Path extends string | null = string | null,
  Tools extends AnyMcpToolEntryRecord | undefined = undefined,
> extends RegisteredServerOnly {
  readonly serverKind: "mcp";
  readonly name: Name;
  /** `null` when the endpoint is private and therefore claims no route. */
  readonly path: Path;
  readonly private: boolean;
  readonly auth: AnyMcpAuthProvider;
  readonly instructions?: string;
  readonly metadata: McpEndpointMetadata;
  readonly tools: [Tools] extends [AnyMcpToolEntryRecord]
    ? RegisteredMcpTools<Tools>
    : Readonly<Record<string, AnyRegisteredMcpTool>>;
}

type McpDeclarationOperations<S extends Schema, Scope extends string, Tools extends AnyMcpToolEntryRecord> = {
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
  Path extends string | null = string | null,
  Scope extends string = never,
  Tools extends AnyMcpToolEntryRecord = AnyMcpToolEntryRecord,
> = McpEndpointDeclaration<Name, Path, Tools> & McpDeclarationOperations<S, Scope, Tools>;

/** Runtime-facing endpoint shape with schema and exact tool keys deliberately erased. */
export type AnyMcpDeclaration = McpEndpointDeclaration<string, string | null>;

export interface McpBuilder<S extends Schema> {
  <
    const Name extends string,
    const Auth extends AnyMcpAuthProvider,
    const Tools extends McpToolEntryRecord<S, McpAuthScope<Auth>>,
  >(
    config: DefaultMcpConfig<Name, Auth, Tools>,
  ): McpDeclaration<Name, S, "/mcp", McpAuthScope<Auth>, Tools>;
  <
    const Name extends string,
    const Path extends string,
    const Auth extends AnyMcpAuthProvider,
    const Tools extends McpToolEntryRecord<S, McpAuthScope<Auth>>,
  >(
    config: CustomMcpConfig<Name, Path, Auth, Tools>,
  ): McpDeclaration<Name, S, Path, McpAuthScope<Auth>, Tools>;
  <
    const Name extends string,
    const Auth extends AnyMcpAuthProvider,
    const Tools extends McpToolEntryRecord<S, McpAuthScope<Auth>>,
  >(
    config: PrivateMcpConfig<Name, Auth, Tools>,
  ): McpDeclaration<Name, S, null, McpAuthScope<Auth>, Tools>;
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

function toolAnnotations(value: unknown, where: string): McpToolAnnotations | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${where} annotations must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${where} annotations must be a plain object`);
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
      throw new TypeError(`unknown ${where} annotation "${key}"`);
    }
  }
  const result: Partial<Record<typeof fields[number], boolean>> = {};
  for (const field of fields) {
    if (input[field] === undefined) continue;
    if (typeof input[field] !== "boolean") {
      throw new TypeError(`${where} annotation ${field} must be a boolean`);
    }
    result[field] = input[field];
  }
  return Object.freeze(result);
}

const TOOL_KINDS: ReadonlySet<string> = new Set<McpToolKind>([
  "query",
  "mutation",
  "procedure",
]);

function assembleMcpTool(
  name: string,
  entry: AnyMcpToolEntry,
  mcp: AnyMcpDeclaration,
  scopeDescriptor: McpScopeDescriptor | undefined,
): AnyRegisteredMcpTool {
  const where = `MCP tool "${name}"`;
  if (!TOOL_NAME.test(name) || byteLength(name) > MAX_MCP_TOOL_NAME_BYTES) {
    throw new TypeError(
      `MCP tool names must be lower_snake_case of at most ${MAX_MCP_TOOL_NAME_BYTES} UTF-8 bytes`,
    );
  }
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    throw new TypeError(`${where} must be an object naming a registered function`);
  }
  for (const key of Object.keys(entry)) {
    if (key !== "fn" && key !== "access" && key !== "annotations" && key !== "private") {
      throw new TypeError(`unknown ${where} entry field "${key}"`);
    }
  }
  // Registered functions stay directly callable for server-side composition, so
  // this asks the registry's own predicate rather than guessing at the shape.
  const fn = entry.fn as AnyRegistered | undefined;
  if (!isRegisteredFunction(fn)) {
    throw new TypeError(`${where} fn must be a registered query, mutation, or procedure`);
  }
  if (!TOOL_KINDS.has(fn.kind)) {
    throw new TypeError(
      `${where} is a ${fn.kind}, which the MCP surface does not serve`,
    );
  }
  // A system function would execute as the MCP principal and fail its own policy
  // on every call. `private` is how an internal-only tool is expressed, and it
  // needs no one's authority raised.
  if (fn.access === "system") {
    throw new TypeError(
      `${where} declares access "system" and cannot be an MCP tool; use \`private\` for an in-app tool`,
    );
  }
  const description = fn.description;
  if (typeof description !== "string" || description.trim() === "") {
    throw new TypeError(`${where} requires a description on the function it names`);
  }
  if (byteLength(description) > MAX_MCP_TOOL_DESCRIPTION_BYTES) {
    throw new TypeError(
      `${where} description exceeds ${MAX_MCP_TOOL_DESCRIPTION_BYTES} UTF-8 bytes`,
    );
  }
  const title = fn.title === undefined ? undefined : nonEmptyString(fn.title, `${where} title`);
  if (title !== undefined && byteLength(title) > MAX_MCP_TOOL_TITLE_BYTES) {
    throw new TypeError(`${where} title exceeds ${MAX_MCP_TOOL_TITLE_BYTES} UTF-8 bytes`);
  }
  const annotations = toolAnnotations(entry.annotations, where);
  if (entry.private !== undefined && typeof entry.private !== "boolean") {
    throw new TypeError(`${where} private must be a boolean`);
  }
  // Absent access is "authenticated": any valid token on the provider, never an
  // anonymous caller. Opening a tool to those is spelled `"public"`.
  const accessPolicy = normalizeMcpToolAccess(
    entry.access ?? "authenticated",
    scopeDescriptor,
    name,
  );
  const codec = compileMcpToolCodec(where, fn);
  const tool = {
    isAckerDBServerOnly: true as const,
    serverKind: "mcp-tool" as const,
    name,
    ...(title === undefined ? {} : { title }),
    description,
    ...(annotations === undefined ? {} : { annotations }),
    private: entry.private === true,
    mcp,
    accessPolicy,
    fn,
    codec,
    inputSchema: codec.inputSchema,
    outputSchema: codec.outputSchema,
  };
  brand(tool, MCP_TOOL_IDENTITY);
  return Object.freeze(tool) as unknown as AnyRegisteredMcpTool;
}

export function mcp<
  const Name extends string,
  const Auth extends AnyMcpAuthProvider,
  const Tools extends McpToolEntryRecord<Schema, McpAuthScope<Auth>>,
>(config: DefaultMcpConfig<Name, Auth, Tools>): McpDeclaration<Name, Schema, "/mcp", McpAuthScope<Auth>, Tools>;
export function mcp<
  const Name extends string,
  const Path extends string,
  const Auth extends AnyMcpAuthProvider,
  const Tools extends McpToolEntryRecord<Schema, McpAuthScope<Auth>>,
>(config: CustomMcpConfig<Name, Path, Auth, Tools>): McpDeclaration<Name, Schema, Path, McpAuthScope<Auth>, Tools>;
export function mcp<
  const Name extends string,
  const Auth extends AnyMcpAuthProvider,
  const Tools extends McpToolEntryRecord<Schema, McpAuthScope<Auth>>,
>(config: PrivateMcpConfig<Name, Auth, Tools>): McpDeclaration<Name, Schema, null, McpAuthScope<Auth>, Tools>;
export function mcp(
  config:
    | DefaultMcpConfig<string>
    | CustomMcpConfig<string, string>
    | PrivateMcpConfig<string>,
): AnyMcpDeclaration {
  if (config === null || typeof config !== "object") {
    throw new TypeError("mcp config is required");
  }
  for (const key of Object.keys(config).sort()) {
    if (
      key !== "name" &&
      key !== "auth" &&
      key !== "path" &&
      key !== "private" &&
      key !== "instructions" &&
      key !== "metadata" &&
      key !== "tools"
    ) {
      throw new TypeError(`unknown MCP config field "${key}"`);
    }
  }
  const name = mcpName(config.name, "MCP name");
  if (!isMcpAuthProvider(config.auth)) {
    throw new TypeError(`MCP "${name}" auth must be an mcpAuth(...) provider`);
  }
  const auth = config.auth;
  const isPrivate = (config as { readonly private?: unknown }).private === true;
  if ((config as { readonly private?: unknown }).private !== undefined &&
    typeof (config as { readonly private?: unknown }).private !== "boolean") {
    throw new TypeError(`MCP "${name}" private must be a boolean`);
  }
  const declaredPath = (config as { readonly path?: unknown }).path;
  if (isPrivate && declaredPath !== undefined) {
    throw new TypeError(
      `MCP "${name}" is private and claims no path; remove \`path\``,
    );
  }
  let path: string | null = null;
  if (!isPrivate) {
    path = declaredPath === undefined ? DEFAULT_MCP_PATH : (declaredPath as string);
    if (typeof path !== "string" || !MCP_PATH.test(path) || byteLength(path) > MAX_MCP_PATH_BYTES) {
      throw new TypeError(
        `MCP path must be an absolute static path of at most ${MAX_MCP_PATH_BYTES} UTF-8 bytes`,
      );
    }
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

  let declaration!: AnyMcpDeclaration;
  const value = {
    isAckerDBServerOnly: true as const,
    serverKind: "mcp" as const,
    name,
    path,
    private: isPrivate,
    auth,
    ...(instructions === undefined ? {} : { instructions }),
    metadata,
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
  const claimed = new Map<AnyRegistered, string>();
  for (const toolName of Object.keys(config.tools).sort()) {
    const entry = (config.tools as AnyMcpToolEntryRecord)[toolName]!;
    const tool = assembleMcpTool(toolName, entry, declaration, auth.scopes);
    const existing = claimed.get(tool.fn);
    if (existing !== undefined) {
      throw new TypeError(
        `MCP "${name}" publishes one function as both "${existing}" and "${toolName}"`,
      );
    }
    claimed.set(tool.fn, toolName);
    tools[toolName] = tool;
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

export function isRegisteredMcpTool(value: unknown): value is AnyRegisteredMcpTool {
  return hasBrand(value, MCP_TOOL_IDENTITY);
}

/**
 * One tool result, from the `Result` the function's own invocation produced.
 *
 * A declared application error is a normal result carrying `isError`, not a
 * JSON-RPC error: hosts treat those as a broken tool and usually abort the
 * turn, which is the wrong outcome for an expected business result. It cannot
 * ride `structuredContent` either, because an error body does not match the
 * tool's published `outputSchema`.
 */
export function finalizeMcpToolResult(
  tool: Pick<AnyRegisteredMcpTool, "codec">,
  result: Result<unknown, unknown>,
): McpCallToolResult {
  if (!result.ok) {
    const error = tool.codec.encodeError(result.error as ApplicationError);
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify(error) }],
    };
  }
  if (tool.codec.returnsContent) {
    // The handler already produced the blocks; the codec only validated them.
    return tool.codec.encodeOutput(result.data) as unknown as McpCallToolResult;
  }
  const structuredContent = tool.codec.encodeOutput(result.data);
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

export type {
  CreatedMcpToken,
  McpTokenCreateInput,
  McpTokenDescriptor,
  McpTokenOperations,
  McpTokenUpdateInput,
  SystemMcpTokenOperations,
} from "./token-context.ts";
export type {
  McpScopeDescriptor,
  McpScopeValues,
  McpToolAccessPolicy,
  NormalizedMcpToolAccessPolicy,
} from "./scopes.ts";
