/** Compile-time contract for schema-bound MCP tools and client API erasure. */
import type { ApiFromModules } from "@dbzz/core";
import {
  createMcp,
  dbz,
  defineSchema,
  defineTable,
  mutation,
  type McpBuilder,
  type McpToolResult,
  type MutationBuilder,
  type Validator,
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
    const authKind: "anonymous" | "user" | "workload" | "system" = ctx.auth.kind;
    const signal: AbortSignal = ctx.abortSignal;
    // Tools need an explicit transaction before they can reach the database.
    // @ts-expect-error MCP tool contexts do not expose a database directly
    void ctx.db;
    await ctx.tx((tx) => addNote(tx, { body: args.body }));
    return { content: [{ type: "text", text: `${authKind}:${signal.aborted}` }] };
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
