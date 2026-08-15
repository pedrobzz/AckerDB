/** Compile-time contract for schema-bound MCP tools and client API erasure. */
import type { Identity } from "@ackerdb/core";
import {
  credentials,
  mcp as mcpDeclaration,
  systemCredentials,
  v,
  defineApp,
  defineSchema,
  defineTable,
  mutation,
  procedure,
  query,
  type AppScope,
  type McpBuilder,
  type MutationBuilder,
  type ProcedureBuilder,
  type QueryBuilder,
  type Validator,
} from "@ackerdb/server";

const schema = defineSchema({
  notes: defineTable({
    id: v.primaryKey(),
    body: v.string(),
  }),
});

const app = defineApp({
  schema,
  scopes: ["orders.all", "orders.get", "reports.all"] as const,
});

/** The typed vocabulary codegen binds into the builders. */
type Scope = AppScope<typeof app>;
const exactScope: Scope = "orders.get";
void exactScope;
// @ts-expect-error the vocabulary exposes only the declaration's literal union
const unknownScope: Scope = "orders.create";
void unknownScope;

const scopelessApp = defineApp({ schema });
// @ts-expect-error an app without a vocabulary has no scope union
const noScope: AppScope<typeof scopelessApp> = "orders.get";
void noScope;

const typedMutation = mutation as MutationBuilder<typeof schema, object, object, Scope>;
const typedProcedure = procedure as ProcedureBuilder<typeof schema, object, object, object, object, Scope>;
const typedQuery = query as QueryBuilder<typeof schema, object, object, Scope>;
const typedMcp = mcpDeclaration as McpBuilder<typeof schema, Scope>;

const addNote = typedMutation({
  access: "public",
  args: { body: v.string() },
  handler: (ctx, args) => ctx.db.notes.insert(args),
});

const agentMcp = typedMcp({ name: "agent", tools: {} });
void agentMcp;

const createAgentToken = typedMutation({
  access: "authenticated",
  args: { name: v.string() },
  handler: (ctx, args) => credentials.create(ctx, { name: args.name }),
});
const createScopedToken = typedMutation({
  access: "authenticated",
  args: {
    name: v.string(),
    scopes: v.array(v.string()),
  },
  handler: (ctx, args) => credentials.create(ctx, args),
});
const updateScopedToken = typedMutation({
  access: "authenticated",
  args: {
    tokenId: v.string(),
    scopes: v.array(v.string()),
  },
  handler: (ctx, args) => credentials.updateScopes(ctx, args.tokenId, args.scopes),
});
const listAgentTokens = typedQuery({
  access: "authenticated",
  args: {},
  handler: (ctx) => credentials.list(ctx),
});
const updateAgentToken = typedMutation({
  access: "authenticated",
  args: { tokenId: v.string(), name: v.string() },
  handler: (ctx, args) => credentials.update(ctx, args.tokenId, { name: args.name }),
});
const revokeAgentToken = typedMutation({
  access: "authenticated",
  args: { tokenId: v.string() },
  handler: (ctx, args) => credentials.revoke(ctx, args.tokenId),
});
const createSystemAgentToken = typedMutation({
  access: "system",
  args: { identity: v.identity(), name: v.string() },
  handler: (ctx, args) => systemCredentials.create(
    ctx,
    args.identity,
    { name: args.name },
  ),
});
/** Standalone identities: no parent, scopes granted directly. */
const createStandaloneToken = typedMutation({
  access: "system",
  args: { name: v.string(), scopes: v.array(v.string()) },
  handler: (ctx, args) => systemCredentials.create(ctx, null, args),
});
const listSystemAgentTokens = typedQuery({
  access: "system",
  args: { identity: v.identity() },
  handler: (ctx, args) => systemCredentials.list(ctx, args.identity),
});
const revokeSystemAgentToken = typedMutation({
  access: "system",
  args: { identity: v.identity(), tokenId: v.string() },
  handler: (ctx, args) => systemCredentials.revoke(ctx, args.identity, args.tokenId),
});
const localAiTools = typedProcedure({
  access: "authenticated",
  args: {},
  handler: (ctx) => {
    agentMcp.aiTools(ctx);
    agentMcp.aiTools(ctx, {
      scopes: ["orders.get", "reports.all"],
      includeUnavailable: true,
    });
    agentMcp.aiTools(ctx, { includeUnavailable: true });
    // @ts-expect-error local grants accept only the declared scope union
    agentMcp.aiTools(ctx, { scopes: ["orders.create"] });
    // @ts-expect-error Identity is inherited from ctx.auth and cannot be supplied
    agentMcp.aiTools(ctx, { scopes: ["orders.get"], identity: 1n as Identity });
    // @ts-expect-error includeUnavailable is an explicit boolean mode
    agentMcp.aiTools(ctx, { includeUnavailable: "yes" });
  },
});
const createdToken: string = createAgentToken._retType!.data.token;
const createdIdentity: Identity = createAgentToken._retType!.data.identity;
const createdSystemToken: string = createSystemAgentToken._retType!.data.token;
const createdStandaloneToken: string = createStandaloneToken._retType!.data.token;
const listedTokenId: string = listAgentTokens._retType!.data[0]!.id;
const createdScope: string = createScopedToken._retType!.data.scopes[0]!;
// @ts-expect-error listing descriptors never recover the plaintext secret
void listAgentTokens._retType!.data[0]!.token;
// @ts-expect-error system listing descriptors never recover the plaintext secret
void listSystemAgentTokens._retType!.data[0]!.token;
void createdToken;
void createdIdentity;
void createdSystemToken;
void createdStandaloneToken;
void listedTokenId;
void createdScope;
void updateAgentToken;
void revokeAgentToken;
void updateScopedToken;
void revokeSystemAgentToken;
void localAiTools;
const renamedEndpoint = typedMcp({
  name: "stable_name",
  path: "/renamed/export",
  instructions: "Stable declaration identity is explicit.",
  tools: {},
});
const stableName: "stable_name" = renamedEndpoint.name;
const stablePath: "/renamed/export" = renamedEndpoint.path;
void stableName;
void stablePath;
const writeNote = typedProcedure({
  description: "Write a note.",
  access: "authenticated",
  args: { body: v.string() },
  returns: v.object({ status: v.string() }),
  handler: async (ctx, args) => {
    const authKind: "anonymous" | "user" | "workload" | "system" = ctx.auth.kind;
    const signal: AbortSignal = ctx.abortSignal;
    // A procedure needs an explicit transaction before it can reach the database.
    // @ts-expect-error procedure contexts do not expose a database directly
    void ctx.db;
    // @ts-expect-error credential administration requires a mutation or transaction context
    credentials.list(ctx);
    // @ts-expect-error credential minting requires an application mutation or transaction context
    credentials.create(ctx, { name: "forbidden" });
    // @ts-expect-error tools cannot invoke the system-administration facade
    systemCredentials.list(ctx, 1n as Identity);
    const nestedTools = agentMcp.aiTools(ctx);
    void nestedTools;
    await ctx.tx((tx) => addNote(tx, { body: args.body }));
    return { status: `${authKind}:${signal.aborted}` };
  },
});

