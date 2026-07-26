import { Server as McpSdkServer } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { callerFairnessKey } from "../../src/runtime/caller.ts";
import { v } from "../../src/validation/v.ts";
import { defineServiceLimits, PRODUCTION_LIMITS } from "../../src/runtime/limits.ts";
import { serve } from "../../src/transport/server.ts";
import type { Runtime, RuntimeOptions } from "../../src/runtime/runtime.ts";
import type { TelemetryRecord } from "../../src/telemetry/telemetry.ts";
import {
  cleanupMcpTokenFixtures,
  databasePath,
  fixture,
  mutationMessage,
  request,
  session,
  trackCleanup,
  typedMcp,
  typedMcpTool,
  typedMutation,
  typedQuery,
  user,
} from "../support/mcp-token-fixture.ts";

const MCP_PROTOCOL_VERSION = "2025-11-25";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

interface GateState {
  readonly started: Deferred<void>;
  readonly released: Deferred<void>;
  readonly aborted: Deferred<unknown>;
}

interface Gate {
  readonly started: Promise<void>;
  readonly aborted: Promise<unknown>;
  release(): void;
}

const gates = new Map<string, GateState>();

function gate(id: string): Gate {
  if (gates.has(id)) throw new Error(`gate "${id}" already exists`);
  const state: GateState = {
    started: deferred<void>(),
    released: deferred<void>(),
    aborted: deferred<unknown>(),
  };
  gates.set(id, state);
  return Object.freeze({
    started: state.started.promise,
    aborted: state.aborted.promise,
    release: () => state.released.resolve(undefined),
  });
}

async function waitAtGate(id: string, signal: AbortSignal): Promise<void> {
  const state = gates.get(id);
  if (state === undefined) throw new Error(`gate "${id}" does not exist`);
  state.started.resolve(undefined);
  const abortReason = (): unknown => signal.reason ?? new Error("MCP request aborted");
  if (signal.aborted) {
    const reason = abortReason();
    state.aborted.resolve(reason);
    gates.delete(id);
    throw reason;
  }
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const onAbort = (): void => {
    const reason = abortReason();
    state.aborted.resolve(reason);
    rejectAbort(reason);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await Promise.race([state.released.promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
    gates.delete(id);
  }
}

function releaseGates(): void {
  for (const state of gates.values()) state.released.resolve(undefined);
}

const createOwnershipToken = typedMutation({
  access: "authenticated",
  args: { name: v.string() },
  handler: (ctx, args) => ownershipMcp.tokens.create(ctx, {
    name: args.name,
    metadata: {},
  }),
});

const pingOwnership = typedMcpTool({
  description: "Return the current principal kind without allocating runtime state.",
  access: "public",
  args: {},
  handler: (ctx) => ({ content: [{ type: "text", text: ctx.auth.kind }] }),
});

const holdOwnership = typedMcpTool({
  description: "Hold one runtime-owned operation at a deterministic test gate.",
  access: "public",
  args: { gate: v.string() },
  handler: async (ctx, args) => {
    await waitAtGate(args.gate, ctx.abortSignal);
    return { content: [{ type: "text", text: ctx.auth.kind }] };
  },
});

const insertOwnershipRecord = typedMutation({
  access: "authenticated",
  args: { value: v.string() },
  handler: (ctx, args) => {
    if (ctx.auth.kind !== "mcp") throw new Error("expected MCP principal");
    return ctx.db.records.insert({ owner: ctx.auth.identity, value: args.value });
  },
});

const countOwnershipRecords = typedQuery({
  access: "authenticated",
  args: {},
  handler: (ctx) => ctx.db.records.query().count(),
});

const nestedOwnershipWrite = typedMcpTool({
  description: "Compose nested AckerDB functions inside one transaction.",
  access: "authenticated",
  args: {
    value: v.string(),
    gate: v.string().nullable(),
    commit: v.boolean(),
  },
  handler: (ctx, args) => ctx.tx(async (tx) => {
    await insertOwnershipRecord(tx, { value: args.value });
    if (args.gate !== null) await waitAtGate(args.gate, ctx.abortSignal);
    if (!args.commit) throw new Error("ownership rollback fixture");
    const count = (await countOwnershipRecords(tx, {})).data;
    return { content: [{ type: "text", text: String(count) }] };
  }),
});

const ownershipMcp = typedMcp({
  name: "ownership",
  path: "/ownership/mcp",
  tools: {
    hold_ownership: holdOwnership,
    nested_ownership_write: nestedOwnershipWrite,
    ping_ownership: pingOwnership,
  },
});

const ownershipModules = {
  ownership: {
    ownershipMcp,
    createOwnershipToken,
    pingOwnership,
    holdOwnership,
    insertOwnershipRecord,
    countOwnershipRecords,
    nestedOwnershipWrite,
  },
};

interface Harness {
  readonly runtime: Runtime;
  readonly engine: ReturnType<typeof fixture>["engine"];
  readonly server: ReturnType<typeof serve>;
  readonly base: string;
}

function startHarness(
  maxOperations = 8,
  maxOperationsPerCaller = 4,
  telemetry: RuntimeOptions["telemetry"] = false,
): Harness {
  const limits = defineServiceLimits({
    ...PRODUCTION_LIMITS,
    maxOperations,
    maxOperationsPerCaller,
    maxOperationsPerConnection: Math.min(maxOperations, maxOperationsPerCaller),
    readQueue: { ...PRODUCTION_LIMITS.readQueue, maxAgeMs: 1_000 },
    writeQueue: { ...PRODUCTION_LIMITS.writeQueue, maxAgeMs: 1_000 },
    mcp: { ...PRODUCTION_LIMITS.mcp, maxTokensPerIdentity: 4 },
    gracefulShutdownMs: 250,
  });
  const value = fixture(
    databasePath("ackerdb-mcp-runtime-"),
    undefined,
    ownershipModules,
    { limits, telemetry },
  );
  const server = serve({ runtime: value.runtime, port: 0 });
  trackCleanup(() => server.drain());
  return {
    ...value,
    server,
    base: `http://127.0.0.1:${server.port}`,
  };
}

let rpcId = 0;
let mutationId = 0;

function rpc(
  value: Harness,
  tool: string,
  args: unknown,
  token?: string,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(`${value.base}${ownershipMcp.path}`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++rpcId,
      method: "tools/call",
      params: { name: tool, arguments: args },
    }),
    ...(signal === undefined ? {} : { signal }),
  });
}

