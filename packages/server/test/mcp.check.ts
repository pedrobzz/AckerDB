/** Compile-time contract for schema-bound MCP tools and client API erasure. */
import type { ApiFromModules } from "@dbzz/core";
import {
  createMcp,
  dbz,
  defineSchema,
  defineTable,
  mutation,
  query,
  type McpBuilder,
  type MutationBuilder,
  type QueryBuilder,
} from "@dbzz/server";

const schema = defineSchema({
  notes: defineTable({
    id: dbz.primaryKey(),
    body: dbz.string(),
  }),
});

const typedMutation = mutation as MutationBuilder<typeof schema>;
const typedQuery = query as QueryBuilder<typeof schema>;
const typedMcp = createMcp as McpBuilder<typeof schema>;

const addNote = typedMutation({
  access: "public",
  args: { body: dbz.string() },
  handler: (ctx, args) => ctx.db.notes.insert(args),
});

const agentMcp = typedMcp({ name: "agent" });
const createAgentToken = typedMutation({
  access: "authenticated",
  args: { name: dbz.string() },
  handler: (ctx, args) => agentMcp.tokens.create(ctx, { name: args.name }),
});
const listAgentTokens = typedQuery({
  access: "authenticated",
  args: {},
  handler: (ctx) => agentMcp.tokens.list(ctx),
});
const createdToken: string = createAgentToken._retType!.token;
const listedTokenId: string = listAgentTokens._retType![0]!.id;
// @ts-expect-error listing descriptors never recover the plaintext secret
void listAgentTokens._retType![0]!.token;
void createdToken;
void listedTokenId;
const renamedEndpoint = typedMcp({
  name: "stable_name",
  path: "/renamed/export",
  instructions: "Stable declaration identity is explicit.",
});
const stableName: "stable_name" = renamedEndpoint.name;
const stablePath: "/renamed/export" = renamedEndpoint.path;
void stableName;
void stablePath;
const writeNote = agentMcp.tool({
  name: "write_note",
  description: "Write a note.",
  args: { body: dbz.string() },
  handler: async (ctx, args) => {
    const authKind: "anonymous" | "user" | "mcp" | "workload" | "system" = ctx.auth.kind;
    const signal: AbortSignal = ctx.abortSignal;
    // Tools need an explicit transaction before they can reach the database.
    // @ts-expect-error MCP tool contexts do not expose a database directly
    void ctx.db;
    // @ts-expect-error delegated MCP principals cannot administer owner tokens
    agentMcp.tokens.list(ctx);
    // @ts-expect-error token minting requires an application mutation or transaction context
    agentMcp.tokens.create(ctx, { name: "forbidden" });
    await ctx.tx((tx) => addNote(tx, { body: args.body }));
    return { content: [{ type: "text", text: `${authKind}:${signal.aborted}` }] };
  },
});

// @ts-expect-error declarations require an explicit stable name
typedMcp();

agentMcp.tool({
  name: "wrong_result",
  description: "Prove result typing.",
  args: {},
  // @ts-expect-error tool results are explicit MCP content results
  handler: () => "not MCP content",
});

type GeneratedApi = ApiFromModules<{
  notes: {
    agentMcp: typeof agentMcp;
    writeNote: typeof writeNote;
    addNote: typeof addNote;
  };
}>;

declare const api: GeneratedApi;
void api.notes.addNote;
// @ts-expect-error MCP declarations are server-only, never generated client refs
void api.notes.agentMcp;
// @ts-expect-error MCP tools are server-only, never generated client refs
void api.notes.writeNote;
