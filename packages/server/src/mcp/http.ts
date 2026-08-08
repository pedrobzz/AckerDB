import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import {
  CallToolRequestSchema,
  isJSONRPCRequest,
  JSONRPCMessageSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { Principal } from "../auth/credentials.ts";
import type { AuthInvalidationPublisher } from "../auth/invalidation.ts";
import { AckerDBError } from "../shared/errors.ts";
import type { McpEndpointDeclaration } from "./index.ts";
import { outcomeFromError } from "../runtime/outcome.ts";
import { carryHttpRequestProvenance } from "../runtime/request-provenance.ts";
import type { Runtime } from "../runtime/runtime.ts";
import type { RuntimeMcpToolAuthorization } from "../runtime/mcp/authorization.ts";

// The SDK defaults to constructing AJV for every Server. Stateless MCP needs a
// fresh protocol state per POST, but schema compilation state is process-safe.
const jsonSchemaValidator = new AjvJsonSchemaValidator();

export interface McpPostOptions {
  readonly request: Request;
  readonly body: unknown;
  readonly bytes: number;
  readonly mcp: McpEndpointDeclaration;
  readonly runtime: Runtime;
  readonly principal: Principal;
  readonly signal: AbortSignal;
  readonly fairnessKey: string;
  /** The listener-owned origin for anything a tool call invalidates. */
  readonly invalidations: AuthInvalidationPublisher;
}

function toolError(error: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: outcomeFromError(error).message }],
    isError: true,
  };
}

function authorizeToolCalls(
  body: unknown,
  runtime: Runtime,
  mcp: string,
  principal: Principal,
): ReadonlyMap<string | number, RuntimeMcpToolAuthorization> {
  const messages = Array.isArray(body) ? body : [body];
  if (messages.some((message) => !JSONRPCMessageSchema.safeParse(message).success)) {
    return new Map();
  }
  const authorizations = new Map<string | number, RuntimeMcpToolAuthorization>();
  for (const message of messages) {
    if (!isJSONRPCRequest(message)) continue;
    if (message.method === "tools/call" && typeof message.params?.name === "string") {
      const authorization = runtime.authorizeMcpTool(mcp, message.params.name, principal);
      if (!authorization.ok) throw authorization.error;
      authorizations.set(message.id, authorization);
    }
  }
  return authorizations;
}

/** One private official-SDK server/transport pair for exactly one stateless POST. */
export async function handleMcpPost(options: McpPostOptions): Promise<Response> {
  options.signal.throwIfAborted();
  // Preflight the whole valid batch before any member can execute, retaining
  // the runtime's typed decision so the dispatcher never reauthorizes it.
  const authorizations = authorizeToolCalls(
    options.body,
    options.runtime,
    options.mcp.name,
    options.principal,
  );

  const server = new Server(
    { name: options.mcp.name, version: "1", ...options.mcp.metadata },
    {
      capabilities: { tools: {} },
      jsonSchemaValidator,
      ...(options.mcp.instructions === undefined
        ? {}
        : { instructions: options.mcp.instructions }),
    },
  );
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    options.signal.throwIfAborted();
    const tools = options.runtime.registry.toolsFor(options.mcp, options.principal).map((tool) => ({
      name: tool.name,
      ...(tool.title === undefined ? {} : { title: tool.title }),
      description: tool.description,
      inputSchema: tool.inputSchema,
      ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
      ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
    }));
    return { tools };
  });
  server.setRequestHandler(CallToolRequestSchema, async (call, extra) => {
    try {
      options.signal.throwIfAborted();
      const authorization = authorizations.get(extra.requestId);
      if (authorization === undefined) {
        throw new AckerDBError("internal", "MCP tool authorization was not prepared");
      }
      const result = await options.runtime.runMcpTool(carryHttpRequestProvenance({
        id: extra.requestId,
        authorization,
        args: call.params.arguments ?? {},
        principal: options.principal,
        signal: AbortSignal.any([options.signal, extra.signal]),
        fairnessKey: options.fairnessKey,
      }, options.bytes, undefined, options.invalidations));
      return {
        content: result.content,
        ...(result.structuredContent === undefined
          ? {}
          : { structuredContent: result.structuredContent }),
        ...(result.isError === undefined ? {} : { isError: result.isError }),
        ...(result._meta === undefined ? {} : { _meta: result._meta }),
      } satisfies CallToolResult;
    } catch (error) {
      return toolError(error);
    }
  });

  try {
    await server.connect(transport);
    const response = await transport.handleRequest(options.request, { parsedBody: options.body });
    options.signal.throwIfAborted();
    return response;
  } finally {
    await server.close();
  }
}
