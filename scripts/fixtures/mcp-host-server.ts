import { createInterface } from "node:readline";
import {
  ACKERDB_VERSION,
  encode,
  type MutationMessage,
} from "@ackerdb/core";
import {
  v,
  defineSchema,
  Engine,
  mutation,
  procedure,
  reconcile,
  Registry,
  Runtime,
  type McpBuilder,
  type MutationBuilder,
  type ProcedureBuilder,
  type SessionRuntimeContext,
  type UserPrincipal,
} from "@ackerdb/server";
import { listen } from "ackerdb-test-support/listen";
import { mcp, mcpContent, type McpToolResult } from "@ackerdb/server";

const INSTRUCTION_MARKER = "ackerdb-host-instructions-v1";
const READ_SCOPE = "acceptance.read";
const ADMIN_SCOPE = "acceptance.admin";
const schema = defineSchema({});
const typedMutation = mutation as MutationBuilder<typeof schema>;
const typedProcedure = procedure as ProcedureBuilder<typeof schema>;
const typedMcp = mcp as McpBuilder<typeof schema, typeof READ_SCOPE | typeof ADMIN_SCOPE>;

function emit(value: Readonly<Record<string, unknown>>): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function called(name: string): void {
  emit({ type: "tool", name });
}

/**
 * Every tool function declares `access: "public"`: none of them is exported as
 * an application function, so none has a callable address, and the endpoint's
 * per-entry `access` below is the single authority deciding what a credential
 * may reach. Duplicating the policy on the function too would create a second
 * place to keep in sync with no caller that reads it.
 */
const publicText = typedProcedure({
  description: "Return the stable public host-acceptance marker.",
  access: "public",
  args: {},
  returns: mcpContent(),
  handler: (): McpToolResult => {
    called("public_text");
    return { content: [{ type: "text", text: "public:ok" }] };
  },
});

const authenticatedStatus = typedProcedure({
  description: "Return the delegated AckerDB Identity for an authenticated MCP token.",
  access: "public",
  args: {},
  returns: mcpContent(),
  handler: (ctx): McpToolResult => {
    called("authenticated_status");
    if (ctx.auth.kind !== "user" || ctx.auth.tokenId === null) {
      throw new Error("expected a credential-backed principal");
    }
    return { content: [{ type: "text", text: `authenticated:${ctx.auth.identity}` }] };
  },
});

const structuredStatus = typedProcedure({
  description: "Return one validated structured result and its canonical text fallback.",
  access: "public",
  args: { value: v.string().describe("The exact value to round-trip.") },
  returns: v.object({
    kind: v.literal("structured"),
    value: v.string(),
    identity: v.identity(),
  }),
  handler: (ctx, args) => {
    called("structured_status");
    if (ctx.auth.kind !== "user" || ctx.auth.tokenId === null) {
      throw new Error("expected a credential-backed principal");
    }
    return { kind: "structured" as const, value: args.value, identity: ctx.auth.identity };
  },
});

const richContent = typedProcedure({
  description: "Return mixed text, embedded-resource, and resource-link MCP content.",
  access: "public",
  args: {},
  returns: mcpContent(),
  handler: (): McpToolResult => {
    called("rich_content");
    return {
      content: [
        { type: "text", text: "rich:ok" },
        {
          type: "resource",
          resource: {
            uri: "ackerdb://acceptance/embedded",
            mimeType: "text/plain",
            text: "embedded:ok",
          },
        },
        {
          type: "resource_link",
          uri: "https://ackerdb.dev/acceptance",
          name: "ackerdb-host-acceptance",
          title: "AckerDB host acceptance",
          mimeType: "text/plain",
        },
      ],
      _meta: { fixture: "rich-content-v1" },
    };
  },
});

const adminOnly = typedProcedure({
  description: "Return an admin marker only when the exact admin scope is granted.",
  access: "public",
  args: {},
  returns: mcpContent(),
  handler: (): McpToolResult => {
    called("admin_only");
    return { content: [{ type: "text", text: "admin:ok" }] };
  },
});

const scopeCheckpoint = typedProcedure({
  description: "Mark the point after which the acceptance controller reduces this token's scopes.",
  access: "public",
  args: {},
  returns: mcpContent(),
  handler: (): McpToolResult => {
    called("scope_checkpoint");
    return { content: [{ type: "text", text: "scope-checkpoint:ok" }] };
  },
});

const revocationCheckpoint = typedProcedure({
  description: "Mark the point after which the acceptance controller revokes this token.",
  access: "public",
  args: {},
  returns: mcpContent(),
  handler: (): McpToolResult => {
    called("revocation_checkpoint");
    return { content: [{ type: "text", text: "revocation-checkpoint:ok" }] };
  },
});

const READ_TOOLS = [
  "authenticated_status",
  "public_text",
  "record_discovery",
  "revocation_checkpoint",
  "rich_content",
  "scope_checkpoint",
  "structured_status",
] as const;

const recordDiscovery = typedProcedure({
  description:
    "Validate the initialization instruction marker and exact currently visible MCP tool names.",
  access: "public",
  args: {
    marker: v.string(),
    tools: v.array(v.string()),
  },
  returns: v.object({ accepted: v.boolean(), count: v.int() }),
  handler: (ctx, args) => {
    if (ctx.auth.kind !== "user" || ctx.auth.tokenId === null) {
      throw new Error("expected a credential-backed principal");
    }
    const expected = ctx.auth.scopes.includes(ADMIN_SCOPE)
      ? [...READ_TOOLS, "admin_only"].sort()
      : [...READ_TOOLS];
    const received = [...new Set(args.tools)].sort();
    const accepted = args.marker === INSTRUCTION_MARKER &&
      expected.length === received.length &&
      expected.every((name, index) => name === received[index]);
    emit({ type: "discovery", accepted, count: received.length });
    return { accepted, count: received.length };
  },
});

