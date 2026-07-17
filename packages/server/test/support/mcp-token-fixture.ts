import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROTOCOL_VERSION,
  encode,
  type MutationMessage,
  type QueryMessage,
  type SubscribeMessage,
} from "@dbzz/core";
import type { CredentialVerifier, UserPrincipal } from "../../src/auth.ts";
import { callerFairnessKey } from "../../src/caller.ts";
import { dbz } from "../../src/dbz.ts";
import { Engine } from "../../src/engine.ts";
import {
  mutation,
  procedure,
  query,
  type MutationBuilder,
  type MutationCtx,
  type ProcedureBuilder,
  type QueryBuilder,
} from "../../src/functions.ts";
import { PRODUCTION_LIMITS, type ServiceLimits } from "../../src/limits.ts";
import { createMcp, type McpBuilder } from "../../src/mcp.ts";
import { reconcile } from "../../src/reconcile.ts";
import { Registry } from "../../src/registry.ts";
import { Runtime, type RuntimeOptions } from "../../src/runtime.ts";
import { defineSchema, defineTable } from "../../src/schema.ts";
import type {
  RuntimePublication,
  RuntimeRequest,
  SessionApplicationMessage,
  SessionRuntimeContext,
} from "../../src/session.ts";

const schema = defineSchema({
  records: defineTable({
    id: dbz.primaryKey(),
    owner: dbz.identity(),
    value: dbz.string(),
  }),
});

export const typedMutation = mutation as MutationBuilder<typeof schema>;
export const typedQuery = query as QueryBuilder<typeof schema>;
const typedProcedure = procedure as ProcedureBuilder<typeof schema>;
export const typedMcp = createMcp as McpBuilder<typeof schema>;
const invalidUpdateKind = dbz.enum("InvalidMcpTokenUpdateKind", ["empty", "undefined"]);

export const agentMcp = typedMcp({ name: "agent", path: "/agent/mcp" });
const operationsMcp = typedMcp({ name: "operations", path: "/operations/mcp" });
export const scopedMcp = typedMcp({
  name: "scoped",
  path: "/scoped/mcp",
  scopes: ["orders.all", "orders.get", "reports.all"] as const,
});
let escapedOwnerContext: MutationCtx<typeof schema> | null = null;

const createAgentToken = typedMutation({
  access: "authenticated",
  args: {
    name: dbz.string(),
    metadata: dbz.jsonb<Readonly<Record<string, unknown>>>(),
  },
  handler: (ctx, args) => {
    escapedOwnerContext = ctx;
    return agentMcp.tokens.create(ctx, args);
  },
});

const listAgentTokens = typedQuery({
  access: "authenticated",
  args: {},
  handler: (ctx) => agentMcp.tokens.list(ctx),
});

const renameAgentToken = typedMutation({
  access: "authenticated",
  args: { id: dbz.string(), name: dbz.string() },
  handler: (ctx, args) => agentMcp.tokens.update(ctx, args.id, { name: args.name }),
});

const updateAgentTokenMetadata = typedMutation({
  access: "authenticated",
  args: {
    id: dbz.string(),
    metadata: dbz.jsonb<Readonly<Record<string, unknown>>>(),
  },
  handler: (ctx, args) => agentMcp.tokens.update(ctx, args.id, { metadata: args.metadata }),
});

const invalidAgentTokenUpdate = typedMutation({
  access: "authenticated",
  args: { id: dbz.string(), kind: invalidUpdateKind },
  handler: (ctx, args) => agentMcp.tokens.update(
    ctx,
    args.id,
    (args.kind === "empty" ? {} : { name: undefined }) as never,
  ),
});

const revokeAgentToken = typedMutation({
  access: "authenticated",
  args: { id: dbz.string() },
  handler: (ctx, args) => agentMcp.tokens.revoke(ctx, args.id),
});