async function tokens(
  value: Harness,
  subject: string,
  names: readonly string[],
): Promise<readonly string[]> {
  const principal = await user(value.runtime, subject);
  const context = session(principal, `ownership-${subject}-${++mutationId}`);
  await value.runtime.openSession(context);
  try {
    const created: string[] = [];
    for (const name of names) {
      const id = ++mutationId;
      const result = await value.runtime.mutation(context, request(mutationMessage(
        id,
        String(id),
        { name },
        "ownership.createOwnershipToken",
      )));
      created.push((result.value as { readonly token: string }).token);
    }
    return created;
  } finally {
    await value.runtime.closeSession(context, {
      code: "unavailable",
      retryable: false,
      message: "test setup complete",
    });
  }
}

async function eventually(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("condition did not become true");
    await Bun.sleep(5);
  }
}

async function expectIdle(value: Harness): Promise<void> {
  await eventually(() =>
    value.server.status().httpIngress === 0 &&
    value.runtime.status().activeOperations === 0 &&
    value.runtime.status().reader.active === 0 &&
    value.runtime.status().writer.active === 0
  );
  expect(value.server.status()).toMatchObject({
    connections: 0,
    httpIngress: 0,
    httpFairnessKeys: 0,
  });
  expect(value.runtime.status()).toMatchObject({
    connections: 0,
    activeOperations: 0,
    activeOperationCallers: 0,
    activeSse: 0,
    reader: { active: 0, queue: { queuedItems: 0, queuedBytes: 0 } },
    writer: { active: 0, queue: { queuedItems: 0, queuedBytes: 0 } },
  });
  expect(gates.size).toBe(0);
}

afterEach(async () => {
  releaseGates();
  await cleanupMcpTokenFixtures();
  gates.clear();
});

