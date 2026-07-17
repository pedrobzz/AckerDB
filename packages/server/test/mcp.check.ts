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
  type Validator,
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

const summarizeNote = agentMcp.tool({
  name: "summarize_note",
  description: "Return a typed summary.",
  args: {
    body: dbz.string().describe("The note body."),
    label: dbz.nullable(dbz.string()),
  },
  output: dbz.object({
    length: dbz.number(),
    label: dbz.nullable(dbz.string()),
  }),
  handler: (_ctx, args) => {
    const body: string = args.body;
    const label: string | null = args.label;
    return { length: body.length, label };
  },
});
void summarizeNote;

type StandardInput<V extends { readonly "~standard": { readonly types?: unknown } }> =
  NonNullable<V["~standard"]["types"]> extends { readonly input: infer Input }
    ? Input
    : never;
type StandardOutput<V extends { readonly "~standard": { readonly types?: unknown } }> =
  NonNullable<V["~standard"]["types"]> extends { readonly output: infer Output }
    ? Output
    : never;
interface NeutralStandard<Input, Output> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
      options?: { readonly libraryOptions?: Record<string, unknown> },
    ) =>
      | { readonly value: Output; readonly issues?: undefined }
      | { readonly issues: readonly { readonly message: string }[] }
      | Promise<unknown>;
    readonly types?: { readonly input: Input; readonly output: Output };
    readonly jsonSchema: {
      readonly input: (options: { readonly target: string }) => Record<string, unknown>;
      readonly output: (options: { readonly target: string }) => Record<string, unknown>;
    };
  };
}
const summaryInput = dbz.object({
  body: dbz.string(),
  label: dbz.nullable(dbz.string()),
});
const validStandardInput: StandardInput<typeof summaryInput> = { body: "hello" };
const validStandardOutput: StandardOutput<typeof summaryInput> = { body: "hello", label: null };
const neutralStandard: NeutralStandard<
  StandardInput<typeof summaryInput>,
  StandardOutput<typeof summaryInput>
> = summaryInput;
void validStandardInput;
void validStandardOutput;
void neutralStandard;
// @ts-expect-error Standard input inference keeps required fields required
const missingStandardInput: StandardInput<typeof summaryInput> = {};
// @ts-expect-error Standard output inference includes normalized nullable fields
const missingStandardOutput: StandardOutput<typeof summaryInput> = { body: "hello" };
void missingStandardInput;
void missingStandardOutput;

const runtimeOnlyValidator: Validator<string, "runtime-only"> = {
  kind: "runtime-only",
  check(value) {
    if (typeof value !== "string") throw new TypeError("expected string");
    return value;
  },
  tsType: () => "string",
  descriptor: () => ({ k: "runtime-only" }),
};

agentMcp.tool({
  name: "runtime_only_input",
  description: "Prove MCP fields have an honest schema.",
  args: {
    // @ts-expect-error runtime-only validators cannot be advertised as MCP schemas
    value: runtimeOnlyValidator,
  },
  handler: () => ({ content: [{ type: "text", text: "never" }] }),
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

agentMcp.tool({
  name: "scalar_args",
  description: "Prove input roots are objects.",
  // @ts-expect-error MCP inputs are argument shapes, never scalar roots
  args: dbz.string(),
  handler: () => ({ content: [{ type: "text", text: "never" }] }),
});

agentMcp.tool({
  name: "scalar_output",
  description: "Prove output roots are objects.",
  args: {},
  // @ts-expect-error advertised structured outputs require dbz.object(...)
  output: dbz.string(),
  handler: () => ({ content: [{ type: "text", text: "never" }] }),
});

agentMcp.tool({
  name: "nullable_output",
  description: "Prove nullable results use a named property.",
  args: {},
  // @ts-expect-error a nullable object is not an object-root output schema
  output: dbz.nullable(dbz.object({ value: dbz.string() })),
  handler: () => ({ content: [{ type: "text", text: "never" }] }),
});

agentMcp.tool({
  name: "wrong_structured_result",
  description: "Prove structured result inference.",
  args: {},
  output: dbz.object({ value: dbz.string() }),
  // @ts-expect-error handlers must return the declared structured object
  handler: () => ({ value: 1 }),
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
