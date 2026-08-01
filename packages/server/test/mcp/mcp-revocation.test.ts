import { afterEach, describe, expect, test } from "bun:test";
import { v } from "../../src/validation/v.ts";
import { PRODUCTION_LIMITS } from "../../src/runtime/limits.ts";
import { serve } from "../../src/transport/server.ts";
import {
  cleanupMcpTokenFixtures,
  databasePath,
  fixture,
  mutationMessage,
  request,
  session,
  trackCleanup,
  typedMutation,
  typedMcp,
  typedMcpAuth,
  typedProcedure,
  user,
} from "../support/mcp-token-fixture.ts";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

interface ToolGate {
  readonly started: Deferred<void>;
  readonly release: Deferred<void>;
  aborted: boolean;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((accept) => {
      resolve = accept;
    }),
    resolve,
  };
}

const gates = new Map<string, ToolGate>();
const AGENT_ORIGIN = "https://agent.example";

function openGate(key: string): ToolGate {
  const gate = {
    started: deferred<void>(),
    release: deferred<void>(),
    aborted: false,
  };
  gates.set(key, gate);
  return gate;
}

function requiredGate(key: string): ToolGate {
  const gate = gates.get(key);
  if (gate === undefined) throw new Error(`missing test gate ${key}`);
  return gate;
}

function waitForRelease(signal: AbortSignal, key: string): Promise<void> {
  const gate = requiredGate(key);
  gate.started.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      gate.aborted = true;
      reject(signal.reason);
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    void gate.release.promise.then(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
  });
}

async function within<T>(promise: Promise<T>, timeoutMs = 2_000): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("test timed out")), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt++) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("condition was not reached");
}

const holdAgent = typedProcedure({
  description: "Test live token invalidation.",
  access: "authenticated",
  args: { key: v.string() },
  returns: v.object({ status: v.string() }),
  handler: async (ctx, args) => {
    await waitForRelease(ctx.abortSignal, args.key);
    ctx.abortSignal.throwIfAborted();
    return { status: "released" };
  },
});

const holdScoped = typedProcedure({
  description: "Test live scoped-token invalidation.",
  access: "authenticated",
  args: { key: v.string() },
  returns: v.object({ status: v.string() }),
  handler: async (ctx, args) => {
    await waitForRelease(ctx.abortSignal, args.key);
    ctx.abortSignal.throwIfAborted();
    return { status: "released" };
  },
});

const queueAgentWrite = typedProcedure({
  description: "Queue an agent-token writer.",
  access: "authenticated",
  args: { key: v.string() },
  returns: v.object({ status: v.string() }),
  handler: async (ctx, args) => {
    if (ctx.auth.kind !== "mcp") throw new Error("expected MCP principal");
    const identity = ctx.auth.identity;
    requiredGate(args.key).started.resolve();
    const written = await ctx.tx((tx) =>
      tx.db.records.insert({ owner: identity, value: "queued" }));
    if (!written.ok) throw new Error("queued write failed");
    return { status: "written" };
  },
});

const queueScopedWrite = typedProcedure({
  description: "Queue a scoped-token writer.",
  access: "authenticated",
  args: { key: v.string() },
  returns: v.object({ status: v.string() }),
  handler: async (ctx, args) => {
    if (ctx.auth.kind !== "mcp") throw new Error("expected MCP principal");
    const identity = ctx.auth.identity;
    requiredGate(args.key).started.resolve();
    const written = await ctx.tx((tx) =>
      tx.db.records.insert({ owner: identity, value: "queued" }));
    if (!written.ok) throw new Error("queued write failed");
    return { status: "written" };
  },
});

const revocationAgentAuth = typedMcpAuth({ name: "revocation_agent" });
const revocationAgentMcp = typedMcp({
  name: "revocation_agent",
  auth: revocationAgentAuth,
  path: "/revocation/agent/mcp",
  tools: {
    hold_agent: { fn: holdAgent },
    queue_agent_write: { fn: queueAgentWrite },
  },
});

const revocationScopedAuth = typedMcpAuth({
  name: "revocation_scoped",
  scopes: ["orders.get"] as const,
});
const revocationScopedMcp = typedMcp({
  name: "revocation_scoped",
  auth: revocationScopedAuth,
  path: "/revocation/scoped/mcp",
  tools: {
    hold_scoped: { fn: holdScoped, access: { anyOf: ["orders.get"] } },
    queue_scoped_write: { fn: queueScopedWrite, access: { anyOf: ["orders.get"] } },
  },
});

