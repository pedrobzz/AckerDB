/** Compile-time contract for schema-bound MCP tools and client API erasure. */
import type { ApiFromModules, Identity } from "@dbzz/core";
import {
  createMcp,
  dbz,
  defineSchema,
  defineTable,
  mutation,
  query,
  type McpBuilder,
  type McpToolResult,
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
const scopedMcp = typedMcp({
  name: "scoped_agent",
  path: "/scoped/mcp",
  scopes: ["orders.all", "orders.get", "reports.all"] as const,
});
type AgentScope = NonNullable<typeof scopedMcp.scopes._type>;
const exactScope: AgentScope = "orders.get";
const scopeValidator: Validator<AgentScope> = scopedMcp.scopes;
void exactScope;
void scopeValidator;
// @ts-expect-error the descriptor exposes only the declaration's literal union
const unknownScope: AgentScope = "orders.create";
void unknownScope;
// @ts-expect-error a scope-free declaration has no scope descriptor
void agentMcp.scopes;
const createAgentToken = typedMutation({
  access: "authenticated",
  args: { name: dbz.string() },
  handler: (ctx, args) => agentMcp.tokens.create(ctx, { name: args.name }),
});
const createScopedToken = typedMutation({
  access: "authenticated",
  args: {
    name: dbz.string(),
    scopes: dbz.array(scopedMcp.scopes),
  },
  handler: (ctx, args) => scopedMcp.tokens.create(ctx, args),
});
const updateScopedToken = typedMutation({
  access: "authenticated",
  args: {
    tokenId: dbz.string(),
    scopes: dbz.array(scopedMcp.scopes),
  },
  handler: (ctx, args) => scopedMcp.tokens.updateScopes(ctx, args.tokenId, args.scopes),
});
const listAgentTokens = typedQuery({
  access: "authenticated",
  args: {},
  handler: (ctx) => agentMcp.tokens.list(ctx),
});
const updateAgentToken = typedMutation({
  access: "authenticated",
  args: { tokenId: dbz.string(), name: dbz.string() },
  handler: (ctx, args) => agentMcp.tokens.update(ctx, args.tokenId, { name: args.name }),
});
const revokeAgentToken = typedMutation({
  access: "authenticated",
  args: { tokenId: dbz.string() },
  handler: (ctx, args) => agentMcp.tokens.revoke(ctx, args.tokenId),
});
const createSystemAgentToken = typedMutation({
  access: "system",
  args: { identity: dbz.identity(), name: dbz.string() },
  handler: (ctx, args) => agentMcp.systemTokens.create(
    ctx,
    args.identity,
    { name: args.name },
  ),
});
const createSystemScopedToken = typedMutation({
  access: "system",
  args: {
    identity: dbz.identity(),
    name: dbz.string(),
    scopes: dbz.array(scopedMcp.scopes),
  },
  handler: (ctx, args) => scopedMcp.systemTokens.create(
    ctx,
    args.identity,
    { name: args.name, scopes: args.scopes },
  ),
});
const listSystemAgentTokens = typedQuery({
  access: "system",
  args: { identity: dbz.identity() },
  handler: (ctx, args) => agentMcp.systemTokens.list(ctx, args.identity),
});
const revokeSystemAgentToken = typedMutation({
  access: "system",
  args: { identity: dbz.identity(), tokenId: dbz.string() },
  handler: (ctx, args) => agentMcp.systemTokens.revoke(ctx, args.identity, args.tokenId),
});
const createdToken: string = createAgentToken._retType!.token;
const createdSystemToken: string = createSystemAgentToken._retType!.token;
const listedTokenId: string = listAgentTokens._retType![0]!.id;
const createdScope: AgentScope = createScopedToken._retType!.scopes[0]!;
const createdSystemScope: AgentScope = createSystemScopedToken._retType!.scopes[0]!;
// @ts-expect-error listing descriptors never recover the plaintext secret
void listAgentTokens._retType![0]!.token;
// @ts-expect-error system listing descriptors never recover the plaintext secret
void listSystemAgentTokens._retType![0]!.token;
// @ts-expect-error scope-free descriptors do not expose a grant
void listAgentTokens._retType![0]!.scopes;
void createdToken;
void createdSystemToken;
void listedTokenId;
void createdScope;
void createdSystemScope;
void updateAgentToken;
void revokeAgentToken;
void updateScopedToken;
void revokeSystemAgentToken;
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
    // @ts-expect-error MCP tools cannot invoke the system-administration facade
    agentMcp.systemTokens.list(ctx, 1n as Identity);
    await ctx.tx((tx) => addNote(tx, { body: args.body }));
    return { content: [{ type: "text", text: `${authKind}:${signal.aborted}` }] };
  },
});

scopedMcp.tool({
  name: "read_orders",
  description: "Read orders with either exact capability.",
  access: { anyOf: ["orders.all", "orders.get"] },
  args: {},
  handler: () => ({ content: [] }),
});

scopedMcp.tool({
  name: "read_reports",
  description: "Require both exact capabilities.",
  access: { allOf: ["orders.get", "reports.all"] },
  args: {},
  handler: () => ({ content: [] }),
});

scopedMcp.tool({
  name: "invalid_scope_policy",
  description: "Reject undeclared policy values.",
  // @ts-expect-error tool policies accept only the declaration's exact scope union
  access: { anyOf: ["orders.create"] },
  args: {},
  handler: () => ({ content: [] }),
});

scopedMcp.tool({
  name: "ambiguous_scope_policy",
  description: "Reject ambiguous bare arrays.",
  // @ts-expect-error scope policies must explicitly choose anyOf or allOf
  access: ["orders.get"],
  args: {},
  handler: () => ({ content: [] }),
});

