import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Err,
  Status,
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
  type ProcedureBuilder,
  type QueryBuilder,
} from "../../src/app/functions.ts";
import { PRODUCTION_LIMITS, type ServiceLimits } from "../../src/runtime/limits.ts";
import { reconcile } from "../../src/schema/reconcile.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import type { RuntimeOptions } from "../../src/runtime/contracts/options.ts";
import { defineSchema, defineTable } from "../../src/schema/definition.ts";
import { AckerDBServer } from "../../src/transport/server.ts";
import { testDefinitions, testRegistry } from "ackerdb-test-support/server";
import type {
  RuntimePublication,
  RuntimeRequest,
  SessionApplicationMessage,
  SessionRuntimeContext,
} from "../../src/subscriptions/session/contract.ts";

const schema = defineSchema({
  records: defineTable({
    id: v.primaryKey(),
    owner: v.identity(),
    value: v.string(),
  }),
});

/** The application scope vocabulary every fixture credential draws from. */
export const FIXTURE_SCOPES = ["orders.all", "orders.get", "reports.all"] as const;

export const typedMutation = mutation as MutationBuilder<typeof schema>;
export const typedQuery = query as QueryBuilder<typeof schema>;
export const typedProcedure = procedure as ProcedureBuilder<typeof schema>;

const invalidUpdateKind = v.enum("InvalidCredentialUpdateKind", ["empty", "undefined"]);

const writeOwnedRecord = typedProcedure({
  description: "Write a row owned by the delegated Identity.",
  access: "authenticated",
  http: true,
  args: { value: v.string() },
  returns: v.object({ principal: v.string(), record: v.string(), tokenId: v.string() }),
  handler: async (ctx, args) => {
    if (ctx.auth.kind !== "user") throw new Error("expected a first-class user principal");
    const identity = ctx.auth.identity;
    const tokenId = ctx.auth.tokenId;
    if (tokenId === null) throw new Error("expected a credential-backed principal");
    const inserted = await ctx.tx((tx) =>
      tx.db.records.insert({ owner: identity, value: args.value }));
    if (!inserted.ok) throw new Error("insert failed");
    return {
      principal: `${ctx.auth.kind}:${identity}`,
      record: `ackerdb://records/${inserted.data}`,
      tokenId,
    };
  },
});

const attemptSelfAdministration = typedProcedure({
  description: "Exercise the delegated-credential administration boundary.",
  access: "authenticated",
  http: true,
  args: {},
  returns: v.object({ status: v.string() }),
  handler: async (ctx) => {
    const done = await ctx.tx(async (tx) => {
      await tx.credentials.query().collect();
      // Chained delegation: an agent may mint a sub-credential, but only a
      // subset of its own grant — over-delegation is a typed error.
      await tx.credentials.issue({ name: "escalated", scopes: ["orders.all"] });
      return { status: "over-delegated" };
    });
    if (!done.ok) throw new Error("administration unexpectedly failed");
    return done.data;
  },
});

const statusReturns = v.object({ status: v.string() });

const publicScopedTool = typedQuery({
  description: "Public scope fixture.",
  access: "public",
  http: true,
  args: {},
  returns: statusReturns,
  handler: () => ({ status: "public" }),
});

const authenticatedScopedTool = typedQuery({
  description: "Authenticated scope fixture.",
  access: "authenticated",
  http: true,
  args: {},
  returns: statusReturns,
  handler: () => ({ status: "authenticated" }),
});

const anyScopedTool = typedQuery({
  description: "Any-of scope fixture.",
  access: "authenticated",
  scopes: { anyOf: ["orders.all", "orders.get"] },
  http: true,
  args: {},
  returns: statusReturns,
  handler: () => ({ status: "orders" }),
});

const allScopedTool = typedQuery({
  description: "All-of scope fixture.",
  access: "authenticated",
  scopes: { allOf: ["orders.get", "reports.all"] },
  http: true,
  args: {},
  returns: statusReturns,
  handler: () => ({ status: "reports" }),
});

const exactAllTool = typedQuery({
  description: "Prove .all is an opaque exact value.",
  access: "authenticated",
  scopes: { anyOf: ["orders.all"] },
  http: true,
  args: {},
  returns: statusReturns,
  handler: () => ({ status: "admin" }),
});

const createAgentToken = typedMutation({
  access: "authenticated",
  args: {
    name: v.string(),
    metadata: v.jsonb<Readonly<Record<string, unknown>>>(),
  },
  handler: (ctx, args) => ctx.credentials.issue(args),
});

const listAgentTokens = typedQuery({
  access: "authenticated",
  args: {},
  handler: (ctx) => ctx.credentials.query().collect(),
});

const renameAgentToken = typedMutation({
  access: "authenticated",
  args: { id: v.string(), name: v.string() },
  handler: (ctx, args) => ctx.credentials.update(args.id, { name: args.name }),
});

const updateAgentTokenMetadata = typedMutation({
  access: "authenticated",
  args: {
    id: v.string(),
    metadata: v.jsonb<Readonly<Record<string, unknown>>>(),
  },
  handler: (ctx, args) => ctx.credentials.update(args.id, { metadata: args.metadata }),
});

const invalidAgentTokenUpdate = typedMutation({
  access: "authenticated",
  args: { id: v.string(), kind: invalidUpdateKind },
  handler: (ctx, args) => ctx.credentials.update(
    args.id,
    (args.kind === "empty" ? {} : { name: undefined }) as never,
  ),
});

