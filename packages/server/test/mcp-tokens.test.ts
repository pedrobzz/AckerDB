import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
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
import {
  ANONYMOUS_PRINCIPAL,
  verifyBearerCredential,
  type CredentialVerifier,
  type McpPrincipal,
  type PrincipalInvalidation,
  type UserPrincipal,
} from "../src/auth.ts";
import { callerFairnessKey } from "../src/caller.ts";
import { dbz } from "../src/dbz.ts";
import { Engine } from "../src/engine.ts";
import {
  mutation,
  procedure,
  query,
  type MutationCtx,
  type MutationBuilder,
  type ProcedureBuilder,
  type QueryBuilder,
} from "../src/functions.ts";
import { PRODUCTION_LIMITS } from "../src/limits.ts";
import { createMcp, type McpBuilder } from "../src/mcp.ts";
import { reconcile } from "../src/reconcile.ts";
import { Registry } from "../src/registry.ts";
import { Runtime } from "../src/runtime.ts";
import { defineSchema, defineTable } from "../src/schema.ts";
import { serve } from "../src/serve.ts";
import type {
  RuntimeRequest,
  RuntimePublication,
  SessionApplicationMessage,
  SessionRuntimeContext,
} from "../src/session.ts";

const schema = defineSchema({
  records: defineTable({
    id: dbz.primaryKey(),
    owner: dbz.identity(),
    value: dbz.string(),
  }),
});

const typedMutation = mutation as MutationBuilder<typeof schema>;
const typedQuery = query as QueryBuilder<typeof schema>;
const typedProcedure = procedure as ProcedureBuilder<typeof schema>;
const typedMcp = createMcp as McpBuilder<typeof schema>;
const invalidUpdateKind = dbz.enum("InvalidMcpTokenUpdateKind", ["empty", "undefined"]);

const agentMcp = typedMcp({ name: "agent", path: "/agent/mcp" });
const operationsMcp = typedMcp({ name: "operations", path: "/operations/mcp" });
const scopedMcp = typedMcp({
  name: "scoped",
  path: "/scoped/mcp",
  scopes: ["orders.all", "orders.get", "reports.all"] as const,
});
let retainedOwnerContext: MutationCtx<typeof schema> | null = null;

