import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode, parseCallResponse } from "@dbzz/core";
import { ANONYMOUS_PRINCIPAL } from "../../src/auth/credentials.ts";
import { v } from "../../src/validation/v.ts";
import { Engine } from "../../src/database/engine.ts";
import { procedure, type ProcedureBuilder } from "../../src/app/functions.ts";
import {
  createMcp,
  mcpTool,
  type McpBuilder,
  type McpToolBuilder,
  type McpToolCtx,
} from "../../src/mcp/index.ts";
import { reconcile } from "../../src/schema/reconcile.ts";
import { Registry } from "../../src/app/registry.ts";
import { Runtime, type RuntimeProcedureResponse } from "../../src/runtime/runtime.ts";
import { defineSchema, defineTable } from "../../src/schema/definition.ts";

const schema = defineSchema({
  records: defineTable({
    id: v.primaryKey(),
    label: v.string(),
  }),
});

const typedProcedure = procedure as ProcedureBuilder<typeof schema>;
const typedMcp = createMcp as McpBuilder<typeof schema>;
const typedMcpTool = mcpTool as McpToolBuilder<typeof schema>;

type Gate = ReturnType<typeof Promise.withResolvers<void>>;

interface ExecutionControllers {
  readonly active: AbortController;
  readonly canceled: AbortController;
  readonly committed: AbortController;
  readonly encoding: AbortController;
  readonly nested: AbortController;
  readonly parent: AbortController;
  readonly queued: AbortController;
  readonly sibling: AbortController;
}

let runtime: Runtime;
let engine: Engine;
let directory: string;
let executionControllers: ExecutionControllers;
let entered: Map<string, Gate>;
let released: Map<string, Gate>;
let observedSignals: Map<string, AbortSignal>;
let parentSignal: AbortSignal | undefined;
let requestId: number;
let pauseAfterCommit: boolean;
let commitReached: Gate;
let releaseCommit: Gate;

function resetGate(key: string): void {
  entered.set(key, Promise.withResolvers());
  released.set(key, Promise.withResolvers());
}

async function gate(key: string, signal: AbortSignal): Promise<void> {
  observedSignals.set(key, signal);
  entered.get(key)!.resolve();
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const aborted = () => resolve();
    signal.addEventListener("abort", aborted, { once: true });
    void released.get(key)!.promise.then(() => {
      signal.removeEventListener("abort", aborted);
      resolve();
    });
  });
}

function outcome(result: PromiseSettledResult<unknown>): { status: string; value?: unknown } {
  return result.status === "fulfilled"
    ? { status: "fulfilled", value: result.value }
    : { status: "rejected" };
}

const wait = typedMcpTool({
  description: "Wait for cancellation or an explicit test release.",
  args: { key: v.string() },
  output: v.object({ key: v.string() }),
  handler: async (ctx, args) => {
    await gate(args.key, ctx.abortSignal);
    return { key: args.key };
  },
});

async function handleNestedWait(ctx: McpToolCtx<typeof schema>): Promise<{ done: boolean }> {
  await agentMcp.aiTools(ctx).wait!.execute({ key: "nested" });
  return { done: true };
}

const nestedWait = typedMcpTool({
  description: "Delegate to another local MCP tool.",
  args: {},
  output: v.object({ done: v.boolean() }),
  handler: handleNestedWait,
});

const activeTransaction = typedMcpTool({
  description: "Hold an active writer transaction until cancellation.",
  args: {},
  output: v.object({ done: v.boolean() }),
  handler: async (ctx) => {
    await ctx.tx(async (tx) => {
      await tx.db.records.insert({ label: "active" });
      await gate("active", ctx.abortSignal);
    });
    return { done: true };
  },
});

const committedTransaction = typedMcpTool({
  description: "Commit before cancellation suppresses the local result.",
  args: {},
  output: v.object({ done: v.boolean() }),
  handler: async (ctx) => {
    await ctx.tx((tx) => tx.db.records.insert({ label: "committed" }));
    return { done: true };
  },
});

const holdWriter = typedMcpTool({
  description: "Own the writer until explicitly released.",
  args: {},
  output: v.object({ done: v.boolean() }),
  handler: async (ctx) => {
    await ctx.tx(async (tx) => {
      await tx.db.records.insert({ label: "holder" });
      await gate("holder", ctx.abortSignal);
    });
    return { done: true };
  },
});

