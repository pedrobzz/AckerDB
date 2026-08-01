import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROTOCOL_VERSION,
  encode,
  type MutationMessage,
  type QueryMessage,
  type SubscribeMessage,
} from "@ackerdb/core";
import type { CredentialVerifier, UserPrincipal } from "../../src/auth/credentials.ts";
import { callerFairnessKey } from "../../src/runtime/caller.ts";
import { v } from "../../src/validation/v.ts";
import { Engine } from "../../src/database/engine.ts";
import {
  mutation,
  procedure,
  query,
  type MutationBuilder,
  type MutationCtx,
  type ProcedureBuilder,
  type QueryBuilder,
} from "../../src/app/functions.ts";
import { PRODUCTION_LIMITS, type ServiceLimits } from "../../src/runtime/limits.ts";
import {
  mcp as mcpDeclaration,
  mcpAuth,
  type McpAuthBuilder,
  type McpBuilder,
} from "../../src/mcp/index.ts";
import { reconcile } from "../../src/schema/reconcile.ts";
import { Registry } from "../../src/app/registry.ts";
import { Runtime, type RuntimeOptions } from "../../src/runtime/runtime.ts";
import { defineSchema, defineTable } from "../../src/schema/definition.ts";
import type {
  RuntimePublication,
  RuntimeRequest,
  SessionApplicationMessage,
  SessionRuntimeContext,
} from "../../src/subscriptions/session.ts";

const schema = defineSchema({
  records: defineTable({
    id: v.primaryKey(),
    owner: v.identity(),
    value: v.string(),
  }),
});

export const typedMutation = mutation as MutationBuilder<typeof schema>;
export const typedQuery = query as QueryBuilder<typeof schema>;
export const typedProcedure = procedure as ProcedureBuilder<typeof schema>;
export const typedMcp = mcpDeclaration as McpBuilder<typeof schema>;
export const typedMcpAuth = mcpAuth as McpAuthBuilder<typeof schema>;

export const agentAuth = typedMcpAuth({ name: "agent" });
export const operationsAuth = typedMcpAuth({ name: "operations" });
export const scopedAuth = typedMcpAuth({
  name: "scoped",
  scopes: ["orders.all", "orders.get", "reports.all"] as const,
});
const invalidUpdateKind = v.enum("InvalidMcpTokenUpdateKind", ["empty", "undefined"]);

const writeOwnedRecord = typedProcedure({
  description: "Write a row owned by the delegated Identity.",
  access: "authenticated",
  args: { value: v.string() },
  returns: v.object({ principal: v.string(), record: v.string(), tokenId: v.string() }),
  handler: async (ctx, args) => {
    if (ctx.auth.kind !== "mcp") throw new Error("expected MCP principal");
    const identity = ctx.auth.identity;
    const inserted = await ctx.tx((tx) =>
      tx.db.records.insert({ owner: identity, value: args.value }));
    if (!inserted.ok) throw new Error("insert failed");
    return {
      principal: `${ctx.auth.kind}:${identity}`,
      record: `ackerdb://records/${inserted.data}`,
      tokenId: ctx.auth.tokenId,
    };
  },
});

const attemptSelfAdministration = typedProcedure({
  description: "Exercise the delegated-credential administration boundary.",
  access: "authenticated",
  args: {},
  returns: v.object({ status: v.string() }),
  handler: async (ctx) => {
    const done = await ctx.tx((tx) => {
      agentAuth.tokens.list(tx);
      agentAuth.tokens.create(tx, { name: "escalated", metadata: {} });
      return { status: "unexpected" };
    });
    if (!done.ok) throw new Error("administration unexpectedly failed");
    return done.data;
  },
});

const statusReturns = v.object({ status: v.string() });

const publicScopedTool = typedQuery({
  description: "Public scope fixture.",
  access: "public",
  args: {},
  returns: statusReturns,
  handler: () => ({ status: "public" }),
});

const authenticatedScopedTool = typedQuery({
  description: "Authenticated scope fixture.",
  access: "authenticated",
  args: {},
  returns: statusReturns,
  handler: () => ({ status: "authenticated" }),
});

const anyScopedTool = typedQuery({
  description: "Any-of scope fixture.",
  access: "authenticated",
  args: {},
  returns: statusReturns,
  handler: () => ({ status: "orders" }),
});

const allScopedTool = typedQuery({
  description: "All-of scope fixture.",
  access: "authenticated",
  args: {},
  returns: statusReturns,
  handler: () => ({ status: "reports" }),
});