agentMcp.tool({
  name: "scope_free_policy",
  description: "Reject scope policies when the declaration has no scopes.",
  // @ts-expect-error scope-free declarations expose only public/authenticated policies
  access: { anyOf: ["orders.get"] },
  args: {},
  handler: () => ({ content: [] }),
});

typedMutation({
  access: "authenticated",
  args: {},
  handler: (ctx) => {
    // @ts-expect-error scope-free token creation cannot accept a scope value
    agentMcp.tokens.create(ctx, { name: "invalid", scopes: [] });
    // @ts-expect-error scope-free token operations omit the scope update method
    agentMcp.tokens.updateScopes(ctx, "token", []);
    // @ts-expect-error scope-enabled token creation requires an explicit grant
    scopedMcp.tokens.create(ctx, { name: "invalid" });
    // @ts-expect-error token grants accept only exact declared values
    scopedMcp.tokens.create(ctx, { name: "invalid", scopes: ["orders.create"] });
    // @ts-expect-error owner token operations never accept a selected Identity
    agentMcp.tokens.create(ctx, 1n as Identity, { name: "escalation" });
    // @ts-expect-error descriptor edits cannot change authorization grants
    scopedMcp.tokens.update(ctx, "token", { scopes: ["orders.get"] });
    // @ts-expect-error descriptor edits expose only bounded name and metadata
    agentMcp.tokens.update(ctx, "token", { expiresAt: Date.now() });
    // @ts-expect-error descriptor edits require at least one replacement field
    agentMcp.tokens.update(ctx, "token", {});
    // @ts-expect-error plaintext secrets cannot be recovered
    agentMcp.tokens.recover(ctx, "token");
    // @ts-expect-error owner lifecycle has no built-in expiration
    agentMcp.tokens.expire(ctx, "token");
    // @ts-expect-error scope-free system token creation cannot accept a scope value
    agentMcp.systemTokens.create(ctx, 1n as Identity, { name: "invalid", scopes: [] });
    // @ts-expect-error scoped system token creation requires an explicit grant
    scopedMcp.systemTokens.create(ctx, 1n as Identity, { name: "invalid" });
    scopedMcp.systemTokens.create(ctx, 1n as Identity, {
      name: "invalid",
      // @ts-expect-error system grants accept only exact declared values
      scopes: ["orders.create"],
    });
  },
});

const richResult = {
  content: [{
    type: "text",
    text: "hello",
    annotations: { audience: ["assistant"], priority: 0.8 },
    _meta: { source: "compile-fixture" },
  }, {
    type: "image",
    data: "AQID",
    mimeType: "image/png",
  }, {
    type: "audio",
    data: "BAUG",
    mimeType: "audio/wav",
  }, {
    type: "resource",
    resource: { uri: "dbzz://notes/1", mimeType: "text/plain", text: "note" },
  }, {
    type: "resource",
    resource: {
      uri: "dbzz://notes/2",
      mimeType: "application/octet-stream",
      blob: "AQID",
    },
  }, {
    type: "resource_link",
    uri: "https://dbzz.dev/notes/1",
    name: "note-one",
    title: "Note one",
    size: 3,
    icons: [{ src: "https://dbzz.dev/note.png", sizes: ["48x48"], theme: "light" }],
  }],
  _meta: { request: { id: 1 } },
} satisfies McpToolResult;

agentMcp.tool({
  name: "render_note",
  title: "Render note",
  description: "Prove every rich result block is typed.",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  args: {},
  handler: () => richResult,
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

const echoNativeValues = agentMcp.tool({
  name: "echo_native_values",
  description: "Keep protocol strings out of the typed handler contract.",
  args: {
    count: dbz.bigint(),
    identity: dbz.identity(),
    bytes: dbz.bytes(),
  },
  output: dbz.object({
    count: dbz.bigint(),
    identity: dbz.identity(),
    bytes: dbz.bytes(),
  }),
  handler: (_ctx, args) => {
    const count: bigint = args.count;
    const identity: Identity = args.identity;
    const bytes: Uint8Array = args.bytes;
    return { count, identity, bytes };
  },
});
void echoNativeValues;

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
  name: "invalid_annotation",
  description: "Prove tool hints are booleans.",
  annotations: {
    // @ts-expect-error tool annotation hints are booleans
    readOnlyHint: "yes",
  },
  args: {},
  handler: () => ({ content: [] }),
});

agentMcp.tool({
  name: "invalid_content",
  description: "Prove content blocks are a closed union.",
  args: {},
  handler: () => ({
    content: [{
      // @ts-expect-error video is not a supported MCP content block
      type: "video",
      data: "AQID",
      mimeType: "video/mp4",
    }],
  }),
});

agentMcp.tool({
  name: "invalid_metadata",
  description: "Prove metadata is standard JSON.",
  args: {},
  handler: () => ({
    content: [],
    _meta: {
      // @ts-expect-error metadata cannot contain runtime objects
      createdAt: new Date(),
    },
  }),
});

const invalidRichMode = {
  content: [],
  // @ts-expect-error unstructured handlers cannot smuggle structured content
  structuredContent: { value: "undeclared" },
} satisfies McpToolResult;
void invalidRichMode;

const invalidAudience = {
  content: [{
    type: "text",
    text: "bad",
    annotations: {
      // @ts-expect-error content audiences are user or assistant
      audience: ["model"],
    },
  }],
} satisfies McpToolResult;
void invalidAudience;

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