const renameOperationsToken = typedMutation({
  access: "authenticated",
  args: { id: dbz.string(), name: dbz.string() },
  handler: (ctx, args) => operationsMcp.tokens.update(ctx, args.id, { name: args.name }),
});

const revokeOperationsToken = typedMutation({
  access: "authenticated",
  args: { id: dbz.string() },
  handler: (ctx, args) => operationsMcp.tokens.revoke(ctx, args.id),
});

const listOperationsTokens = typedQuery({
  access: "authenticated",
  args: {},
  handler: (ctx) => operationsMcp.tokens.list(ctx),
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
    id: dbz.string(),
    scopes: dbz.array(scopedMcp.scopes),
  },
  handler: (ctx, args) => scopedMcp.tokens.updateScopes(ctx, args.id, args.scopes),
});

const listScopedTokens = typedQuery({
  access: "authenticated",
  args: {},
  handler: (ctx) => scopedMcp.tokens.list(ctx),
});

const normalProcedure = typedProcedure({
  access: "authenticated",
  args: {},
  handler: (ctx) => ctx.auth.kind,
});

const writeOwnedRecord = agentMcp.tool({
  name: "write_owned_record",
  description: "Write a row owned by the delegated Identity.",
  access: "authenticated",
  args: { value: dbz.string() },
  handler: async (ctx, args) => {
    if (ctx.auth.kind !== "mcp") throw new Error("expected MCP principal");
    const identity = ctx.auth.identity;
    const id = await ctx.tx((tx) => tx.db.records.insert({ owner: identity, value: args.value }));
    return {
      content: [
        { type: "text", text: `${ctx.auth.kind}:${identity}` },
        {
          type: "resource_link",
          uri: `dbzz://records/${id}`,
          name: `record-${id}`,
          annotations: { audience: ["assistant"], priority: 0.8 },
          _meta: { owner: identity.toString() },
        },
      ],
      _meta: { tokenId: ctx.auth.tokenId },
    };
  },
});

const attemptSelfAdministration = agentMcp.tool({
  name: "attempt_self_administration",
  description: "Exercise the delegated-credential administration boundary.",
  access: "authenticated",
  args: {},
  handler: async (ctx) => ctx.tx((tx) => {
    agentMcp.tokens.list(tx);
    agentMcp.tokens.create(tx, { name: "escalated", metadata: {} });
    return { content: [{ type: "text", text: "unexpected" }] };
  }),
});

const publicScopedTool = scopedMcp.tool({
  name: "public_status",
  description: "Public scope fixture.",
  access: "public",
  args: {},
  handler: () => ({ content: [{ type: "text", text: "public" }] }),
});

const authenticatedScopedTool = scopedMcp.tool({
  name: "authenticated_status",
  description: "Authenticated scope fixture.",
  access: "authenticated",
  args: {},
  handler: () => ({ content: [{ type: "text", text: "authenticated" }] }),
});

const anyScopedTool = scopedMcp.tool({
  name: "read_orders",
  description: "Any-of scope fixture.",
  access: { anyOf: ["orders.all", "orders.get"] },
  args: {},
  handler: () => ({ content: [{ type: "text", text: "orders" }] }),
});

const allScopedTool = scopedMcp.tool({
  name: "read_reports",
  description: "All-of scope fixture.",
  access: { allOf: ["orders.get", "reports.all"] },
  args: {},
  handler: () => ({ content: [{ type: "text", text: "reports" }] }),
});

const exactAllTool = scopedMcp.tool({
  name: "admin_orders",
  description: "Prove .all is an opaque exact value.",
  access: { anyOf: ["orders.all"] },
  args: {},
  handler: () => ({ content: [{ type: "text", text: "admin" }] }),
});