const rollbackAgentRevoke = typedMutation({
  access: "authenticated",
  args: { id: v.string() },
  handler: (ctx, args) => {
    revocationAgentAuth.tokens.revoke(ctx, args.id);
    throw new Error("roll back agent revoke");
  },
});

const rollbackScopeReduction = typedMutation({
  access: "authenticated",
  args: { id: v.string() },
  handler: (ctx, args) => {
    revocationScopedAuth.tokens.updateScopes(ctx, args.id, []);
    throw new Error("roll back scope reduction");
  },
});

const gatedAgentRevoke = typedMutation({
  access: "authenticated",
  args: { id: v.string(), key: v.string() },
  handler: async (ctx, args) => {
    const gate = requiredGate(args.key);
    gate.started.resolve();
    await gate.release.promise;
    revocationAgentAuth.tokens.revoke(ctx, args.id);
  },
});

const gatedScopeReduction = typedMutation({
  access: "authenticated",
  args: { id: v.string(), key: v.string() },
  handler: async (ctx, args) => {
    const gate = requiredGate(args.key);
    gate.started.resolve();
    await gate.release.promise;
    revocationScopedAuth.tokens.updateScopes(ctx, args.id, []);
  },
});

const createRevocationAgentToken = typedMutation({
  access: "authenticated",
  args: { name: v.string() },
  handler: (ctx, args) => revocationAgentAuth.tokens.create(ctx, {
    name: args.name,
    metadata: {},
  }),
});

const createRevocationScopedToken = typedMutation({
  access: "authenticated",
  args: { name: v.string() },
  handler: (ctx, args) => revocationScopedAuth.tokens.create(ctx, {
    name: args.name,
    metadata: {},
    scopes: ["orders.get"],
  }),
});

const updateRevocationAgentMetadata = typedMutation({
  access: "authenticated",
  args: { id: v.string(), metadata: v.jsonb<Readonly<Record<string, unknown>>>() },
  handler: (ctx, args) => revocationAgentAuth.tokens.update(ctx, args.id, {
    metadata: args.metadata,
  }),
});

const revokeRevocationAgentToken = typedMutation({
  access: "authenticated",
  args: { id: v.string() },
  handler: (ctx, args) => revocationAgentAuth.tokens.revoke(ctx, args.id),
});

const extraModules = {
  mcp: { revocationAgentMcp, revocationScopedMcp },
  revocation: {
    createRevocationAgentToken,
    createRevocationScopedToken,
    gatedAgentRevoke,
    gatedScopeReduction,
    holdAgent,
    holdScoped,
    queueAgentWrite,
    queueScopedWrite,
    rollbackAgentRevoke,
    rollbackScopeReduction,
    revokeRevocationAgentToken,
    updateRevocationAgentMetadata,
  },
};

function headers(token: string, origin?: string): Record<string, string> {
  return {
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "mcp-protocol-version": "2025-11-25",
    ...(origin === undefined ? {} : { origin }),
  };
}

function rpc(
  base: string,
  path: string,
  method: string,
  params: unknown,
  token: string,
  origin?: string,
): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: headers(token, origin),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

async function createAgentToken(
  runtime: ReturnType<typeof fixture>["runtime"],
  owner: ReturnType<typeof session>,
  id: number,
  name: string,
): Promise<{ readonly id: string; readonly token: string }> {
  return (
    await runtime.mutation(
      owner,
      request(
        mutationMessage(id, String(id), {
          name,
        }, "revocation.createRevocationAgentToken"),
      ),
    )
  ).value as { readonly id: string; readonly token: string };
}

async function createScopedToken(
  runtime: ReturnType<typeof fixture>["runtime"],
  owner: ReturnType<typeof session>,
  id: number,
  name: string,
): Promise<{ readonly id: string; readonly token: string }> {
  return (
    await runtime.mutation(
      owner,
      request(
        mutationMessage(
          id,
          String(id),
          { name },
          "revocation.createRevocationScopedToken",
        ),
      ),
    )
  ).value as { readonly id: string; readonly token: string };
}

afterEach(async () => {
  for (const gate of gates.values()) gate.release.resolve();
  gates.clear();
  await cleanupMcpTokenFixtures();
});

