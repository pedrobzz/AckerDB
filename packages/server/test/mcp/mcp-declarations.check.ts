/** Compile-time contract for function-backed MCP tools and exact AI tool maps. */
import type { ApiFromModules } from "@ackerdb/core";
import type { ToolSet } from "ai";
import {
  defineSchema,
  defineTable,
  mcp,
  mcpAuth,
  procedure,
  query,
  sseProcedure,
  v,
  type McpAuthBuilder,
  type McpBuilder,
  type ProcedureBuilder,
  type QueryBuilder,
} from "@ackerdb/server";

const schema = defineSchema({
  rows: defineTable({ id: v.primaryKey(), value: v.string() }),
});
const typedMcp = mcp as McpBuilder<typeof schema>;
const typedMcpAuth = mcpAuth as McpAuthBuilder<typeof schema>;
const typedProcedure = procedure as ProcedureBuilder<typeof schema>;
const typedQuery = query as QueryBuilder<typeof schema>;

const auth = typedMcpAuth({ name: "typed", scopes: ["read", "operate"] as const });

const echo = typedQuery({
  description: "Echo lossless protocol values.",
  access: "authenticated",
  args: {
    id: v.bigint(),
    bytes: v.bytes(),
    label: v.string().optional(),
  },
  returns: v.object({
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

const counted = typedQuery({
  description: "A non-object return crosses wrapped under `value`.",
  access: "authenticated",
  args: {},
  returns: v.int(),
  handler: () => 1,
});

const streamed = sseProcedure({
  description: "MCP has no streaming tool result.",
  access: "authenticated",
  args: {},
  yields: v.string(),
  handler: async function* () {
    yield "chunk";
  },
});

const endpoint = typedMcp({
  name: "typed",
  auth,
  tools: {
    counted_value: { fn: counted, access: { anyOf: ["read"] } },
    echo_values: { fn: echo, access: { anyOf: ["read"] } },
  },
});

typedMcp({
  name: "invalid_scope",
  auth,
  tools: {
    // @ts-expect-error a scope the provider never declared cannot be named
    admin_only: { fn: echo, access: { anyOf: ["admin"] } },
  },
});

typedMcp({
  name: "streaming",
  auth,
  tools: {
    // @ts-expect-error an sseProcedure is not a tool kind
    streamed: { fn: streamed },
  },
});

typedMcp({
  name: "private_with_path",
  auth,
  private: true,
  // @ts-expect-error a private endpoint claims no path
  path: "/private",
  tools: {},
});

// A private endpoint is reachable only through `aiTools`, and its path is null.
const privateEndpoint = typedMcp({
  name: "private_agent",
  auth,
  private: true,
  tools: { echo_values: { fn: echo, access: { anyOf: ["read"] } } },
});
const noPath: null = privateEndpoint.path;
void noPath;

const exactToolName: "counted_value" | "echo_values" =
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
        id: bigint;
        bytes: Uint8Array;
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
    // A non-object return is wrapped, and the wrap is visible in the type.
    const wrapped: { readonly value: number } = await complete.counted_value.execute({});
    const structuredResult: { id: bigint; bytes: Uint8Array; label: string | null } =
      await complete.echo_values.execute({ id: 1, bytes: "AQ==" });
    void aiSdkTools;
    void wrapped;
    void structuredResult;
    // @ts-expect-error complete maps retain exact keys without a string index
    void complete.not_declared;
  },
});
void useTools;

type GeneratedApi = ApiFromModules<{
  mcp: { endpoint: typeof endpoint; auth: typeof auth };
  app: { useTools: typeof useTools; echo: typeof echo };
}>;
declare const api: GeneratedApi;
void api.app.useTools;
// A tool is an ordinary function, so it keeps its place on the client api.
void api.app.echo;
// @ts-expect-error endpoint declarations are server-only
void api.mcp.endpoint;
// @ts-expect-error auth providers are server-only
void api.mcp.auth;