const orderProbe = typedQuery({
  description: "Scope-policy probe.",
  access: "authenticated",
  args: {},
  returns: v.object({}),
  handler: () => ({}),
});

typedMcp({
  name: "valid_scoped_tools",
  path: "/valid/scoped-tools",
  tools: {
    any_of_policy: { fn: orderProbe, access: { anyOf: ["orders.all", "orders.get"] } },
    all_of_policy: { fn: orderProbe, access: { allOf: ["orders.get", "reports.all"] } },
  },
});

typedMcp({
  name: "invalid_scoped_tools",
  path: "/invalid/scoped-tools",
  tools: {
    // @ts-expect-error entry policies accept only the declared scope union
    invalid_scope_policy: { fn: orderProbe, access: { anyOf: ["orders.create"] } },
  },
});

typedMcp({
  name: "ambiguous_policy",
  path: "/invalid/ambiguous",
  tools: {
    // @ts-expect-error scope policies must explicitly choose anyOf or allOf
    ambiguous: { fn: orderProbe, access: ["orders.get"] },
  },
});

/** An app that declares no vocabulary cannot spell a scoped entry policy. */
const scopeFreeMcp = mcpDeclaration as McpBuilder<typeof schema, AppScope<typeof scopelessApp>>;
scopeFreeMcp({
  name: "invalid_scope_free_tools",
  path: "/invalid/scope-free-tools",
  tools: {
    // @ts-expect-error a vocabulary-free app cannot carry a scoped entry policy
    scope_free_policy: { fn: orderProbe, access: { anyOf: ["orders.get"] } },
  },
});

typedMutation({
  access: "authenticated",
  args: {},
  handler: (ctx) => {
    // @ts-expect-error owner credential operations never accept a selected Identity
    credentials.create(ctx, 1n as Identity, { name: "escalation" });
    // @ts-expect-error descriptor edits cannot change authorization grants
    credentials.update(ctx, "token", { scopes: ["orders.get"] });
    // @ts-expect-error descriptor edits expose only bounded name and metadata
    credentials.update(ctx, "token", { expiresAt: Date.now() });
    // @ts-expect-error descriptor edits require at least one replacement field
    credentials.update(ctx, "token", {});
    // @ts-expect-error plaintext secrets cannot be recovered
    credentials.recover(ctx, "token");
    // @ts-expect-error owner lifecycle has no built-in expiration
    credentials.expire(ctx, "token");
    // @ts-expect-error system creation requires an explicit parent Identity or null
    systemCredentials.create(ctx, { name: "invalid" });
  },
});

const summarizeNote = typedQuery({
  description: "Return a typed summary.",
  access: "authenticated",
  args: {
    body: v.string().describe("The note body."),
    label: v.string().optional(),
  },
  returns: v.object({
    length: v.int(),
    label: v.string().nullable(),
  }),
  handler: (_ctx, args) => {
    const body: string = args.body;
    const label: string | undefined = args.label;
    return { length: body.length, label: label ?? null };
  },
});
void summarizeNote;

const echoNativeValues = typedQuery({
  description: "Keep protocol strings out of the typed handler contract.",
  access: "authenticated",
  args: {
    count: v.bigint(),
    identity: v.identity(),
    bytes: v.bytes(),
  },
  returns: v.object({
    count: v.bigint(),
    identity: v.identity(),
    bytes: v.bytes(),
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
const summaryInput = v.object({
  body: v.string(),
  label: v.string().nullable(),
});
const validStandardInput: StandardInput<typeof summaryInput> = { body: "hello", label: null };
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

// @ts-expect-error declarations require an explicit stable name
typedMcp();

typedQuery({
  description: "Prove input roots are objects.",
  access: "public",
  // @ts-expect-error arguments are shapes, never scalar roots
  args: v.string(),
  returns: v.object({}),
  handler: () => ({}),
});

typedMcp({
  name: "annotation_hints",
  path: "/annotations",
  tools: {
    hinted: {
      fn: summarizeNote,
      annotations: {
        // @ts-expect-error tool annotation hints are booleans
        readOnlyHint: "yes",
      },
    },
  },
});

// A runtime-only validator has no JSON Schema, so it cannot cross either
// published surface. That is a registration error naming the tool, not a
// compile error, exactly as it is for `http: true`.
void runtimeOnlyValidator;