const revokeAgentToken = typedMutation({
  access: "authenticated",
  args: { id: v.string() },
  handler: (ctx, args) => ctx.credentials.revoke(args.id),
});

/** Revoke inside a nested scope that then rolls back, and report that it did. */
const revokeThenRollback = typedProcedure({
  description: "Revoke a credential in a nested scope that rolls back.",
  access: "authenticated",
  args: { id: v.string() },
  returns: v.object({ rolledBack: v.boolean() }),
  handler: async (ctx, args) => {
    const attempt = await ctx.tx(async (tx) => {
      await tx.credentials.revoke(args.id);
      return Err("rolled-back", {}, Status.Conflict);
    });
    return { rolledBack: !attempt.ok };
  },
});

const createScopedToken = typedMutation({
  access: "authenticated",
  args: {
    name: v.string(),
    scopes: v.array(v.string()),
  },
  handler: (ctx, args) => ctx.credentials.issue(args),
});

const updateScopedToken = typedMutation({
  access: "authenticated",
  args: {
    id: v.string(),
    scopes: v.array(v.string()),
  },
  handler: (ctx, args) => ctx.credentials.updateScopes(args.id, args.scopes),
});

const listScopedTokens = typedQuery({
  access: "authenticated",
  args: {},
  handler: (ctx) => ctx.credentials.query().collect(),
});

const normalProcedure = typedProcedure({
  access: "authenticated",
  args: {},
  handler: (ctx) => ctx.auth.kind,
});

const modules = {
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
    listScopedTokens,
    renameAgentToken,
    revokeAgentToken,
    revokeThenRollback,
    updateAgentTokenMetadata,
    updateScopedToken,
  },
};

const directories: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

export interface CredentialFixture {
  readonly engine: Engine;
  readonly runtime: Runtime;
  close(): Promise<void>;
}

export interface ServedCredentialFixture extends CredentialFixture {
  readonly server: AckerDBServer;
}

export interface CredentialFixtureOptions {
  readonly limits?: ServiceLimits;
  readonly now?: RuntimeOptions["now"];
  readonly resolveScopes?: RuntimeOptions["resolveScopes"];
  readonly serve?: boolean;
}

export function databasePath(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return join(directory, "data.db");
}

export function fixture(
  path: string,
  verifier: CredentialVerifier | undefined,
  extraModules: Record<string, Record<string, unknown>>,
  options: CredentialFixtureOptions & { readonly serve: true },
): Promise<ServedCredentialFixture>;
export function fixture(
  path: string,
  verifier?: CredentialVerifier,
  extraModules?: Record<string, Record<string, unknown>>,
  options?: CredentialFixtureOptions,
): Promise<CredentialFixture>;
export async function fixture(
  path: string,
  verifier?: CredentialVerifier,
  extraModules: Record<string, Record<string, unknown>> = {},
  options: CredentialFixtureOptions = {},
): Promise<CredentialFixture | ServedCredentialFixture> {
  const engine = new Engine(schema, path);
  reconcile(engine);
  const limits = options.limits ?? {
    ...PRODUCTION_LIMITS,
    credentials: { ...PRODUCTION_LIMITS.credentials, maxPerIdentity: 2 },
  };
  const applicationModules = { ...modules, ...extraModules };
  const server = options.serve === true
    ? new AckerDBServer({ limits, port: 0 })
    : undefined;
  const runtime = new Runtime({
    engine,
    registry: server === undefined
      ? testRegistry(applicationModules)
      : server.registerDefinitions(testDefinitions(applicationModules)),
    verifier,
    scopes: FIXTURE_SCOPES,
    // Parent identities hold the full vocabulary unless a test narrows it,
    // so child-credential intersections read a real issuer grant.
    resolveScopes: options.resolveScopes ?? (() => FIXTURE_SCOPES),
    ...(options.now === undefined ? {} : { now: options.now }),
    limits,
  });
  await runtime.start();
  server?.activate(runtime);
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    if (server === undefined) await runtime.drain().catch(() => {});
    else await server.drain().catch(() => {});
    engine.close("clean");
  };
  cleanups.push(close);
  return server === undefined
    ? { engine, runtime, close }
    : { engine, runtime, server, close };
}

export function trackCleanup(cleanup: () => Promise<void>): void {
  cleanups.push(cleanup);
}

export async function cleanupCredentialFixtures(): Promise<void> {
  while (cleanups.length > 0) await cleanups.pop()!().catch(() => {});
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
}

export async function user(
  runtime: Runtime,
  subject: string,
  scopes: readonly string[] = [],
): Promise<UserPrincipal> {
  const identity = await runtime.resolveIdentity({ issuer: "https://issuer.test/", subject });
  return Object.freeze({
    kind: "user",
    scopes: Object.freeze([...scopes]),
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
  ref = "api.tokens.createAgentToken",
): MutationMessage {
  const timestamp = Date.now().toString(16).padStart(12, "0");
  return {
    t: "m",
    id,
    ref,
    args,
    mutationRequestId: `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7000-8000-${requestId.padStart(12, "0")}`,
    issuedAt: Date.now(),
  };
}

export function queryMessage(id: number, ref = "api.tokens.listAgentTokens"): QueryMessage {
  return { t: "q", id, ref, args: {} };
}

export function subscribeMessage(id: number, ref = "api.tokens.listAgentTokens"): SubscribeMessage {
  return { t: "sub", id, ref, args: {} };
}