const createAgentToken = typedMutation({
  access: "authenticated",
  args: {
    name: dbz.string(),
    metadata: dbz.jsonb<Readonly<Record<string, unknown>>>(),
  },
  handler: (ctx, args) => {
    retainedOwnerContext = ctx;
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
    renameAgentToken,
    renameOperationsToken,
    revokeAgentToken,
    revokeOperationsToken,
    listScopedTokens,
    updateAgentTokenMetadata,
    updateScopedToken,
  },
};

const directories: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  retainedOwnerContext = null;
  while (cleanups.length > 0) await cleanups.pop()!().catch(() => {});
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

function fixture(path: string, verifier?: CredentialVerifier): { engine: Engine; runtime: Runtime } {
  const engine = new Engine(schema, path);
  reconcile(engine);
  const runtime = new Runtime({
    engine,
    registry: new Registry(modules),
    verifier,
    telemetry: false,
    limits: {
      ...PRODUCTION_LIMITS,
      mcp: { ...PRODUCTION_LIMITS.mcp, maxTokensPerIdentity: 2 },
    },
  });
  cleanups.push(async () => {
    await runtime.drain().catch(() => {});
    engine.close("clean");
  });
  return { engine, runtime };
}

async function user(runtime: Runtime, subject: string): Promise<UserPrincipal> {
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

function session(
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

function request<Message>(message: Message): RuntimeRequest<Message> {
  return Object.freeze({ message, bytes: Buffer.byteLength(encode(message)) });
}

function mutationMessage(
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

function queryMessage(id: number, ref = "tokens.listAgentTokens"): QueryMessage {
  return { v: PROTOCOL_VERSION, t: "q", id, ref, args: {} };
}

function subscribeMessage(id: number, ref = "tokens.listAgentTokens"): SubscribeMessage {
  return { v: PROTOCOL_VERSION, t: "sub", id, ref, args: {} };
}

function mcpHeaders(token?: string): Record<string, string> {
  return {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": "2025-11-25",
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
  };
}

function rpc(base: string, path: string, method: string, params: unknown, token?: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: mcpHeaders(token),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

async function listedToolNames(response: Response): Promise<readonly string[]> {
  expect(response.status).toBe(200);
  const body = await response.json() as {
    readonly result: { readonly tools: readonly { readonly name: string }[] };
  };
  return body.result.tools.map(({ name }) => name).sort();
}

describe("Identity-bound MCP owner tokens", () => {
  test("creates one-time secrets in an ordinary mutation without persisting replayable plaintext", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dbzz-mcp-token-create-"));
    directories.push(directory);
    const { engine, runtime } = fixture(join(directory, "data.db"));
    const alice = await user(runtime, "alice");
    const aliceSession = session(alice, "alice-session");
    await runtime.openSession(aliceSession);

    const firstMessage = mutationMessage(1, "1", {
      name: "Laptop",
      metadata: { device: "mac", sequence: 1n },
    });
    const first = await runtime.mutation(aliceSession, request(firstMessage));
    const created = first.value as {
      readonly id: string;
      readonly token: string;
      readonly mcp: string;
      readonly name: string;
      readonly metadata: Readonly<Record<string, unknown>>;
      readonly createdAt: number;
      readonly updatedAt: number;
    };
    expect(created).toMatchObject({
      mcp: "agent",
      name: "Laptop",
      metadata: { device: "mac", sequence: 1n },
    });
    expect(created.token).toMatch(/^dbzz_mcp\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
    expect(created.token.split(".")[1]).toBe(created.id);
    expect(created).not.toHaveProperty("expiresAt");

    const stored = engine.writer.query(
      "SELECT token_id, identity, mcp, secret_digest, name, metadata, scopes, created_at, updated_at FROM _dbz_mcp_tokens",
    ).get() as {
      token_id: string;
      identity: bigint;
      mcp: string;
      secret_digest: Uint8Array;
      name: string;
      metadata: string;
      scopes: string;
      created_at: number;
      updated_at: number;
    };
    const secret = created.token.split(".")[2]!;
    expect(stored).toMatchObject({
      token_id: created.id,
      identity: alice.identity,
      mcp: "agent",
      name: "Laptop",
      scopes: "[]",
    });
    expect(Buffer.from(stored.secret_digest).toString("hex")).toBe(
      createHash("sha256").update(secret).digest("hex"),
    );
    const storedText = JSON.stringify({ ...stored, identity: stored.identity.toString() });
    expect(storedText).not.toContain(created.token);
    expect(storedText).not.toContain(secret);
    expect(
      engine.writer.query("SELECT result_disposition, result, result_bytes FROM _dbz_mutations").get(),
    ).toEqual({ result_disposition: "one-time", result: null, result_bytes: 0n });
    expect(() => agentMcp.tokens.create(retainedOwnerContext!, {
      name: "Escaped context",
      metadata: {},
    })).toThrow("MCP token operations require a DBZZ invocation context");
    expect(engine.writer.query("SELECT COUNT(*) AS count FROM _dbz_mcp_tokens").get())
      .toEqual({ count: 1n });

    await expect(runtime.mutation(aliceSession, request(firstMessage))).rejects.toMatchObject({
      code: "conflict",
      message: "mutation committed, but its one-time result is no longer available",
    });
    expect(engine.writer.query("SELECT COUNT(*) AS count FROM _dbz_mcp_tokens").get())
      .toEqual({ count: 1n });

    const second = await runtime.mutation(aliceSession, request(mutationMessage(2, "2", {
      name: "Desktop",
      metadata: {},
    })));
    expect((second.value as { token: string }).token).not.toBe(created.token);
    const listed = await runtime.query(aliceSession, request(queryMessage(3))) as readonly Record<string, unknown>[];
    expect(listed.map(({ name }) => name)).toEqual(["Laptop", "Desktop"]);
    expect(listed.every((token) =>
      !("token" in token) && !("expiresAt" in token) && !("scopes" in token)
    )).toBe(true);
    expect(encode(listed)).not.toContain(secret);

    const bob = await user(runtime, "bob");
    const bobSession = session(bob, "bob-session");
    await runtime.openSession(bobSession);
    expect(await runtime.query(bobSession, request(queryMessage(4)))).toEqual([]);
    await expect(runtime.mutation(aliceSession, request(mutationMessage(5, "3", {
      name: "x".repeat(PRODUCTION_LIMITS.mcp.maxNameBytes + 1),
      metadata: {},
    })))).rejects.toMatchObject({ code: "validation" });
    await expect(runtime.mutation(aliceSession, request(mutationMessage(6, "4", {
      name: "Too much metadata",
      metadata: { value: "x".repeat(PRODUCTION_LIMITS.mcp.maxMetadataBytes) },
    })))).rejects.toMatchObject({ code: "validation" });
    await expect(runtime.mutation(aliceSession, request(mutationMessage(7, "5", {
      name: "Over capacity",
      metadata: {},
    })))).rejects.toMatchObject({ code: "overloaded" });
  });

  test("reactively edits and revokes only the owner's endpoint-bound descriptor", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dbzz-mcp-token-lifecycle-"));
    directories.push(directory);
    const { engine, runtime } = fixture(join(directory, "data.db"));
    const alice = await user(runtime, "lifecycle-alice");
    const publications: SessionApplicationMessage[] = [];
    const aliceSession = session(alice, "lifecycle-alice-session", publications);
    await runtime.openSession(aliceSession);
    await runtime.subscribe(aliceSession, request(subscribeMessage(100)));

    const lifecycleTransitions = () => publications.filter((message) =>
      message.t === "transition" && message.id === 100 &&
      (message.transition.kind === "reset" || message.transition.kind === "update")
    );
    expect(lifecycleTransitions()).toHaveLength(1);
    expect(lifecycleTransitions()[0]).toMatchObject({ transition: { kind: "reset", value: [] } });

    const created = (await runtime.mutation(aliceSession, request(mutationMessage(101, "101", {
      name: "Laptop",
      metadata: { device: "mac" },
    })))).value as { readonly id: string; readonly token: string };
    expect(lifecycleTransitions()).toHaveLength(2);
    expect(lifecycleTransitions().at(-1)).toMatchObject({
      transition: { kind: "update", value: [{ id: created.id, name: "Laptop" }] },
    });

    const before = engine.reader.query(
      "SELECT secret_digest, scopes FROM _dbz_mcp_tokens WHERE token_id = ?",
    ).get(created.id) as { readonly secret_digest: Uint8Array; readonly scopes: string };
    const active = await runtime.authenticateMcpToken("agent", created.token, "before-edit");

    await runtime.mutation(aliceSession, request(mutationMessage(
      102,
      "102",
      { id: created.id, name: "Personal Codex" },
      "tokens.renameAgentToken",
    )));
    expect(lifecycleTransitions()).toHaveLength(3);
    expect(lifecycleTransitions().at(-1)).toMatchObject({
      transition: { kind: "update", value: [{ name: "Personal Codex", metadata: { device: "mac" } }] },
    });

    await runtime.mutation(aliceSession, request(mutationMessage(
      103,
      "103",
      { id: created.id, metadata: { device: "mac", color: "blue", generation: 2n } },
      "tokens.updateAgentTokenMetadata",
    )));
    expect(lifecycleTransitions()).toHaveLength(4);
    expect(lifecycleTransitions().at(-1)).toMatchObject({
      transition: {
        kind: "update",
        value: [{ name: "Personal Codex", metadata: { device: "mac", color: "blue", generation: 2n } }],
      },
    });

    const after = engine.reader.query(
      "SELECT secret_digest, scopes FROM _dbz_mcp_tokens WHERE token_id = ?",
    ).get(created.id) as { readonly secret_digest: Uint8Array; readonly scopes: string };
    expect(Buffer.from(after.secret_digest)).toEqual(Buffer.from(before.secret_digest));
    expect(after.scopes).toBe(before.scopes);
    expect(await runtime.authenticateMcpToken("agent", created.token, "after-edit"))
      .toMatchObject({ identity: alice.identity, tokenId: created.id });
    const activeResult = await runtime.runMcpTool({
      id: "active-through-descriptor-edit",
      mcp: "agent",
      tool: "write_owned_record",
      args: { value: "still-active" },
      principal: active,
    });
    expect(activeResult.content[0]).toMatchObject({ text: `mcp:${alice.identity}` });

    for (const [id, args, ref] of [
      [104, { id: created.id, metadata: { value: "x".repeat(PRODUCTION_LIMITS.mcp.maxMetadataBytes) } }, "tokens.updateAgentTokenMetadata"],
      [105, { id: created.id, kind: "empty" }, "tokens.invalidAgentTokenUpdate"],
      [106, { id: created.id, kind: "undefined" }, "tokens.invalidAgentTokenUpdate"],
    ] as const) {
      await expect(runtime.mutation(aliceSession, request(mutationMessage(id, String(id), args, ref))))
        .rejects.toMatchObject({ code: "validation" });
    }
    expect(lifecycleTransitions()).toHaveLength(4);

    const bob = await user(runtime, "lifecycle-bob");
    const bobSession = session(bob, "lifecycle-bob-session");
    await runtime.openSession(bobSession);
    expect(await runtime.query(bobSession, request(queryMessage(107)))).toEqual([]);
    expect(await runtime.query(
      aliceSession,
      request(queryMessage(108, "tokens.listOperationsTokens")),
    )).toEqual([]);
    for (const [id, context, args, ref] of [
      [109, bobSession, { id: created.id, name: "Stolen" }, "tokens.renameAgentToken"],
      [110, bobSession, { id: created.id }, "tokens.revokeAgentToken"],
      [111, aliceSession, { id: created.id, name: "Wrong endpoint" }, "tokens.renameOperationsToken"],
      [112, aliceSession, { id: created.id }, "tokens.revokeOperationsToken"],
    ] as const) {
      await expect(runtime.mutation(context, request(mutationMessage(id, String(id), args, ref))))
        .rejects.toMatchObject({ code: "not_found" });
    }
    expect(lifecycleTransitions()).toHaveLength(4);
    const unchanged = await runtime.query(
      aliceSession,
      request(queryMessage(113)),
    ) as readonly Record<string, unknown>[];
    expect(unchanged).toMatchObject([{
      id: created.id,
      name: "Personal Codex",
      metadata: { device: "mac", color: "blue", generation: 2n },
    }]);
    expect(unchanged[0]).not.toHaveProperty("token");
    expect(await runtime.authenticateMcpToken("agent", created.token, "after-isolation-checks"))
      .toMatchObject({ identity: alice.identity, tokenId: created.id });

    await runtime.mutation(aliceSession, request(mutationMessage(
      114,
      "114",
      { id: created.id },
      "tokens.revokeAgentToken",
    )));
    expect(lifecycleTransitions()).toHaveLength(5);
    expect(lifecycleTransitions().at(-1)).toMatchObject({ transition: { kind: "update", value: [] } });
    await expect(runtime.authenticateMcpToken("agent", created.token, "after-revoke"))
      .rejects.toMatchObject({ code: "unauthenticated" });

    const server = serve({ runtime, port: 0 });
    cleanups.push(async () => server.drain());
    const response = await rpc(
      `http://127.0.0.1:${server.port}`,
      "/agent/mcp",
      "ping",
      {},
      created.token,
    );
    expect(response.status).toBe(401);
  });

  test("stores exact immutable grants and enforces explicit authenticated, any-of, and all-of policy", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dbzz-mcp-token-scopes-"));
    directories.push(directory);
    const { engine, runtime } = fixture(join(directory, "data.db"));
    const alice = await user(runtime, "scoped-alice");
    const aliceSession = session(alice, "scoped-alice-session");
    await runtime.openSession(aliceSession);

    expect(scopedMcp.scopes.values).toEqual(["orders.all", "orders.get", "reports.all"]);
    expect(Object.isFrozen(scopedMcp.scopes.values)).toBe(true);
    expect(scopedMcp.scopes.check("orders.get", "scope")).toBe("orders.get");
    expect(() => scopedMcp.scopes.check("orders.create", "scope")).toThrow(
      "expected one of",
    );
    expect(() => createMcp({ name: "empty_scopes", scopes: [] } as never)).toThrow(
      "non-empty array",
    );
    expect(() => createMcp({ name: "duplicate_scopes", scopes: ["read", "read"] } as never))
      .toThrow("duplicate");
    expect(() => createMcp({ name: "null_scopes", scopes: null } as never)).toThrow(
      "non-empty array",
    );
    expect(() => scopedMcp.tool({
      name: "runtime_invalid_scope",
      description: "Runtime validation cannot be bypassed by a cast.",
      access: { anyOf: ["orders.create"] },
      args: {},
      handler: () => ({ content: [] }),
    } as never)).toThrow("undeclared scope");
    expect(() => scopedMcp.tool({
      name: "runtime_ambiguous_scope",
      description: "Bare arrays have no implicit combination rule.",
      access: ["orders.get"],
      args: {},
      handler: () => ({ content: [] }),
    } as never)).toThrow("must be public, authenticated");
    expect(() => scopedMcp.tool({
      name: "runtime_empty_scope_policy",
      description: "Empty any-of/all-of policies are rejected.",
      access: { allOf: [] },
      args: {},
      handler: () => ({ content: [] }),
    } as never)).toThrow("at least one scope");
    expect(() => agentMcp.tool({
      name: "runtime_scope_free_policy",
      description: "Scope-free declarations reject cast policy values.",
      access: { anyOf: ["orders.get"] },
      args: {},
      handler: () => ({ content: [] }),
    } as never)).toThrow("declares none");

    await expect(runtime.mutation(aliceSession, request(mutationMessage(
      19,
      "19",
      { name: "No null sentinel", scopes: null },
      "tokens.createScopedToken",
    )))).rejects.toMatchObject({ code: "validation" });
    expect(engine.reader.query("SELECT COUNT(*) AS count FROM _dbz_mcp_tokens").get())
      .toEqual({ count: 0n });

    const created = (await runtime.mutation(aliceSession, request(mutationMessage(
      20,
      "20",
      { name: "Least privilege", scopes: ["orders.get"] },
      "tokens.createScopedToken",
    )))).value as {
      readonly id: string;
      readonly token: string;
      readonly scopes: readonly string[];
    };
    expect(created.scopes).toEqual(["orders.get"]);
    expect(Object.isFrozen(created.scopes)).toBe(true);
    const principal = await runtime.authenticateMcpToken(
      "scoped",
      created.token,
      "scope-auth",
    );
    expect(principal.scopes).toEqual(["orders.get"]);
    expect(Object.isFrozen(principal.scopes)).toBe(true);

    const invoke = (tool: string, current = principal) => runtime.runMcpTool({
      id: `scope-${tool}`,
      mcp: "scoped",
      tool,
      args: {},
      principal: current,
    });
    expect(await runtime.runMcpTool({
      id: "scope-public",
      mcp: "scoped",
      tool: "public_status",
      args: {},
      principal: ANONYMOUS_PRINCIPAL,
    })).toMatchObject({ content: [{ text: "public" }] });
    await expect(runtime.runMcpTool({
      id: "scope-authenticated-anonymous",
      mcp: "scoped",
      tool: "authenticated_status",
      args: {},
      principal: ANONYMOUS_PRINCIPAL,
    })).rejects.toMatchObject({ code: "unauthenticated" });
    await expect(runtime.runMcpTool({
      id: "scope-unknown-anonymous",
      mcp: "scoped",
      tool: "private_or_unknown",
      args: {},
      principal: ANONYMOUS_PRINCIPAL,
    })).rejects.toMatchObject({
      code: "unauthenticated",
      message: "authentication required",
    });
    expect(await invoke("authenticated_status")).toMatchObject({
      content: [{ text: "authenticated" }],
    });
    expect(await invoke("read_orders")).toMatchObject({ content: [{ text: "orders" }] });
    await expect(invoke("read_reports")).rejects.toMatchObject({ code: "unauthorized" });
    await expect(invoke("admin_orders")).rejects.toMatchObject({ code: "unauthorized" });

    await runtime.mutation(aliceSession, request(mutationMessage(
      21,
      "21",
      { id: created.id, scopes: ["reports.all", "orders.get"] },
      "tokens.updateScopedToken",
    )));
    const listed = await runtime.query(
      aliceSession,
      request(queryMessage(22, "tokens.listScopedTokens")),
    ) as readonly [{ readonly scopes: readonly string[] }];
    expect(listed[0].scopes).toEqual(["orders.get", "reports.all"]);
    const expanded = await runtime.authenticateMcpToken(
      "scoped",
      created.token,
      "scope-auth-expanded",
    );
    expect(await invoke("read_reports", expanded)).toMatchObject({
      content: [{ text: "reports" }],
    });
    await expect(invoke("admin_orders", expanded)).rejects.toMatchObject({
      code: "unauthorized",
    });

    for (const [id, scopes] of [
      [23, ["orders.create"]],
      [24, null],
      [25, ["orders.get", "orders.get"]],
    ] as const) {
      await expect(runtime.mutation(aliceSession, request(mutationMessage(
        id,
        String(id),
        { id: created.id, scopes },
        "tokens.updateScopedToken",
      )))).rejects.toMatchObject({ code: "validation" });
    }
    expect((await runtime.query(
      aliceSession,
      request(queryMessage(26, "tokens.listScopedTokens")),
    ) as readonly [{ readonly scopes: readonly string[] }])[0].scopes).toEqual([
      "orders.get",
      "reports.all",
    ]);

    await runtime.mutation(aliceSession, request(mutationMessage(
      27,
      "27",
      { id: created.id, scopes: [] },
      "tokens.updateScopedToken",
    )));
    const emptyPrincipal = await runtime.authenticateMcpToken(
      "scoped",
      created.token,
      "scope-auth-empty",
    );
    expect(emptyPrincipal.scopes).toEqual([]);
    expect(await invoke("authenticated_status", emptyPrincipal)).toMatchObject({
      content: [{ text: "authenticated" }],
    });
    await expect(invoke("read_orders", emptyPrincipal)).rejects.toMatchObject({
      code: "unauthorized",
    });
    expect(engine.reader.query(
      "SELECT scopes FROM _dbz_mcp_tokens WHERE token_id = ?",
    ).get(created.id)).toEqual({ scopes: "[]" });
    engine.writer.query(
      "UPDATE _dbz_mcp_tokens SET scopes = ? WHERE token_id = ?",
    ).run(encode(["orders.create"]), created.id);
    await expect(runtime.authenticateMcpToken(
      "scoped",
      created.token,
      "scope-auth-undeclared-persisted",
    )).rejects.toMatchObject({ code: "unauthenticated" });
  });

  test("filters discovery and reauthorizes every HTTP call against the current exact grant", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dbzz-mcp-discovery-"));
    directories.push(directory);
    const { runtime } = fixture(join(directory, "data.db"));
    const alice = await user(runtime, "discovery-alice");
    const aliceSession = session(alice, "discovery-alice-session");
    await runtime.openSession(aliceSession);
    const created = (await runtime.mutation(aliceSession, request(mutationMessage(
      30,
      "30",
      { name: "Least privilege", scopes: ["orders.get"] },
      "tokens.createScopedToken",
    )))).value as { readonly id: string; readonly token: string };

    const server = serve({ runtime, port: 0 });
    cleanups.push(async () => server.drain());
    const base = `http://127.0.0.1:${server.port}`;

    expect(await listedToolNames(await rpc(base, scopedMcp.path, "tools/list", {}))).toEqual([
      "public_status",
    ]);
    const publicCall = await rpc(base, scopedMcp.path, "tools/call", {
      name: "public_status",
      arguments: {},
    });
    expect(publicCall.status).toBe(200);

    const protectedCall = await rpc(base, scopedMcp.path, "tools/call", {
      name: "read_reports",
      arguments: {},
    });
    expect(protectedCall.status).toBe(401);
    expect(protectedCall.headers.get("www-authenticate")).toBe('Bearer realm="scoped"');
    expect(protectedCall.headers.get("access-control-expose-headers"))
      .toContain("www-authenticate");
    const protectedBody = await protectedCall.json();
    expect(protectedBody).toEqual({
      jsonrpc: "2.0",
      error: { code: -32000, message: "authentication required" },
      id: null,
    });
    const unknownCall = await rpc(base, scopedMcp.path, "tools/call", {
      name: "private_or_unknown",
      arguments: {},
    });
    expect(unknownCall.status).toBe(protectedCall.status);
    expect(unknownCall.headers.get("www-authenticate")).toBe(
      protectedCall.headers.get("www-authenticate"),
    );
    expect(await unknownCall.json()).toEqual(protectedBody);
    const malformedProtectedCall = await rpc(base, scopedMcp.path, "tools/call", {
      name: "read_reports",
      arguments: "invalid",
    });
    expect(malformedProtectedCall.status).toBe(401);
    expect(await malformedProtectedCall.json()).toEqual(protectedBody);

    const notification = await fetch(`${base}${scopedMcp.path}`, {
      method: "POST",
      headers: mcpHeaders(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "read_reports", arguments: {} },
      }),
    });
    expect(notification.status).toBe(202);
    const batchedCall = await fetch(`${base}${scopedMcp.path}`, {
      method: "POST",
      headers: mcpHeaders(),
      body: JSON.stringify([{
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "read_reports", arguments: {} },
      }]),
    });
    expect(batchedCall.status).toBe(401);
    expect(await batchedCall.json()).toEqual(protectedBody);
    const malformedBatch = await fetch(`${base}${scopedMcp.path}`, {
      method: "POST",
      headers: mcpHeaders(),
      body: JSON.stringify([{
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "read_reports", arguments: {} },
      }, { invalid: true }]),
    });
    expect(malformedBatch.status).toBe(400);

    const invalidToken = `dbzz_mcp.${"A".repeat(22)}.${"B".repeat(43)}`;
    const invalid = await rpc(base, scopedMcp.path, "tools/list", {}, invalidToken);
    expect(invalid.status).toBe(401);
    expect(invalid.headers.get("www-authenticate")).toBe(
      'Bearer realm="scoped", error="invalid_token"',
    );
    expect(JSON.stringify(await invalid.json())).not.toContain("read_reports");

    expect(await listedToolNames(
      await rpc(base, scopedMcp.path, "tools/list", {}, created.token),
    )).toEqual(["authenticated_status", "public_status", "read_orders"]);
    const anyOf = await rpc(base, scopedMcp.path, "tools/call", {
      name: "read_orders",
      arguments: {},
    }, created.token);
    expect(anyOf.status).toBe(200);
    const insufficient = await rpc(base, scopedMcp.path, "tools/call", {
      name: "read_reports",
      arguments: {},
    }, created.token);
    expect(insufficient.status).toBe(403);
    expect(insufficient.headers.get("www-authenticate")).toBe(
      'Bearer realm="scoped", error="insufficient_scope"',
    );
    const insufficientBody = await insufficient.json();
    expect(insufficientBody).toEqual({
      jsonrpc: "2.0",
      error: { code: -32000, message: "access denied" },
      id: null,
    });
    expect(JSON.stringify(insufficientBody)).not.toContain("reports.all");

    await runtime.mutation(aliceSession, request(mutationMessage(
      31,
      "31",
      { id: created.id, scopes: ["reports.all", "orders.get"] },
      "tokens.updateScopedToken",
    )));
    const cachedNames = await listedToolNames(
      await rpc(base, scopedMcp.path, "tools/list", {}, created.token),
    );
    expect(cachedNames).toEqual([
      "authenticated_status",
      "public_status",
      "read_orders",
      "read_reports",
    ]);
    const allOf = await rpc(base, scopedMcp.path, "tools/call", {
      name: "read_reports",
      arguments: {},
    }, created.token);
    expect(allOf.status).toBe(200);

    await runtime.mutation(aliceSession, request(mutationMessage(
      32,
      "32",
      { id: created.id, scopes: [] },
      "tokens.updateScopedToken",
    )));
    expect(cachedNames).toContain("read_reports");
    const cachedCall = await rpc(base, scopedMcp.path, "tools/call", {
      name: "read_reports",
      arguments: {},
    }, created.token);
    expect(cachedCall.status).toBe(403);
    expect(await cachedCall.json()).toEqual(insufficientBody);
    expect(await listedToolNames(
      await rpc(base, scopedMcp.path, "tools/list", {}, created.token),
    )).toEqual(["authenticated_status", "public_status"]);
  });

  test("survives restart, authenticates only its bound endpoint, and cannot self-administer", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dbzz-mcp-token-auth-"));
    directories.push(directory);
    const path = join(directory, "data.db");
    const verifierCalls: string[] = [];
    const permissiveVerifier: CredentialVerifier = {
      revocationBound: { kind: "token-expiration" },
      subscribeInvalidation: (_listener: (invalidation: PrincipalInvalidation) => void) => () => {},
      verify: async (credential) => {
        verifierCalls.push(credential);
        return {
          kind: "user",
          issuer: "https://external.test/",
          subject: "accepted-by-test-verifier",
          claims: {},
          expiresAt: Date.now() + 60_000,
          tokenId: null,
        };
      },
    };

    const first = fixture(path, permissiveVerifier);
    const firstAlice = await user(first.runtime, "alice");
    const firstSession = session(firstAlice, "first-session");
    await first.runtime.openSession(firstSession);
    const created = (await first.runtime.mutation(
      firstSession,
      request(mutationMessage(1, "10", { name: "Codex", metadata: { host: "codex" } })),
    )).value as { readonly token: string; readonly id: string };
    const secondCreated = (await first.runtime.mutation(
      firstSession,
      request(mutationMessage(2, "11", { name: "Claude", metadata: { host: "claude" } })),
    )).value as { readonly token: string; readonly id: string };
    await first.runtime.drain();
    first.engine.close("clean");
    cleanups.pop();

    const second = fixture(path, permissiveVerifier);
    const secondAlice = await user(second.runtime, "alice");
    expect(secondAlice.identity).toBe(firstAlice.identity);
    const principal = await second.runtime.authenticateMcpToken(
      "agent",
      created.token,
      "test-mcp-auth",
    );
    expect(principal).toEqual({
      kind: "mcp",
      identity: firstAlice.identity,
      mcp: "agent",
      tokenId: created.id,
      scopes: [],
    });
    expect(await second.runtime.authenticateMcpToken(
      "agent",
      secondCreated.token,
      "test-second-mcp-auth",
    )).toEqual({
      kind: "mcp",
      identity: firstAlice.identity,
      mcp: "agent",
      tokenId: secondCreated.id,
      scopes: [],
    });
    await expect(second.runtime.runMcpTool({
      id: "wrong-endpoint",
      mcp: "operations",
      tool: "write_owned_record",
      args: { value: "forbidden" },
      principal,
    })).rejects.toMatchObject({ code: "unauthorized" });
    await expect(second.runtime.runProcedure({
      id: 1,
      address: "security.normalProcedure",
      args: {},
      principal,
      respond: () => new Response(),
    })).rejects.toMatchObject({ code: "unauthorized" });
    await expect(verifyBearerCredential(created.token, permissiveVerifier)).rejects.toMatchObject({
      code: "unauthenticated",
    });
    expect(verifierCalls).toEqual([]);

    const server = serve({ runtime: second.runtime, port: 0 });
    cleanups.push(async () => server.drain());
    const base = `http://127.0.0.1:${server.port}`;
    const called = await rpc(base, "/agent/mcp", "tools/call", {
      name: "write_owned_record",
      arguments: { value: "delegated-codex" },
    }, created.token);
    expect(called.status).toBe(200);
    expect(await called.json()).toMatchObject({
      result: {
        content: [
          { type: "text", text: `mcp:${firstAlice.identity}` },
          {
            type: "resource_link",
            uri: "dbzz://records/1",
            name: "record-1",
            annotations: { audience: ["assistant"], priority: 0.8 },
            _meta: { owner: firstAlice.identity.toString() },
          },
        ],
        _meta: { tokenId: created.id },
      },
    });
    const secondCalled = await rpc(base, "/agent/mcp", "tools/call", {
      name: "write_owned_record",
      arguments: { value: "delegated-claude" },
    }, secondCreated.token);
    expect(secondCalled.status).toBe(200);
    expect(second.engine.reader.query("SELECT owner, value FROM records ORDER BY id").all()).toEqual([
      { owner: firstAlice.identity, value: "delegated-codex" },
      { owner: firstAlice.identity, value: "delegated-claude" },
    ]);

    for (const [endpoint, token] of [
      ["/operations/mcp", created.token],
      ["/agent/mcp", `dbzz_mcp.${"A".repeat(22)}.${"B".repeat(43)}`],
      ["/agent/mcp", "dbzz_mcp.bad"],
      ["/agent/mcp", "external-provider-token"],
    ] as const) {
      const rejected = await rpc(base, endpoint, "ping", {}, token);
      expect(rejected.status).toBe(401);
    }
    expect(verifierCalls).toEqual([]);

    const selfAdmin = await rpc(base, "/agent/mcp", "tools/call", {
      name: "attempt_self_administration",
      arguments: {},
    }, created.token);
    expect(await selfAdmin.json()).toMatchObject({ result: { isError: true } });
    expect(second.engine.reader.query("SELECT COUNT(*) AS count FROM _dbz_mcp_tokens").get())
      .toEqual({ count: 2n });

    const anonymous = await rpc(base, "/agent/mcp", "tools/call", {
      name: "write_owned_record",
      arguments: { value: "forbidden" },
    });
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toMatchObject({
      error: { message: "authentication required" },
    });
  });
});