describe("MCP Runtime ownership", () => {
  test("shares HTTP and Runtime admission fairly by durable Identity", async () => {
    const value = startHarness(2, 1);
    const [aliceOne, aliceTwo] = await tokens(value, "alice", ["Alice one", "Alice two"]);
    const [bob] = await tokens(value, "bob", ["Bob"]);
    const [carol] = await tokens(value, "carol", ["Carol"]);
    const aliceGate = gate("http-alice");
    const bobGate = gate("http-bob");
    const heldAlice = rpc(value, "hold_ownership", { gate: "http-alice" }, aliceOne);
    const heldBob = rpc(value, "hold_ownership", { gate: "http-bob" }, bob);
    await Promise.all([aliceGate.started, bobGate.started]);

    expect(value.server.status()).toMatchObject({ httpIngress: 2, httpFairnessKeys: 2 });
    expect(value.runtime.status()).toMatchObject({
      activeOperations: 2,
      activeOperationCallers: 2,
    });
    const globallyRejected = await rpc(value, "ping_ownership", {}, carol);
    expect(globallyRejected.status).toBe(503);

    bobGate.release();
    expect((await heldBob).status).toBe(200);
    await eventually(() => value.runtime.status().activeOperations === 1);
    expect((await rpc(value, "ping_ownership", {}, carol)).status).toBe(200);
    const sameIdentity = await rpc(value, "ping_ownership", {}, aliceTwo);
    expect(sameIdentity.status).toBe(429);

    aliceGate.release();
    expect((await heldAlice).status).toBe(200);
    await expectIdle(value);

    const alicePrincipalOne = await value.runtime.authenticateMcpToken(
      ownershipMcp.name,
      aliceOne!,
      "authenticate-alice-one",
    );
    const alicePrincipalTwo = await value.runtime.authenticateMcpToken(
      ownershipMcp.name,
      aliceTwo!,
      "authenticate-alice-two",
    );
    const bobPrincipal = await value.runtime.authenticateMcpToken(
      ownershipMcp.name,
      bob!,
      "authenticate-bob",
    );
    const aliceKeyOne = callerFairnessKey(alicePrincipalOne, {
      family: "test",
      address: "one",
    });
    const aliceKeyTwo = callerFairnessKey(alicePrincipalTwo, {
      family: "other",
      address: "two",
    });
    expect(aliceKeyOne).toBe(aliceKeyTwo);
    const directGate = gate("direct-alice");
    const direct = value.runtime.runMcpTool({
      id: "direct-held",
      mcp: ownershipMcp.name,
      tool: "hold_ownership",
      args: { gate: "direct-alice" },
      principal: alicePrincipalOne,
      fairnessKey: aliceKeyOne,
    });
    await directGate.started;
    await expect(value.runtime.runMcpTool({
      id: "direct-hot",
      mcp: ownershipMcp.name,
      tool: "ping_ownership",
      args: {},
      principal: alicePrincipalTwo,
      fairnessKey: aliceKeyTwo,
    })).rejects.toMatchObject({ code: "overloaded", resource: "operation" });
    await expect(value.runtime.runMcpTool({
      id: "direct-cold",
      mcp: ownershipMcp.name,
      tool: "ping_ownership",
      args: {},
      principal: bobPrincipal,
      fairnessKey: callerFairnessKey(bobPrincipal, { family: "test", address: "bob" }),
    })).resolves.toMatchObject({ content: [{ text: "mcp" }] });
    directGate.release();
    await direct;
    await expectIdle(value);
  });

  test("keeps nested invocations and a transaction under one traced Runtime lease", async () => {
    const exported: TelemetryRecord[] = [];
    const value = startHarness(4, 2, {
      enabled: true,
      exporter: { export: (records) => void exported.push(...records) },
      localSink: false,
      limits: {
        ...PRODUCTION_LIMITS.telemetry,
        maxMetricSeries: 32,
        slowOperationMs: 0,
        sampleIntervalMs: 60_000,
        batchIntervalMs: 60_000,
      },
    });
    const [token] = await tokens(value, "nested", ["Nested"]);
    const transactionGate = gate("nested-transaction");
    const call = rpc(value, "nested_ownership_write", {
      value: "private-nested-value",
      gate: "nested-transaction",
      commit: true,
    }, token);
    await transactionGate.started;

    expect(value.server.status()).toMatchObject({ httpIngress: 1, httpFairnessKeys: 1 });
    expect(value.runtime.status()).toMatchObject({
      activeOperations: 1,
      activeOperationCallers: 1,
      writer: { active: 1, queue: { queuedItems: 0 } },
    });
    transactionGate.release();
    const response = await call;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      result: { content: [{ type: "text", text: "1" }] },
    });
    await expectIdle(value);

    await value.runtime.telemetry.flush();
    const spans = exported.filter((record) => record.kind === "span");
    const root = spans.find((span) =>
      span.function === "ownership:nested_ownership_write" && span.stage === "admission"
    );
    expect(root).toBeDefined();
    for (const fn of ["ownership.insertOwnershipRecord", "ownership.countOwnershipRecords"]) {
      const nested = spans.find((span) => span.function === fn && span.stage === "handler");
      expect(nested, fn).toBeDefined();
      expect(nested?.traceId, fn).toBe(root?.traceId);
    }
    const observed = JSON.stringify({
      exported,
      aggregates: value.runtime.status().telemetryAggregates,
      snapshot: value.runtime.status().telemetry,
    });
    expect(observed).not.toContain(token!);
    expect(observed).not.toContain("private-nested-value");
    expect(value.runtime.status().telemetryAggregates.series.length).toBeLessThanOrEqual(32);
  });

  test("cancels queued contention and preserves commit/rollback ownership", async () => {
    const value = startHarness(4, 2);
    const [alice] = await tokens(value, "contention-alice", ["Alice"]);
    const [bob] = await tokens(value, "contention-bob", ["Bob"]);
    const transactionGate = gate("writer-active");
    const committed = rpc(value, "nested_ownership_write", {
      value: "committed",
      gate: "writer-active",
      commit: true,
    }, alice);
    await transactionGate.started;

    const controller = new AbortController();
    const queued = rpc(value, "nested_ownership_write", {
      value: "cancelled",
      gate: null,
      commit: true,
    }, bob, controller.signal);
    await eventually(() => value.runtime.status().writer.queue.queuedItems === 1);
    expect(value.runtime.status()).toMatchObject({
      activeOperations: 2,
      activeOperationCallers: 2,
      writer: { active: 1, queue: { queuedItems: 1 } },
    });
    controller.abort("client disconnected while queued");
    await queued.then((response) => response.text()).catch(() => undefined);
    await eventually(() =>
      value.runtime.status().writer.queue.queuedItems === 0 &&
      value.runtime.status().activeOperations === 1
    );

    transactionGate.release();
    expect((await committed).status).toBe(200);
    const rolledBack = await rpc(value, "nested_ownership_write", {
      value: "rolled-back",
      gate: null,
      commit: false,
    }, alice);
    expect(rolledBack.status).toBe(200);
    expect(await rolledBack.json()).toMatchObject({ result: { isError: true } });
    expect(value.engine.reader.query("SELECT value FROM records ORDER BY id").all()).toEqual([
      { value: "committed" },
    ]);
    await expectIdle(value);
  });

  test("settles disconnect and graceful server shutdown through Runtime signals", async () => {
    const value = startHarness(4, 2);
    const directController = new AbortController();
    const directGate = gate("direct-disconnect");
    const direct = value.runtime.runMcpTool({
      id: "direct-disconnect",
      mcp: ownershipMcp.name,
      tool: "hold_ownership",
      args: { gate: "direct-disconnect" },
      principal: await user(value.runtime, "direct-disconnect"),
      signal: directController.signal,
    });
    await directGate.started;
    directController.abort("direct client disconnected");
    await expect(direct).rejects.toMatchObject({
      code: "indeterminate",
      message: "MCP tool completion is unknown after cancellation",
      resource: "operation",
    });

    const controller = new AbortController();
    const disconnectedGate = gate("disconnect");
    const disconnected = rpc(
      value,
      "hold_ownership",
      { gate: "disconnect" },
      undefined,
      controller.signal,
    );
    await disconnectedGate.started;
    expect(value.runtime.status()).toMatchObject({
      activeOperations: 1,
      activeOperationCallers: 1,
    });
    controller.abort("client disconnected");
    await Promise.all([
      disconnected.catch(() => undefined),
      disconnectedGate.aborted,
    ]);
    await expectIdle(value);

    const [token] = await tokens(value, "drain", ["Drain"]);
    const publicDrainGate = gate("graceful-public-drain");
    const authenticatedDrainGate = gate("graceful-authenticated-drain");
    const heldPublic = rpc(value, "hold_ownership", { gate: "graceful-public-drain" });
    const heldAuthenticated = rpc(
      value,
      "hold_ownership",
      { gate: "graceful-authenticated-drain" },
      token,
    );
    await Promise.all([publicDrainGate.started, authenticatedDrainGate.started]);
    expect(value.server.status()).toMatchObject({ httpIngress: 2, httpFairnessKeys: 2 });
    const draining = value.server.drain();
    expect(value.server.state).toBe("draining");
    expect(value.runtime.state).toBe("draining");
    const refused = await rpc(value, "ping_ownership", {}, token);
    expect(refused.status).toBe(503);

    publicDrainGate.release();
    authenticatedDrainGate.release();
    const [publicResponse, authenticatedResponse] = await Promise.all([
      heldPublic,
      heldAuthenticated,
      draining,
    ]);
    expect(publicResponse.status).toBe(200);
    expect(authenticatedResponse.status).toBe(200);
    expect(await publicResponse.json()).toMatchObject({
      result: { content: [{ text: "anonymous" }] },
    });
    expect(await authenticatedResponse.json()).toMatchObject({
      result: { content: [{ text: "mcp" }] },
    });
    expect(value.server.state).toBe("stopped");
    expect(value.runtime.state).toBe("stopped");
    await expectIdle(value);
  });

  test("bounds a stalled accepted exchange by the existing shutdown deadline", async () => {
    const value = startHarness();
    const deadlineGate = gate("shutdown-deadline");
    const held = rpc(value, "hold_ownership", { gate: "shutdown-deadline" });
    await deadlineGate.started;

    const startedAt = performance.now();
    const failure = await value.server.drain().then(
      () => undefined,
      (error: unknown) => error,
    );
    const elapsed = performance.now() - startedAt;

    expect(failure).toMatchObject({
      code: "deadline_exceeded",
      message: "runtime graceful shutdown deadline exceeded",
      resource: "operation",
    });
    await expect(deadlineGate.aborted).resolves.toMatchObject({ code: "deadline_exceeded" });
    expect(elapsed).toBeGreaterThanOrEqual(225);
    expect(elapsed).toBeLessThan(750);
    await held.then((response) => response.arrayBuffer()).catch(() => undefined);
    expect(value.server.state).toBe("failed");
    expect(value.runtime.state).toBe("failed");
    await expectIdle(value);
  });

  test("closes every stateless SDK exchange and leaves Runtime resources flat", async () => {
    const serverClose = spyOn(McpSdkServer.prototype, "close");
    const transportClose = spyOn(WebStandardStreamableHTTPServerTransport.prototype, "close");
    try {
      const value = startHarness();
      const port = value.server.port;
      const exchanges = 32;
      for (let index = 0; index < exchanges; index++) {
        const response = await rpc(value, "ping_ownership", {});
        expect(response.status).toBe(200);
        await response.arrayBuffer();
      }
      expect(value.server.port).toBe(port);
      expect(serverClose).toHaveBeenCalledTimes(exchanges);
      expect(transportClose).toHaveBeenCalledTimes(exchanges);
      expect(value.runtime.status()).toMatchObject({
        connections: 0,
        activeOperations: 0,
        activeOperationCallers: 0,
        activeSse: 0,
        schedulerArmed: false,
        reader: { active: 0, queue: { queuedItems: 0, queuedBytes: 0 } },
        writer: { active: 0, queue: { queuedItems: 0, queuedBytes: 0 } },
      });
      await expectIdle(value);
    } finally {
      serverClose.mockRestore();
      transportClose.mockRestore();
    }
  });
});