const acceptanceMcp = typedMcp({
  name: "acceptance",
  instructions:
    `AckerDB host acceptance endpoint. When record_discovery is requested, pass marker ` +
    `${INSTRUCTION_MARKER} and the exact lower-snake-case names of the currently available ` +
    `tools. Follow the caller's requested tool order and continue after expected authorization errors.`,
  tools: {
    admin_only: { fn: adminOnly, access: { anyOf: [ADMIN_SCOPE] } },
    authenticated_status: { fn: authenticatedStatus, access: "authenticated" },
    public_text: { fn: publicText, access: "public" },
    record_discovery: { fn: recordDiscovery, access: "authenticated" },
    revocation_checkpoint: { fn: revocationCheckpoint, access: "authenticated" },
    rich_content: { fn: richContent, access: { anyOf: [READ_SCOPE] } },
    scope_checkpoint: { fn: scopeCheckpoint, access: "authenticated" },
    structured_status: { fn: structuredStatus, access: "authenticated" },
  },
});

const createToken = typedMutation({
  access: "authenticated",
  args: { name: v.string(), scopes: v.array(v.string()) },
  handler: (ctx, args) => ctx.credentials.issue({
    name: args.name,
    metadata: { fixture: "host-acceptance" },
    scopes: args.scopes,
  }),
});

const updateTokenScopes = typedMutation({
  access: "authenticated",
  args: { id: v.string(), scopes: v.array(v.string()) },
  handler: (ctx, args) => ctx.credentials.updateScopes(args.id, args.scopes),
});

const revokeToken = typedMutation({
  access: "authenticated",
  args: { id: v.string() },
  handler: (ctx, args) => ctx.credentials.revoke(args.id),
});

const modules = {
  acceptance: {
    acceptanceMcp,
  },
  tokens: { createToken, revokeToken, updateTokenScopes },
};

let messageId = 0;

function request(args: unknown, ref: string) {
  const id = ++messageId;
  const issuedAt = Date.now();
  const timestamp = issuedAt.toString(16).padStart(12, "0");
  const message: MutationMessage = {
    t: "m",
    id,
    ref,
    args,
    mutationRequestId:
      `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7000-8000-${id.toString(16).padStart(12, "0")}`,
    issuedAt,
  };
  return Object.freeze({ message, bytes: Buffer.byteLength(encode(message)) });
}

interface ControlMessage {
  readonly action: "scopes" | "revoke" | "stop" | "sync";
  readonly id?: string;
  readonly scopes?: readonly (typeof READ_SCOPE | typeof ADMIN_SCOPE)[];
}

async function main(): Promise<void> {
  const path = process.env.ACKERDB_ACCEPTANCE_DB;
  if (path === undefined || path === "") throw new Error("ACKERDB_ACCEPTANCE_DB is required");
  const engine = new Engine(schema, path);
  reconcile(engine);
  const runtime = new Runtime({
    engine,
    registry: new Registry(modules),
    scopes: [READ_SCOPE, ADMIN_SCOPE],
    resolveScopes: () => [READ_SCOPE, ADMIN_SCOPE],
  });
  await runtime.start();
  const identity = await runtime.resolveIdentity({
    issuer: "https://acceptance.ackerdb.test/",
    subject: "host-owner",
  });
  const principal: UserPrincipal = Object.freeze({
    kind: "user",
    identity,
    scopes: Object.freeze([READ_SCOPE, ADMIN_SCOPE]),
    issuer: "https://acceptance.ackerdb.test/",
    subject: "host-owner",
    claims: Object.freeze({}),
    expiresAt: Date.now() + 60 * 60 * 1_000,
    tokenId: "host-acceptance-owner",
  });
  const controller = new AbortController();
  const session: SessionRuntimeContext = Object.freeze({
    clientSessionId: "host-acceptance-owner",
    principal,
    fairnessKey: "host-acceptance-owner",
    authEpoch: 0,
    signal: controller.signal,
    publish: async () => true,
  });
  await runtime.openSession(session);

  const create = async (name: string) => (await runtime.mutation(
    session,
    request({ name, scopes: [READ_SCOPE] }, "tokens.createToken"),
  )).value as { readonly id: string; readonly token: string };
  const codex = await create("Codex acceptance");
  const claude = await create("Claude Code acceptance");
  const server = listen(runtime);

  emit({
    type: "ready",
    url: `http://127.0.0.1:${server.port}${acceptanceMcp.path}`,
    codex,
    claude,
  });

  try {
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of lines) {
      const control = JSON.parse(line) as ControlMessage;
      if (control.action === "stop") break;
      if (control.action === "sync") {
        emit({ type: "control", action: control.action });
        continue;
      }
      if (control.id === undefined) throw new Error("token control requires an id");
      if (control.action === "scopes") {
        if (control.scopes === undefined) throw new Error("scope control requires scopes");
        await runtime.mutation(
          session,
          request({ id: control.id, scopes: control.scopes }, "tokens.updateTokenScopes"),
        );
      } else {
        await runtime.mutation(
          session,
          request({ id: control.id }, "tokens.revokeToken"),
        );
      }
      emit({ type: "control", action: control.action });
    }
  } finally {
    controller.abort();
    await server.drain().catch(() => {});
    await runtime.drain().catch(() => {});
    engine.close("clean");
  }
}

await main();