describe("bounded live MCP credential invalidation", () => {
  for (const authorityChange of ["revoke", "scope reduction"] as const) {
    test(`cancels active HTTP work and queued transactions after ${authorityChange}`, async () => {
      const { runtime } = fixture(
        databasePath(
          `ackerdb-mcp-${authorityChange === "revoke" ? "revoke" : "scope"}-`,
        ),
        undefined,
        extraModules,
      );
      const principal = await user(runtime, `owner-${authorityChange}`);
      const owner = session(principal, `owner-${authorityChange}`);
      await runtime.openSession(owner);
      const target =
        authorityChange === "revoke"
          ? await createAgentToken(runtime, owner, 1, "Target")
          : await createScopedToken(runtime, owner, 1, "Target");
      const server = serve({
        runtime,
        port: 0,
        mcpHttp: { allowedOrigins: [AGENT_ORIGIN] },
      });
      trackCleanup(async () => server.drain());
      const base = `http://127.0.0.1:${server.port}`;
      const path =
        authorityChange === "revoke" ? revocationAgentMcp.path : revocationScopedMcp.path;
      const holdName =
        authorityChange === "revoke" ? "hold_agent" : "hold_scoped";
      const queuedName =
        authorityChange === "revoke"
          ? "queue_agent_write"
          : "queue_scoped_write";
      const authorityGate = openGate(`${authorityChange}-authority`);
      const authority = runtime.mutation(
        owner,
        request(
          mutationMessage(
            3,
            "3",
            { id: target.id, key: `${authorityChange}-authority` },
            authorityChange === "revoke"
              ? "revocation.gatedAgentRevoke"
              : "revocation.gatedScopeReduction",
          ),
        ),
      );
      await within(authorityGate.started.promise);

      const activeGate = openGate(`${authorityChange}-active`);
      const active = rpc(
        base,
        path,
        "tools/call",
        {
          name: holdName,
          arguments: { key: `${authorityChange}-active` },
        },
        target.token,
        AGENT_ORIGIN,
      );
      await within(activeGate.started.promise);

      const queuedGate = openGate(`${authorityChange}-queued`);
      const queued = rpc(
        base,
        path,
        "tools/call",
        {
          name: queuedName,
          arguments: { key: `${authorityChange}-queued` },
        },
        target.token,
      );
      await within(queuedGate.started.promise);
      await waitUntil(() => runtime.status().writer.queue.queuedItems === 1);

      authorityGate.release.resolve();
      await within(authority);
      const committedAt = performance.now();
      const [activeResponse, queuedResponse] = await within(
        Promise.all([active, queued]),
      );
      expect(performance.now() - committedAt).toBeLessThanOrEqual(
        PRODUCTION_LIMITS.auth.revocationDeadlineMs,
      );
      expect(activeGate.aborted).toBe(true);
      expect(activeResponse.status).toBe(401);
      expect(activeResponse.headers.get("access-control-allow-origin")).toBe(
        AGENT_ORIGIN,
      );
      expect(queuedResponse.status).toBe(401);
      expect(runtime.status().writer.queue.queuedItems).toBe(0);

      const fresh = await rpc(
        base,
        path,
        "tools/call",
        {
          name: holdName,
          arguments: { key: "fresh-must-not-run" },
        },
        target.token,
      );
      expect(fresh.status).toBe(authorityChange === "revoke" ? 401 : 403);
      if (authorityChange === "scope reduction") {
        expect(
          (
            await runtime.authenticateMcpToken(
              "revocation_scoped",
              target.token,
              "fresh-reduced-grant",
            )
          ).scopes,
        ).toEqual([]);
      }
    });
  }

  test("rollbacks and descriptor edits preserve active and fresh authority", async () => {
    const { runtime } = fixture(
      databasePath("ackerdb-mcp-rollback-"),
      undefined,
      extraModules,
    );
    const principal = await user(runtime, "rollback-owner");
    const owner = session(principal, "rollback-owner");
    await runtime.openSession(owner);
    const agent = await createAgentToken(runtime, owner, 10, "Agent");
    const scoped = await createScopedToken(runtime, owner, 11, "Scoped");
    const server = serve({ runtime, port: 0 });
    trackCleanup(async () => server.drain());
    const base = `http://127.0.0.1:${server.port}`;

    const agentGate = openGate("rollback-agent");
    const activeAgent = rpc(
      base,
      revocationAgentMcp.path,
      "tools/call",
      {
        name: "hold_agent",
        arguments: { key: "rollback-agent" },
      },
      agent.token,
    );
    await within(agentGate.started.promise);
    await expect(
      runtime.mutation(
        owner,
        request(
          mutationMessage(
            12,
            "12",
            { id: agent.id },
            "revocation.rollbackAgentRevoke",
          ),
        ),
      ),
    ).rejects.toThrow("roll back agent revoke");
    await runtime.mutation(
      owner,
      request(
        mutationMessage(
          13,
          "13",
          { id: agent.id, metadata: { renamed: true } },
          "revocation.updateRevocationAgentMetadata",
        ),
      ),
    );
    expect(agentGate.aborted).toBe(false);
    expect(
      (await rpc(base, revocationAgentMcp.path, "tools/list", {}, agent.token)).status,
    ).toBe(200);
    agentGate.release.resolve();
    expect((await within(activeAgent)).status).toBe(200);

    const scopedGate = openGate("rollback-scoped");
    const activeScoped = rpc(
      base,
      revocationScopedMcp.path,
      "tools/call",
      {
        name: "hold_scoped",
        arguments: { key: "rollback-scoped" },
      },
      scoped.token,
    );
    await within(scopedGate.started.promise);
    await expect(
      runtime.mutation(
        owner,
        request(
          mutationMessage(
            14,
            "14",
            { id: scoped.id },
            "revocation.rollbackScopeReduction",
          ),
        ),
      ),
    ).rejects.toThrow("roll back scope reduction");
    expect(scopedGate.aborted).toBe(false);
    expect(
      (
        await runtime.authenticateMcpToken(
          "revocation_scoped",
          scoped.token,
          "fresh-after-rollback",
        )
      ).scopes,
    ).toEqual(["orders.get"]);
    scopedGate.release.resolve();
    expect((await within(activeScoped)).status).toBe(200);
  });

  test("targets the exact token and endpoint while unrelated work continues", async () => {
    const { runtime } = fixture(
      databasePath("ackerdb-mcp-isolation-"),
      undefined,
      extraModules,
    );
    const principal = await user(runtime, "isolation-owner");
    const owner = session(principal, "isolation-owner");
    await runtime.openSession(owner);
    const revoked = await createAgentToken(runtime, owner, 20, "Revoked");
    const agent = await createAgentToken(runtime, owner, 21, "Unrelated agent");
    const scoped = await createScopedToken(
      runtime,
      owner,
      22,
      "Unrelated scoped",
    );
    const server = serve({ runtime, port: 0 });
    trackCleanup(async () => server.drain());
    const base = `http://127.0.0.1:${server.port}`;

    const revokedGate = openGate("isolation-revoked");
    const agentGate = openGate("isolation-agent");
    const scopedGate = openGate("isolation-scoped");
    const revokedCall = rpc(
      base,
      revocationAgentMcp.path,
      "tools/call",
      {
        name: "hold_agent",
        arguments: { key: "isolation-revoked" },
      },
      revoked.token,
    );
    const agentCall = rpc(
      base,
      revocationAgentMcp.path,
      "tools/call",
      {
        name: "hold_agent",
        arguments: { key: "isolation-agent" },
      },
      agent.token,
    );
    const scopedCall = rpc(
      base,
      revocationScopedMcp.path,
      "tools/call",
      {
        name: "hold_scoped",
        arguments: { key: "isolation-scoped" },
      },
      scoped.token,
    );
    await within(
      Promise.all([
        revokedGate.started.promise,
        agentGate.started.promise,
        scopedGate.started.promise,
      ]),
    );

    await runtime.mutation(
      owner,
      request(
        mutationMessage(
          23,
          "23",
          { id: revoked.id },
          "revocation.revokeRevocationAgentToken",
        ),
      ),
    );
    expect((await within(revokedCall)).status).toBe(401);
    expect(revokedGate.aborted).toBe(true);
    expect(agentGate.aborted).toBe(false);
    expect(scopedGate.aborted).toBe(false);
    expect(
      (await rpc(base, revocationAgentMcp.path, "tools/list", {}, agent.token)).status,
    ).toBe(200);
    expect(
      (await rpc(base, revocationScopedMcp.path, "tools/list", {}, scoped.token)).status,
    ).toBe(200);

    agentGate.release.resolve();
    scopedGate.release.resolve();
    expect((await within(agentCall)).status).toBe(200);
    expect((await within(scopedCall)).status).toBe(200);
    expect(runtime.status()).toMatchObject({ activeOperations: 0 });
  });
});