const queuedTransaction = typedMcpTool({
  description: "Enter the writer queue before inserting.",
  args: {},
  output: v.object({ done: v.boolean() }),
  handler: async (ctx) => {
    await ctx.tx((tx) => tx.db.records.insert({ label: "queued" }));
    return { done: true };
  },
});

const encodingCancellation = typedMcpTool({
  description: "Cancel while the structured result is encoded.",
  args: {},
  output: v.object({ value: v.string() }),
  handler: () => ({
    get value() {
      executionControllers.encoding.abort(new Error("generation canceled during encoding"));
      return "encoded";
    },
  }),
});

const agentMcp = typedMcp({
  name: "agent",
  path: "/mcp",
  tools: {
    active_transaction: activeTransaction,
    committed_transaction: committedTransaction,
    encoding_cancellation: encodingCancellation,
    hold_writer: holdWriter,
    nested_wait: nestedWait,
    queued_transaction: queuedTransaction,
    wait,
  },
});

const runLocal = typedProcedure({
  access: "public",
  args: { mode: v.string() },
  handler: async (ctx, args) => {
    parentSignal = ctx.abortSignal;
    const tools = agentMcp.aiTools(ctx);
    switch (args.mode) {
      case "siblings": {
        const results = await Promise.allSettled([
          tools.wait!.execute(
            { key: "canceled" },
            { abortSignal: executionControllers.canceled.signal },
          ),
          tools.wait!.execute(
            { key: "sibling" },
            { abortSignal: executionControllers.sibling.signal },
          ),
        ]);
        return results.map(outcome);
      }
      case "nested":
        return outcome(await Promise.allSettled([
          tools.nested_wait!.execute(
            {},
            { abortSignal: executionControllers.nested.signal },
          ),
        ]).then(([result]) => result!));
      case "active":
        return outcome(await Promise.allSettled([
          tools.active_transaction!.execute(
            {},
            { abortSignal: executionControllers.active.signal },
          ),
        ]).then(([result]) => result!));
      case "committed":
        return outcome(await Promise.allSettled([
          tools.committed_transaction!.execute(
            {},
            { abortSignal: executionControllers.committed.signal },
          ),
        ]).then(([result]) => result!));
      case "queued": {
        const holder = tools.hold_writer!.execute({});
        await entered.get("holder")!.promise;
        const queued = tools.queued_transaction!.execute(
          {},
          { abortSignal: executionControllers.queued.signal },
        );
        return (await Promise.allSettled([holder, queued])).map(outcome);
      }
      case "encoding":
        return outcome(await Promise.allSettled([
          tools.encoding_cancellation!.execute(
            {},
            { abortSignal: executionControllers.encoding.signal },
          ),
        ]).then(([result]) => result!));
      case "parent":
        return tools.wait!.execute(
          { key: "parent" },
          { abortSignal: executionControllers.parent.signal },
        );
      default:
        throw new Error(`unknown cancellation fixture ${args.mode}`);
    }
  },
});

const modules = {
  app: { runLocal },
  mcp: { agentMcp },
  tools: {
    activeTransaction,
    committedTransaction,
    encodingCancellation,
    holdWriter,
    nestedWait,
    queuedTransaction,
    wait,
  },
};

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "dbzz-mcp-cancellation-"));
  engine = new Engine(schema, join(directory, "data.db"));
  reconcile(engine);
  pauseAfterCommit = false;
  commitReached = Promise.withResolvers();
  releaseCommit = Promise.withResolvers();
  runtime = new Runtime({
    engine,
    registry: new Registry(modules),
    telemetry: false,
    hooks: {
      wait: async () => {
        if (!pauseAfterCommit) return;
        commitReached.resolve();
        await releaseCommit.promise;
      },
    },
  });
  executionControllers = {
    active: new AbortController(),
    canceled: new AbortController(),
    committed: new AbortController(),
    encoding: new AbortController(),
    nested: new AbortController(),
    parent: new AbortController(),
    queued: new AbortController(),
    sibling: new AbortController(),
  };
  entered = new Map();
  released = new Map();
  observedSignals = new Map();
  parentSignal = undefined;
  requestId = 0;
  for (const key of ["active", "canceled", "holder", "nested", "parent", "sibling"]) {
    resetGate(key);
  }
});

afterEach(async () => {
  for (const release of released.values()) release.resolve();
  releaseCommit.resolve();
  await runtime.drain().catch(() => {});
  engine.close("clean");
  rmSync(directory, { recursive: true, force: true });
});

