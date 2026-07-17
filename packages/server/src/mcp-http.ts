import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import {
  CallToolRequestSchema,
  isJSONRPCRequest,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { Principal } from "./auth.ts";
import type { McpEndpointDeclaration } from "./mcp.ts";
import { outcomeFromError } from "./outcome.ts";
import { carryHttpRequestProvenance } from "./request-provenance.ts";
import type { Runtime } from "./runtime.ts";

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
}

function toolError(error: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: outcomeFromError(error).message }],
    isError: true,
  };
}

function callNames(body: unknown): readonly string[] {
  const messages = Array.isArray(body) ? body : [body];
  const names: string[] = [];
  for (const message of messages) {
    if (!isJSONRPCRequest(message)) continue;
    const call = CallToolRequestSchema.safeParse(message);
    if (call.success) names.push(call.data.params.name);
  }
  return names;
}

/** One private official-SDK server/transport pair for exactly one stateless POST. */
export async function handleMcpPost(options: McpPostOptions): Promise<Response> {
  // The transport cannot attach HTTP auth status to a JSON-RPC handler result.
  // Preflight only valid tools/call requests, then the dispatcher repeats this
  // same decision as the authoritative execution boundary.
  for (const name of callNames(options.body)) {
    options.runtime.authorizeMcpTool(options.mcp.name, name, options.principal);
  }

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

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: options.runtime.registry.toolsFor(options.mcp, options.principal).map((tool) => ({
      name: tool.name,
      ...(tool.title === undefined ? {} : { title: tool.title }),
      description: tool.description,
      inputSchema: tool.inputSchema,
      ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
      ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (call, extra) => {
    try {
      const result = await options.runtime.runMcpTool(carryHttpRequestProvenance({
        id: extra.requestId,
        mcp: options.mcp.name,
        tool: call.params.name,
        args: call.params.arguments ?? {},
        principal: options.principal,
        signal: AbortSignal.any([options.signal, extra.signal]),
        fairnessKey: options.fairnessKey,
      }, options.bytes, undefined));
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
    return await transport.handleRequest(options.request, { parsedBody: options.body });
  } finally {
    await server.close();
  }
}
