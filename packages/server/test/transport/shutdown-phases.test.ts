/**
 * Two-phase shutdown: leaving readiness is separable from draining, so an owner
 * of application-owned resources can release them through `system.run`
 * while the Runtime is still live, and only then close system-run admission.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v } from "../../src/validation/v.ts";
import { Engine } from "../../src/database/engine.ts";
import { mutation, procedure } from "../../src/app/functions.ts";
import { defineServiceLimits, PRODUCTION_LIMITS } from "../../src/runtime/limits.ts";
import { reconcile } from "../../src/schema/reconcile.ts";
import { Registry } from "../../src/app/registry.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { defineSchema, defineTable } from "../../src/schema/definition.ts";
import { AckerDBServer } from "../../src/transport/server.ts";
import { deferred } from "ackerdb-test-support/async";

const limits = defineServiceLimits({ ...PRODUCTION_LIMITS, gracefulShutdownMs: 500 });

const schema = defineSchema({
  notes: defineTable({ id: v.primaryKey(), body: v.string() }),
});

// Transport ownership tests do not exercise generated application types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

let blockedStarted: { promise: Promise<void>; resolve: () => void } | null = null;
let blockedRelease: { promise: Promise<void>; resolve: () => void } | null = null;

const modules = {
  notes: {
    add: mutation({
      access: "public",
      http: true,
      args: { body: v.string() },
      handler: (ctx: Ctx, args: Ctx) => ctx.db.notes.insert(args),
    }),
    block: procedure({
      access: "public",
      http: true,
      args: {},
      handler: async () => {
        blockedStarted?.resolve();
        await blockedRelease?.promise;
        return "released";
      },
    }),
  },
};

let dir: string;
let engine: Engine;
let runtime: Runtime;
let server: AckerDBServer;
let base: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "ackerdb-shutdown-"));
  engine = new Engine(schema, join(dir, "data.db"));
  await reconcile(engine, []);
  server = new AckerDBServer({ limits, port: 0 });
  runtime = new Runtime({ engine, registry: new Registry(modules), limits });
  await runtime.start();
  server.activate(runtime);
  base = `http://127.0.0.1:${server.port}`;
});

afterEach(async () => {
  await server.drain().catch(() => {});
  await runtime.drain().catch(() => {});
  engine.close("clean");
  rmSync(dir, { recursive: true, force: true });
});

test("beginShutdown leaves readiness while liveness and system authority remain", async () => {
  expect((await (await fetch(`${base}/ready`)).json()).ready).toBe(true);

  server.beginShutdown();

  expect(server.state).toBe("draining");
  expect(runtime.status().state).toBe("ready");

  const live = await (await fetch(`${base}/live`)).json();
  expect(live).toMatchObject({ live: true });
  const ready = await (await fetch(`${base}/ready`)).json();
  expect(ready).toMatchObject({ ready: false, state: "draining" });

  // The whole point of the phase: trusted work still runs and commits.
  const written = await runtime.system.run("shutdown.cleanup", (ctx) =>
    ctx.tx((tx: Ctx) => tx.db.notes.insert({ body: "flushed" })));
  expect(written).toMatchObject({ ok: true });
  expect(engine.writer.query("SELECT body FROM notes").all()).toEqual([{ body: "flushed" }]);
});

test("beginShutdown rejects new transport work with the draining outcome", async () => {
  server.beginShutdown();

  const response = await fetch(`${base}/api/notes/add`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body: "late" }),
  });

  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    code: "draining",
    retryable: true,
    retryAfterMs: 1_000,
  });
});

test("beginShutdown is idempotent and does not drain by itself", async () => {
  server.beginShutdown();
  server.beginShutdown();

  await Bun.sleep(20);
  expect(server.state).toBe("draining");
  expect(runtime.status().state).toBe("ready");

  await server.drain();
  expect(server.state).toBe("stopped");
  expect(runtime.status().state).toBe("stopped");
});

test("drain honours a caller-owned deadline instead of its configured window", async () => {
  blockedStarted = deferred();
  blockedRelease = deferred();
  const stalled = fetch(`${base}/api/notes/block`, { method: "POST" }).catch(() => undefined);
  await blockedStarted.promise;

  // The caller owns the budget: 60ms, not the server's configured 500ms.
  const startedAt = performance.now();
  const failure = await server.drain(Date.now() + 60).then(
    () => undefined,
    (error: unknown) => error,
  );
  const elapsed = performance.now() - startedAt;

  // The Runtime observes the same budget, so whichever layer reports first
  // reports the caller's deadline rather than the configured window.
  expect(failure).toMatchObject({ code: "deadline_exceeded" });
  expect(elapsed).toBeLessThan(limits.gracefulShutdownMs);
  blockedRelease.resolve();
  await stalled;
});

test("drain refuses a non-finite deadline", () => {
  expect(() => server.drain(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  expect(server.state).toBe("ready");
});

test("drain without beginShutdown behaves as a single-call shutdown", async () => {
  const draining = server.drain();
  expect(server.state).toBe("draining");
  expect(runtime.status().state).toBe("draining");
  await draining;
  expect(server.state).toBe("stopped");
});

test("beginShutdown after drain has started is a no-op", async () => {
  const draining = server.drain();
  server.beginShutdown();
  await draining;
  expect(server.state).toBe("stopped");
  server.beginShutdown();
  expect(server.state).toBe("stopped");
});

test("activation is refused once shutdown has begun", () => {
  const other = new AckerDBServer({ limits, port: 0 });
  other.beginShutdown();
  expect(() => other.activate(runtime)).toThrow("server can only be activated once while starting");
  void other.drain().catch(() => {});
});
