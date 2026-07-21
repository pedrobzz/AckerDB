/** Compile-time contract for endpoint-owned MCP tools and exact AI tool maps. */
import type { ApiFromModules } from "@dbzz/core";
import type { ToolSet } from "ai";
import {
  createMcp,
  defineSchema,
  defineTable,
  mcpTool,
  procedure,
  v,
  type McpBuilder,
  type McpCallToolResult,
  type McpToolBuilder,
  type ProcedureBuilder,
} from "@dbzz/server";

const rawEcho = mcpTool({
  description: "Raw schema-agnostic builder fixture.",
  args: { text: v.string() },
  handler: (_ctx, args) => ({ content: [{ type: "text", text: args.text }] }),
});
const rawEndpoint = createMcp({
  name: "raw",
  path: "/raw/mcp",
  tools: { raw_echo: rawEcho },
});
const rawName: "raw_echo" = rawEndpoint.tools.raw_echo.name;
void rawName;

const schema = defineSchema({
  rows: defineTable({ id: v.primaryKey(), value: v.string() }),
});
const typedMcp = createMcp as McpBuilder<typeof schema>;
const typedMcpTool = mcpTool as McpToolBuilder<typeof schema>;
const typedProcedure = procedure as ProcedureBuilder<typeof schema>;

const schemaWithSecrets = defineSchema({
  rows: defineTable({ id: v.primaryKey(), value: v.string() }),
  secrets: defineTable({ id: v.primaryKey(), value: v.string() }),
});
const schemaWithoutSecrets = defineSchema({
  rows: defineTable({ id: v.primaryKey(), value: v.string() }),
});
const secretsMcpTool = mcpTool as McpToolBuilder<typeof schemaWithSecrets>;
const withoutSecretsMcp = createMcp as McpBuilder<typeof schemaWithoutSecrets>;

const readSecrets = secretsMcpTool({
  description: "Read a table that exists only in the source schema.",
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.tx((tx) => tx.db.secrets.scan().collect());
    return { content: [{ type: "text", text: String(rows.length) }] };
  },
});

withoutSecretsMcp({
  name: "wrong_schema",
  tools: {
    // @ts-expect-error a blueprint handler cannot be assembled against a different schema
    read_secrets: readSecrets,
  },
});

const echo = typedMcpTool({
  description: "Echo lossless protocol values.",
  access: { anyOf: ["read"] },
  args: {
    id: v.bigint(),
    bytes: v.bytes(),
    label: v.string().optional(),
  },
  output: v.object({
    id: v.bigint(),
    bytes: v.bytes(),
    label: v.string().nullable(),
  }),
  handler: (_ctx, args) => ({
    id: args.id,
    bytes: args.bytes,
    label: args.label ?? null,
  }),
});

const raw = typedMcpTool({
  description: "Return raw MCP content.",
  args: { text: v.string() },
  handler: (_ctx, args) => ({ content: [{ type: "text", text: args.text }] }),
});

typedMcpTool({
  // @ts-expect-error wire names belong exclusively to endpoint record keys
  name: "old_definition_name",
  description: "The removed definition shape must not compile.",
  args: {},
  handler: () => ({ content: [] }),
});

const adminOnly = typedMcpTool({
  description: "Scope subset failure fixture.",
  access: { anyOf: ["admin"] },
  args: {},
  handler: () => ({ content: [] }),
});

const endpoint = typedMcp({
  name: "typed",
  scopes: ["read", "operate"] as const,
  tools: {
    echo_values: echo,
    raw_result: raw,
    reused_echo: echo,
  },
});

typedMcp({
  name: "invalid_scope_subset",
  scopes: ["read"] as const,
  tools: {
    // @ts-expect-error blueprint scopes must be a subset of endpoint scopes
    admin_only: adminOnly,
  },
});

// @ts-expect-error endpoint declarations no longer register tools imperatively
endpoint.tool({});
// @ts-expect-error inert blueprints have no wire name before endpoint assembly
void echo.name;
// @ts-expect-error inert blueprints have no endpoint identity
void echo.mcp;

const exactToolName: "echo_values" | "raw_result" | "reused_echo" =
  null as never as keyof typeof endpoint.tools;
void exactToolName;
// @ts-expect-error declarations retain exact keys without a string index
void endpoint.tools.not_declared;

const useTools = typedProcedure({
  access: "authenticated",
  args: {},
  handler: async (ctx) => {
    const filtered = endpoint.aiTools(ctx, { scopes: ["read"] });
    // @ts-expect-error normal authorization filtering makes every tool optional
    await filtered.echo_values.execute({ id: "1", bytes: "AQ==" });
    if (filtered.echo_values !== undefined) {
      const output: {
        id: string;
        bytes: string;
        label: string | null;
      } = await filtered.echo_values.execute({ id: "1", bytes: "AQ==" });
      void output;
      // @ts-expect-error AI inputs are accepted Standard JSON, not native bigint
      await filtered.echo_values.execute({ id: 1n, bytes: new Uint8Array() });
    }
    // @ts-expect-error filtered maps retain exact keys without a string index
    void filtered.not_declared;

    const complete = endpoint.aiTools(ctx, {
      scopes: ["read", "operate"],
      includeUnavailable: true,
    });
    const aiSdkTools: ToolSet = complete;
    const rawResult: McpCallToolResult = await complete.raw_result.execute({ text: "hello" });
    const structuredResult: { id: string; bytes: string; label: string | null } =
      await complete.echo_values.execute({ id: 1, bytes: "AQ==" });
    void aiSdkTools;
    void rawResult;
    void structuredResult;
    // @ts-expect-error complete maps retain exact keys without a string index
    void complete.not_declared;
  },
});
void useTools;

type GeneratedApi = ApiFromModules<{
  mcp: { endpoint: typeof endpoint };
  tools: { echo: typeof echo; raw: typeof raw };
  app: { useTools: typeof useTools };
}>;
declare const api: GeneratedApi;
void api.app.useTools;
// @ts-expect-error endpoint declarations are server-only
void api.mcp.endpoint;
// @ts-expect-error exported inert blueprints are server-only
void api.tools.echo;