const exactAllTool = typedQuery({
  description: "Prove .all is an opaque exact value.",
  access: "authenticated",
  args: {},
  returns: statusReturns,
  handler: () => ({ status: "admin" }),
});

export const agentMcp = typedMcp({
  name: "agent",
  auth: agentAuth,
  path: "/agent/mcp",
  tools: {
    attempt_self_administration: { fn: attemptSelfAdministration },
    write_owned_record: { fn: writeOwnedRecord },
  },
});
const operationsMcp = typedMcp({
  name: "operations",
  auth: operationsAuth,
  path: "/operations/mcp",
  tools: {},
});
export const scopedMcp = typedMcp({
  name: "scoped",
  auth: scopedAuth,
  path: "/scoped/mcp",
  tools: {
    admin_orders: { fn: exactAllTool, access: { anyOf: ["orders.all"] } },
    authenticated_status: { fn: authenticatedScopedTool, access: "authenticated" },
    public_status: { fn: publicScopedTool, access: "public" },
    read_orders: { fn: anyScopedTool, access: { anyOf: ["orders.all", "orders.get"] } },
    read_reports: { fn: allScopedTool, access: { allOf: ["orders.get", "reports.all"] } },
  },
});
let escapedOwnerContext: MutationCtx<typeof schema> | null = null;

const createAgentToken = typedMutation({
  access: "authenticated",
  args: {
    name: v.string(),
    metadata: v.jsonb<Readonly<Record<string, unknown>>>(),
  },
  handler: (ctx, args) => {
    escapedOwnerContext = ctx;
    return agentAuth.tokens.create(ctx, args);
  },
});

const listAgentTokens = typedQuery({
  access: "authenticated",
  args: {},
  handler: (ctx) => agentAuth.tokens.list(ctx),
});

const renameAgentToken = typedMutation({
  access: "authenticated",
  args: { id: v.string(), name: v.string() },
  handler: (ctx, args) => agentAuth.tokens.update(ctx, args.id, { name: args.name }),
});

const updateAgentTokenMetadata = typedMutation({
  access: "authenticated",
  args: {
    id: v.string(),
    metadata: v.jsonb<Readonly<Record<string, unknown>>>(),
  },
  handler: (ctx, args) => agentAuth.tokens.update(ctx, args.id, { metadata: args.metadata }),
});

const invalidAgentTokenUpdate = typedMutation({
  access: "authenticated",
  args: { id: v.string(), kind: invalidUpdateKind },
  handler: (ctx, args) => agentAuth.tokens.update(
    ctx,
    args.id,
    (args.kind === "empty" ? {} : { name: undefined }) as never,
  ),
});

const revokeAgentToken = typedMutation({
  access: "authenticated",
  args: { id: v.string() },
  handler: (ctx, args) => agentAuth.tokens.revoke(ctx, args.id),
});

const renameOperationsToken = typedMutation({
  access: "authenticated",
  args: { id: v.string(), name: v.string() },
  handler: (ctx, args) => operationsAuth.tokens.update(ctx, args.id, { name: args.name }),
});

const revokeOperationsToken = typedMutation({
  access: "authenticated",
  args: { id: v.string() },
  handler: (ctx, args) => operationsAuth.tokens.revoke(ctx, args.id),
});

const listOperationsTokens = typedQuery({
  access: "authenticated",
  args: {},
  handler: (ctx) => operationsAuth.tokens.list(ctx),
});

const createScopedToken = typedMutation({
  access: "authenticated",
  args: {
    name: v.string(),
    scopes: v.array(scopedAuth.scopes),
  },
  handler: (ctx, args) => scopedAuth.tokens.create(ctx, args),
});

const updateScopedToken = typedMutation({
  access: "authenticated",
  args: {
    id: v.string(),
    scopes: v.array(scopedAuth.scopes),
  },
  handler: (ctx, args) => scopedAuth.tokens.updateScopes(ctx, args.id, args.scopes),
});

const listScopedTokens = typedQuery({
  access: "authenticated",
  args: {},
  handler: (ctx) => scopedAuth.tokens.list(ctx),
});

const normalProcedure = typedProcedure({
  access: "authenticated",
  args: {},
  handler: (ctx) => ctx.auth.kind,
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
  readonly now?: RuntimeOptions["now"];
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
    ...(options.now === undefined ? {} : { now: options.now }),
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
