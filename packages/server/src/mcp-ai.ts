import { AsyncLocalStorage } from "node:async_hooks";
import type { ProcedureCtx } from "./functions.ts";
import type {
  AnyRegisteredMcpTool,
  McpDeclaration,
} from "./mcp.ts";
import type {
  McpCallToolResult,
  McpJsonValue,
} from "./mcp-content.ts";
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

export interface McpAiRuntimeCapability {
  readonly toolsFor: (
    mcp: McpDeclaration,
  ) => readonly AnyRegisteredMcpTool[] | undefined;
  readonly execute: (
    mcp: McpDeclaration,
    tool: AnyRegisteredMcpTool,
    args: unknown,
  ) => Promise<McpCallToolResult>;
}

interface BoundMcpAiCapability extends McpAiRuntimeCapability {
  readonly assertActive: () => void;
}

const capabilities = new WeakMap<ProcedureCtx, BoundMcpAiCapability>();

/** Bind same-process MCP authority to one Runtime-owned procedure lifecycle. */
export function bindMcpAiContext(
  context: ProcedureCtx,
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

/** Materialize only the public, registry-owned tools visible to this Runtime. */
export function createMcpAiTools(
  mcp: McpDeclaration,
  context: ProcedureCtx,
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

  const runInParent = AsyncLocalStorage.snapshot();
  const tools: Record<string, McpAiTool> = Object.create(null) as Record<string, McpAiTool>;
  for (const tool of registered) {
    if (tool.access !== "public") continue;
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
          const result = await capability.execute(mcp, tool, input);
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