async function callProcedure(mode: string, signal?: AbortSignal): Promise<unknown> {
  const response = await runtime.runProcedure({
    id: ++requestId,
    address: "app.runLocal",
    args: { mode },
    principal: ANONYMOUS_PRINCIPAL,
    ...(signal === undefined ? {} : { signal }),
    respond: ({ body, status }: RuntimeProcedureResponse) => new Response(body, { status }),
  });
  const frame = parseCallResponse(decode(await response.text()));
  if (frame.t !== "ok") {
    const error = frame.t === "err"
      ? frame.outcome
      : { message: frame.error.code, code: frame.error.code };
    throw Object.assign(new Error(error.message), error);
  }
  return frame.value;
}

async function eventually(check: () => boolean): Promise<void> {
  for (let attempts = 0; !check(); attempts++) {
    if (attempts === 100) throw new Error("condition did not become true");
    await Bun.sleep(0);
  }
}

function labels(): string[] {
  return (engine.reader.query('SELECT "label" FROM "records" ORDER BY "id"').all() as {
    label: string;
  }[]).map(({ label }) => label);
}

describe("MCP local cancellation ownership", () => {
  test("combines each AI execution signal with its parent and isolates siblings", async () => {
    const call = callProcedure("siblings");
    await Promise.all([
      entered.get("canceled")!.promise,
      entered.get("sibling")!.promise,
    ]);

    executionControllers.canceled.abort(new Error("one generation canceled"));
    released.get("canceled")!.resolve();
    released.get("sibling")!.resolve();

    expect(await call).toEqual([
      { status: "rejected" },
      { status: "fulfilled", value: { key: "sibling" } },
    ]);
    expect(observedSignals.get("canceled")).not.toBe(parentSignal);
    expect(observedSignals.get("sibling")).not.toBe(observedSignals.get("canceled"));
    expect(observedSignals.get("canceled")?.aborted).toBe(true);
    expect(observedSignals.get("sibling")?.aborted).toBe(false);
  });

  test("propagates cancellation through nested local calls", async () => {
    const nested = callProcedure("nested");
    await entered.get("nested")!.promise;
    executionControllers.nested.abort(new Error("nested generation canceled"));
    released.get("nested")!.resolve();
    expect(await nested).toEqual({ status: "rejected" });
    expect(observedSignals.get("nested")?.aborted).toBe(true);
  });

  test("rolls back an active transaction canceled before COMMIT", async () => {
    const active = callProcedure("active");
    await entered.get("active")!.promise;
    executionControllers.active.abort(new Error("active transaction canceled"));
    released.get("active")!.resolve();
    expect(await active).toEqual({ status: "rejected" });
    expect(labels()).toEqual([]);
    expect(engine.writer.inTransaction).toBe(false);
  });

  test("keeps a durable COMMIT but suppresses its canceled local result", async () => {
    pauseAfterCommit = true;
    const call = callProcedure("committed");
    await commitReached.promise;
    executionControllers.committed.abort(new Error("generation canceled after commit"));
    releaseCommit.resolve();

    expect(await call).toEqual({ status: "rejected" });
    expect(labels()).toEqual(["committed"]);
    expect(engine.writer.inTransaction).toBe(false);
  });

  test("removes canceled writer work from the queue without disturbing its owner", async () => {
    const call = callProcedure("queued");
    await eventually(() => runtime.status().writer.queue.queuedItems === 1);

    executionControllers.queued.abort(new Error("queued transaction canceled"));
    await Bun.sleep(0);
    const queuedItemsAfterCancellation = runtime.status().writer.queue.queuedItems;
    released.get("holder")!.resolve();

    const result = await call;
    expect(queuedItemsAfterCancellation).toBe(0);
    expect(result).toEqual([
      { status: "fulfilled", value: { done: true } },
      { status: "rejected" },
    ]);
    expect(labels()).toEqual(["holder"]);
  });

  test("suppresses encoding-time results and inherits parent cancellation", async () => {
    expect(await callProcedure("encoding")).toEqual({ status: "rejected" });

    const parent = new AbortController();
    const call = callProcedure("parent", parent.signal);
    await entered.get("parent")!.promise;
    parent.abort(new Error("parent request canceled"));
    await expect(call).rejects.toMatchObject({
      code: "indeterminate",
      message: "procedure completion is unknown after cancellation",
      resource: "operation",
    });
    expect(observedSignals.get("parent")?.aborted).toBe(true);
  });
});