const modules = {
  mcp: { agentMcp, operationsMcp, scopedMcp },
  records: {
    allScopedTool,
    anyScopedTool,
    authenticatedScopedTool,
    exactAllTool,
    publicScopedTool,
    writeOwnedRecord,
  },
  security: { attemptSelfAdministration, normalProcedure },
  tokens: {
    createAgentToken,
    createScopedToken,
    invalidAgentTokenUpdate,
    listAgentTokens,
    listOperationsTokens,
    listScopedTokens,
    renameAgentToken,
    renameOperationsToken,
    revokeAgentToken,
    revokeOperationsToken,
    updateAgentTokenMetadata,
    updateScopedToken,
  },
};

const directories: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

export interface McpTokenFixture {
  readonly engine: Engine;
  readonly runtime: Runtime;
  close(): Promise<void>;
}

export interface McpTokenFixtureOptions {
  readonly limits?: ServiceLimits;
  readonly telemetry?: RuntimeOptions["telemetry"];
}

export function databasePath(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return join(directory, "data.db");
}

export function fixture(
  path: string,
  verifier?: CredentialVerifier,
  extraModules: Record<string, Record<string, unknown>> = {},
  options: McpTokenFixtureOptions = {},
): McpTokenFixture {
  const engine = new Engine(schema, path);
  reconcile(engine);
  const runtime = new Runtime({
    engine,
    registry: new Registry({ ...modules, ...extraModules }),
    verifier,
    telemetry: options.telemetry ?? false,
    limits: options.limits ?? {
      ...PRODUCTION_LIMITS,
      mcp: { ...PRODUCTION_LIMITS.mcp, maxTokensPerIdentity: 2 },
    },
  });
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await runtime.drain().catch(() => {});
    engine.close("clean");
  };
  cleanups.push(close);
  return { engine, runtime, close };
}

export function trackCleanup(cleanup: () => Promise<void>): void {
  cleanups.push(cleanup);
}

export async function cleanupMcpTokenFixtures(): Promise<void> {
  escapedOwnerContext = null;
  while (cleanups.length > 0) await cleanups.pop()!().catch(() => {});
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
}

export function retainedOwnerContext(): MutationCtx<typeof schema> | null {
  return escapedOwnerContext;
}

export async function user(runtime: Runtime, subject: string): Promise<UserPrincipal> {
  const identity = await runtime.resolveIdentity({ issuer: "https://issuer.test/", subject });
  return Object.freeze({
    kind: "user",
    identity,
    issuer: "https://issuer.test/",
    subject,
    claims: Object.freeze({}),
    expiresAt: Date.now() + 60_000,
    tokenId: `external-${subject}`,
  });
}

export function session(
  principal: UserPrincipal,
  name: string,
  publications?: SessionApplicationMessage[],
): SessionRuntimeContext {
  return Object.freeze({
    clientSessionId: name,
    principal,
    fairnessKey: callerFairnessKey(principal, { family: "test", address: name }),
    authEpoch: 0,
    signal: new AbortController().signal,
    publish: async (publication: RuntimePublication) => {
      publications?.push(publication.message);
      return true;
    },
  });
}

export function request<Message>(message: Message): RuntimeRequest<Message> {
  return Object.freeze({ message, bytes: Buffer.byteLength(encode(message)) });
}

export function mutationMessage(
  id: number,
  requestId: string,
  args: unknown,
  ref = "tokens.createAgentToken",
): MutationMessage {
  const timestamp = Date.now().toString(16).padStart(12, "0");
  return {
    v: PROTOCOL_VERSION,
    t: "m",
    id,
    ref,
    args,
    mutationRequestId: `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7000-8000-${requestId.padStart(12, "0")}`,
    issuedAt: Date.now(),
  };
}

export function queryMessage(id: number, ref = "tokens.listAgentTokens"): QueryMessage {
  return { v: PROTOCOL_VERSION, t: "q", id, ref, args: {} };
}

export function subscribeMessage(id: number, ref = "tokens.listAgentTokens"): SubscribeMessage {
  return { v: PROTOCOL_VERSION, t: "sub", id, ref, args: {} };
}
