import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@ackerdb/core";
import { ANONYMOUS_PRINCIPAL } from "../../src/auth/credentials.ts";
import { v } from "../../src/validation/v.ts";
import { Engine } from "../../src/database/engine.ts";
import { procedure, type ProcedureBuilder } from "../../src/app/functions.ts";
import { reconcile } from "../../src/schema/reconcile.ts";
import { Registry } from "../../src/app/registry.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import type { RuntimeHttpResponse } from "../../src/runtime/contracts/requests.ts";
import { defineSchema, defineTable } from "../../src/schema/definition.ts";
import { testHttpCodec } from "../support/http.ts";

// Cancellation ownership around `ctx.tx`: what a canceled request does to the
// writer transaction it owns, to a COMMIT that already reached durability, and
// to work still queued for the writer.

const schema = defineSchema({
  records: defineTable({
    id: v.primaryKey(),
    label: v.string(),
  }),
});

const typedProcedure = procedure as ProcedureBuilder<typeof schema>;

type Gate = ReturnType<typeof Promise.withResolvers<void>>;

let runtime: Runtime;
let engine: Engine;
let directory: string;
let entered: Map<string, Gate>;
let released: Map<string, Gate>;
let requestId: number;
let pauseAfterCommit: boolean;
let commitReached: Gate;
let releaseCommit: Gate;

/** Park inside the handler until the request is canceled or the test releases it. */
async function gate(key: string, signal: AbortSignal): Promise<void> {
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

const activeTransaction = typedProcedure({
  access: "public",
  http: true,
  args: {},
  handler: async (ctx) => {
    const done = await ctx.tx(async (tx) => {
      await tx.db.records.insert({ label: "active" });
      await gate("active", ctx.abortSignal);
    });
    if (!done.ok) throw new Error("active transaction failed");
    return { done: true };
  },
});

const committedTransaction = typedProcedure({
  access: "public",
  http: true,
  args: {},
  handler: async (ctx) => {
    const committed = await ctx.tx((tx) => tx.db.records.insert({ label: "committed" }));
    if (!committed.ok) throw new Error("committed transaction failed");
    return { done: true };
  },
});

const holdWriter = typedProcedure({
  access: "public",
  http: true,
  args: {},
  handler: async (ctx) => {
    const held = await ctx.tx(async (tx) => {
      await tx.db.records.insert({ label: "holder" });
      await gate("holder", ctx.abortSignal);
    });
    if (!held.ok) throw new Error("holder transaction failed");
    return { done: true };
  },
});

const queuedTransaction = typedProcedure({
  access: "public",
  http: true,
  args: {},
  handler: async (ctx) => {
    const queued = await ctx.tx((tx) => tx.db.records.insert({ label: "queued" }));
    if (!queued.ok) throw new Error("queued transaction failed");
    return { done: true };
  },
});

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "ackerdb-tx-cancellation-"));
  engine = new Engine(schema, join(directory, "data.db"));
  reconcile(engine);
  pauseAfterCommit = false;
  commitReached = Promise.withResolvers();
  releaseCommit = Promise.withResolvers();
  runtime = new Runtime({
    engine,
    registry: new Registry({
      tx: { activeTransaction, committedTransaction, holdWriter, queuedTransaction },
    }),
    hooks: {
      wait: async () => {
        if (!pauseAfterCommit) return;
        commitReached.resolve();
        await releaseCommit.promise;
      },
    },
  });
  await runtime.start();
  entered = new Map();
  released = new Map();
  requestId = 0;
  for (const key of ["active", "holder"]) {
    entered.set(key, Promise.withResolvers());
    released.set(key, Promise.withResolvers());
  }
});

afterEach(async () => {
  for (const release of released.values()) release.resolve();
  releaseCommit.resolve();
  await runtime.drain().catch(() => {});
  engine.close("clean");
  rmSync(directory, { recursive: true, force: true });
});

async function call(address: string, signal: AbortSignal): Promise<unknown> {
  const response = await runtime.runProcedure({
    id: ++requestId,
    address,
    args: {},
    codec: testHttpCodec,
    principal: ANONYMOUS_PRINCIPAL,
    signal,
    respond: ({ body, status }: RuntimeHttpResponse) => new Response(body, { status }),
  });
  return decode(await response.text());
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

test("rolls back an active transaction canceled before COMMIT", async () => {
  const controller = new AbortController();
  const active = call("api.tx.activeTransaction", controller.signal);
  await entered.get("active")!.promise;

  controller.abort(new Error("active transaction canceled"));
  released.get("active")!.resolve();

  expect(await active).toMatchObject({ code: "indeterminate" });
  expect(labels()).toEqual([]);
  expect(engine.writer.inTransaction).toBe(false);
});

test("keeps a durable COMMIT but suppresses its canceled result", async () => {
  pauseAfterCommit = true;
  const controller = new AbortController();
  const committed = call("api.tx.committedTransaction", controller.signal);
  await commitReached.promise;

  controller.abort(new Error("canceled after commit"));
  releaseCommit.resolve();

  expect(await committed).toMatchObject({ code: "indeterminate" });
  expect(labels()).toEqual(["committed"]);
  expect(engine.writer.inTransaction).toBe(false);
});

test("removes canceled writer work from the queue without disturbing its owner", async () => {
  const holder = call("api.tx.holdWriter", new AbortController().signal);
  await entered.get("holder")!.promise;

  const controller = new AbortController();
  const queued = call("api.tx.queuedTransaction", controller.signal);
  await eventually(() => runtime.status().writer.queue.queuedItems === 1);

  controller.abort(new Error("queued transaction canceled"));
  await eventually(() => runtime.status().writer.queue.queuedItems === 0);
  released.get("holder")!.resolve();

  expect(await holder).toEqual({ done: true });
  expect(await queued).toMatchObject({ code: "indeterminate" });
  expect(labels()).toEqual(["holder"]);
});
