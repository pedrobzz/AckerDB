/**
 * The Runtime's explicit lifecycle: constructed means created — it admits
 * nothing and arms nothing — and `start()` is what makes it ready. A host holds
 * a fully constructed but quiescent runtime until it says otherwise.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v } from "../../src/validation/v.ts";
import { Engine } from "../../src/database/engine.ts";
import { procedure } from "../../src/app/functions.ts";
import { declareJobs, job } from "../../src/jobs/definition.ts";
import { JOBS_TABLE } from "../../src/jobs/table.ts";
import { defineServiceLimits, PRODUCTION_LIMITS } from "../../src/runtime/limits.ts";
import { reconcile } from "../../src/schema/reconcile.ts";
import { Registry } from "../../src/app/registry.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { defineSchema, defineTable } from "../../src/schema/definition.ts";
import { AckerDBServer } from "../../src/transport/server.ts";
import { AckerDBError } from "../../src/shared/errors.ts";

const limits = defineServiceLimits({ ...PRODUCTION_LIMITS, gracefulShutdownMs: 500 });

const schema = defineSchema({
  notes: defineTable({ id: v.primaryKey(), body: v.string() }),
});

const modules = {
  notes: {
    ping: procedure({
      access: "public",
      args: {},
      handler: () => "pong",
    }),
  },
};

const jobs = declareJobs({
  beat: {
    tick: job({
      args: {},
      repeat: (now: number) => now + 60_000,
      handler: () => undefined,
    }),
  },
});

let dir: string;
let engine: Engine;
let runtime: Runtime;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "ackerdb-lifecycle-"));
  engine = new Engine(schema, join(dir, "data.db"));
  await reconcile(engine, []);
  runtime = new Runtime({ engine, registry: new Registry(modules), limits, jobs });
});

afterEach(async () => {
  await runtime.drain().catch(() => {});
  engine.close("clean");
  rmSync(dir, { recursive: true, force: true });
});

function jobRows(): number {
  return Number((engine.reader.query(`SELECT COUNT(*) AS count FROM ${JOBS_TABLE}`).get() as { count: number | bigint }).count);
}

test("a constructed Runtime is created: it refuses operations and arms nothing", async () => {
  expect(runtime.state).toBe("created");
  expect(runtime.status().jobsArmed).toBe(false);
  expect(jobRows()).toBe(0);

  const refused = await runtime.system.run("test.created", async () => "ran").catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(AckerDBError);
  expect((refused as AckerDBError).code).toBe("unavailable");

  const server = new AckerDBServer({ limits, port: 0 });
  try {
    expect(() => server.activate(runtime)).toThrow("Runtime must be ready before activation");
  } finally {
    await server.drain().catch(() => {});
  }
});

test("start() makes it ready: repeat jobs are minted, the runner is armed, operations run", async () => {
  await runtime.start();
  expect(runtime.state).toBe("ready");
  expect(jobRows()).toBe(1);
  expect(runtime.status().jobsArmed).toBe(true);
  await expect(runtime.system.run("test.ready", async () => "ran")).resolves.toBe("ran");

  const server = new AckerDBServer({ limits, port: 0 });
  server.activate(runtime);
  expect((await (await fetch(`http://127.0.0.1:${server.port}/ready`)).json()).ready).toBe(true);
  await server.drain();
});

test("start() twice is misuse", async () => {
  await runtime.start();
  await expect(runtime.start()).rejects.toThrow("Runtime.start() requires a created Runtime");
});

test("a created Runtime drains cleanly without ever having started", async () => {
  await runtime.drain();
  expect(runtime.state).toBe("stopped");
  expect(jobRows()).toBe(0);
  await expect(runtime.start()).rejects.toThrow("Runtime.start() requires a created Runtime");
});

test("a failed jobs bootstrap fails start()", async () => {
  const failing = new Runtime({
    engine,
    registry: new Registry(modules),
    limits,
    jobs: declareJobs({
      beat: {
        tick: job({
          args: {},
          repeat: () => {
            throw new Error("repeat policy exploded");
          },
          handler: () => undefined,
        }),
      },
    }),
  });
  try {
    await expect(failing.start()).rejects.toThrow("repeat policy exploded");
    expect(failing.state).not.toBe("ready");
  } finally {
    await failing.drain().catch(() => {});
  }
});
