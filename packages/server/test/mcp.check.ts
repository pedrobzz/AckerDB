/** Compile-time contract for schema-bound MCP tools and client API erasure. */
import type { ApiFromModules } from "@dbzz/core";
import {
  createMcp,
  dbz,
  defineSchema,
  defineTable,
  mutation,
  type McpBuilder,
  type MutationBuilder,
} from "@dbzz/server";

const schema = defineSchema({
  notes: defineTable({
    id: dbz.primaryKey(),
    body: dbz.string(),
  }),
});

const typedMutation = mutation as MutationBuilder<typeof schema>;
const typedMcp = createMcp as McpBuilder<typeof schema>;

const addNote = typedMutation({
  access: "public",
  args: { body: dbz.string() },
  handler: (ctx, args) => ctx.db.notes.insert(args),
});

const agentMcp = typedMcp({ name: "agent" });
const writeNote = agentMcp.tool({
  name: "write_note",
  description: "Write a note.",
  args: { body: dbz.string() },
  handler: async (ctx, args) => {
    const authKind: "anonymous" | "user" | "workload" | "system" = ctx.auth.kind;
    const signal: AbortSignal = ctx.abortSignal;
    // Tools need an explicit transaction before they can reach the database.
    // @ts-expect-error MCP tool contexts do not expose a database directly
    void ctx.db;
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
