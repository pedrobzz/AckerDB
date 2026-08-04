/**
 * The jobs feature at the Runtime seam: a real Engine and Runtime over a real
 * database file, an injected clock, and job definitions declared per test
 * app. Everything is observed through public surfaces — enqueue/run/wait
 * outcomes, `_ackerdb_jobs` rows, and lifecycle effects — never through
 * runner internals.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../../src/database/engine.ts";
import { reconcile } from "../../src/schema/reconcile.ts";
import { defineSchema, defineTable } from "../../src/schema/definition.ts";
import { v } from "../../src/validation/v.ts";
import { Registry } from "../../src/app/registry.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { PRODUCTION_LIMITS, type ServiceLimits } from "../../src/runtime/limits.ts";
import { declareJobs, job, type DeclaredJob } from "../../src/jobs/definition.ts";
import { JOBS_TABLE } from "../../src/jobs/table.ts";
import { mutation } from "../../src/app/functions.ts";
import { ANONYMOUS_PRINCIPAL } from "../../src/auth/credentials.ts";

// Tests exercise runtime ownership, not generated application types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

const schema = defineSchema({
  log: defineTable({ id: v.primaryKey(), line: v.string() }),
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let directory: string;
let engine: Engine;
let runtime: Runtime;
let clock: number;

const directories: string[] = [];

function limits(overrides: Partial<ServiceLimits["jobs"]> = {}): ServiceLimits {
  return {
    ...PRODUCTION_LIMITS,
    jobs: { ...PRODUCTION_LIMITS.jobs, ...overrides },
  };
}

function start(
  jobs: DeclaredJob[],
  customLimits = limits(),
  functions: Record<string, Record<string, unknown>> = {},
): void {
  directory = mkdtempSync(join(tmpdir(), "ackerdb-jobs-"));
  directories.push(directory);
  engine = new Engine(schema, join(directory, "data.db"));
  reconcile(engine);
  runtime = new Runtime({
    engine,
    registry: new Registry(functions),
    telemetry: false,
    limits: customLimits,
    jobs,
    now: () => clock,
  });
}

/** Reopen the same database file with a fresh Runtime: the restart seam. */
async function restart(jobs: DeclaredJob[], customLimits = limits()): Promise<void> {
  await runtime.drain().catch(() => {});
  engine.close("clean");
  engine = new Engine(schema, join(directory, "data.db"));
  reconcile(engine);
  runtime = new Runtime({
    engine,
    registry: new Registry({}),
    telemetry: false,
    limits: customLimits,
    jobs,
    now: () => clock,
  });
}

function jobRows(): Array<{
  id: bigint;
  name: string;
  state: string;
  runAt: number;
  attempt: bigint;
  key: string | null;
  attemptsJson: string;
}> {
  return engine.reader
    .query(`SELECT id, name, state, runAt, attempt, key, attemptsJson FROM "${JOBS_TABLE}" ORDER BY id`)
    .all() as never;
}

afterEach(async () => {
  await runtime?.drain().catch(() => {});
  engine?.close("clean");
  while (directories.length > 0) {
    rmSync(directories.pop()!, { recursive: true, force: true });
  }
});

describe("procedure-kind jobs", () => {
  test("claims, runs the handler as a system operation, and settles the outcome", async () => {
    clock = 1_000_000;
    const seen: unknown[] = [];
    start(declareJobs({
      work: {
        greet: job({
          args: { who: v.string() },
          handler: async (ctx: Ctx, args: Ctx) => {
            seen.push({ attempt: ctx.attempt, who: args.who });
            const written = await ctx.tx((tx: Ctx) => tx.db.log.insert({ line: `hi ${args.who}` }));
            expect(written.ok).toBe(true);
            return { greeting: `hi ${args.who}` };
          },
        }),
      },
    }));

    const handle = await runtime.jobs.enqueue("work.greet", { who: "ana" });
    expect(handle.deduped).toBe(false);
    const wait = runtime.jobs.wait(handle.id);
    await runtime.runJobs();
    const outcome = await wait;
    expect(outcome).toEqual({ ok: true, value: { greeting: "hi ana" } });
    expect(seen).toEqual([{ attempt: 1, who: "ana" }]);
    expect(jobRows()).toMatchObject([{ state: "completed", attempt: 1n }]);
    expect(engine.reader.query('SELECT line FROM "log"').all()).toEqual([{ line: "hi ana" }]);

    // A terminal row answers waiters immediately from its recorded output.
    expect(await runtime.jobs.wait(handle.id)).toEqual({ ok: true, value: { greeting: "hi ana" } });
  });

  test("a failed attempt reports nextRetryAt and retries on schedule", async () => {
    clock = 2_000_000;
    let attempts = 0;
    start(declareJobs({
      work: {
        flaky: job({
          args: {},
          retry: (attempt: number) => (attempt < 3 ? attempt * 1_000 : null),
          handler: async () => {
            attempts++;
            if (attempts < 3) throw new Error(`boom ${attempts}`);
            return "recovered";
          },
        }),
      },
    }));

    const handle = await runtime.jobs.enqueue("work.flaky", {});
    const first = runtime.jobs.wait(handle.id);
    await runtime.runJobs();
    expect(await first).toMatchObject({ ok: false, state: "pending", nextRetryAt: 2_001_000 });
    expect(jobRows()).toMatchObject([{ state: "pending", attempt: 1n, runAt: 2_001_000 }]);

    // Not due yet: nothing runs.
    await runtime.runJobs();
    expect(attempts).toBe(1);

    clock = 2_001_000;
    const second = runtime.jobs.wait(handle.id);
    await runtime.runJobs();
    expect(await second).toMatchObject({ ok: false, state: "pending", nextRetryAt: 2_003_000 });

    clock = 2_003_000;
    const third = runtime.jobs.wait(handle.id);
    await runtime.runJobs();
    expect(await third).toEqual({ ok: true, value: "recovered" });
    const history = JSON.parse(jobRows()[0]!.attemptsJson) as Array<{ outcome: string }>;
    expect(history.map((entry) => entry.outcome)).toEqual(["failed", "failed", "completed"]);
  });

  test("exhausted retries discard with the error recorded, and retryNow revives", async () => {
    clock = 3_000_000;
    let runs = 0;
    start(declareJobs({
      work: {
        doomed: job({
          args: {},
          handler: async () => {
            runs++;
            throw new Error("always fails");
          },
        }),
      },
    }));

    const handle = await runtime.jobs.enqueue("work.doomed", {});
    const wait = runtime.jobs.wait(handle.id);
    await runtime.runJobs();
    expect(await wait).toMatchObject({ ok: false, state: "discarded", nextRetryAt: null });
    expect(jobRows()).toMatchObject([{ state: "discarded" }]);
    expect(jobRows()[0]!.attemptsJson).toContain("always fails");

    // The sanctioned transition re-runs a settled row, keeping its history.
    await runtime.jobs.retryNow(handle.id);
    expect(jobRows()).toMatchObject([{ state: "pending", attempt: 1n }]);
    const second = runtime.jobs.wait(handle.id);
    await runtime.runJobs();
    await second;
    expect(runs).toBe(2);
    const history = JSON.parse(jobRows()[0]!.attemptsJson) as unknown[];
    expect(history).toHaveLength(2);
  });

  test("cancel aborts a running handler cooperatively and discards its result", async () => {
    clock = 4_000_000;
    const started = deferred<void>();
    const finish = deferred<string>();
    let abortedInHandler = false;
    start(declareJobs({
      work: {
        slow: job({
          args: {},
          handler: async (ctx: Ctx) => {
            started.resolve(undefined);
            ctx.abortSignal.addEventListener("abort", () => {
              abortedInHandler = true;
            });
            return await finish.promise;
          },
        }),
      },
    }));

    const handle = await runtime.jobs.enqueue("work.slow", {});
    const wait = runtime.jobs.wait(handle.id);
    await runtime.runJobs();
    await started.promise;
    expect(jobRows()).toMatchObject([{ state: "running" }]);

    expect(await runtime.jobs.cancel(handle.id)).toBe("canceled");
    expect(await wait).toMatchObject({ ok: false, state: "canceled" });
    expect(abortedInHandler).toBe(true);
    expect(jobRows()).toMatchObject([{ state: "canceled" }]);

    // The late result self-discards on the stale lease: still canceled.
    finish.resolve("too late");
    await Bun.sleep(10);
    expect(jobRows()).toMatchObject([{ state: "canceled" }]);
    // Cancel on a terminal row is a no-op reporting the state.
    expect(await runtime.jobs.cancel(handle.id)).toBe("canceled");
  });
});

describe("dedup and memoization", () => {
  test("in-flight dedup collapses equal args into one row; fresh args run fresh", async () => {
    clock = 5_000_000;
    start(declareJobs({
      work: {
        send: job({
          args: { to: v.string() },
          dedupe: "inflight",
          handler: async (_ctx: Ctx, args: Ctx) => `sent:${args.to}`,
        }),
      },
    }));

    const first = await runtime.jobs.enqueue("work.send", { to: "a" }, { delayMs: 60_000 });
    const duplicate = await runtime.jobs.enqueue("work.send", { to: "a" });
    const different = await runtime.jobs.enqueue("work.send", { to: "b" });
    expect(duplicate).toEqual({ id: first.id, deduped: true });
    expect(different.deduped).toBe(false);
    expect(jobRows()).toHaveLength(2);

    // Two awaiters of the deduped row observe one settle.
    clock = 5_060_000;
    const [one, two] = [runtime.jobs.wait(first.id), runtime.jobs.wait(first.id)];
    await runtime.runJobs();
    expect(await one).toEqual({ ok: true, value: "sent:a" });
    expect(await two).toEqual({ ok: true, value: "sent:a" });

    // The completed row does not dedupe (no window): a new call runs fresh.
    const again = await runtime.jobs.enqueue("work.send", { to: "a" });
    expect(again.deduped).toBe(false);
  });

  test("a completed window memoizes; expiry and failure windows behave per outcome", async () => {
    clock = 6_000_000;
    let runs = 0;
    start(declareJobs({
      work: {
        memo: job({
          args: { key: v.string() },
          dedupe: { completed: 10_000 },
          handler: async (_ctx: Ctx, args: Ctx) => {
            runs++;
            return `${args.key}:${runs}`;
          },
        }),
      },
    }));

    const first = await runtime.jobs.enqueue("work.memo", { key: "x" });
    const wait = runtime.jobs.wait(first.id);
    await runtime.runJobs();
    expect(await wait).toEqual({ ok: true, value: "x:1" });

    // Inside the window: the same call returns the recorded outcome, no run.
    const memoized = await runtime.jobs.enqueue("work.memo", { key: "x" });
    expect(memoized).toEqual({ id: first.id, deduped: true });
    expect(await runtime.jobs.wait(memoized.id)).toEqual({ ok: true, value: "x:1" });
    expect(runs).toBe(1);

    // Past the window: a fresh run.
    clock = 6_010_001;
    const fresh = await runtime.jobs.enqueue("work.memo", { key: "x" });
    expect(fresh.deduped).toBe(false);
    await runtime.runJobs();
    expect(runs).toBe(2);
  });
});

describe("concurrency", () => {
  test("per-key concurrency serializes one key while other keys run in parallel", async () => {
    clock = 7_000_000;
    const running = new Set<string>();
    let maxPerKey = 0;
    let totalConcurrent = 0;
    const gates = new Map<string, Deferred<void>>();
    start(declareJobs({
      carts: {
        process: job({
          args: { cart: v.string(), step: v.int() },
          key: (args: Ctx) => args.cart,
          concurrency: 1,
          handler: async (_ctx: Ctx, args: Ctx) => {
            const label = `${args.cart}:${args.step}`;
            running.add(args.cart);
            maxPerKey = Math.max(maxPerKey, [...running].filter((c) => c === args.cart).length);
            totalConcurrent = Math.max(totalConcurrent, running.size);
            const gate = deferred<void>();
            gates.set(label, gate);
            await gate.promise;
            running.delete(args.cart);
            return label;
          },
        }),
      },
    }));

    await runtime.jobs.enqueue("carts.process", { cart: "a", step: 1 });
    await runtime.jobs.enqueue("carts.process", { cart: "a", step: 2 });
    await runtime.jobs.enqueue("carts.process", { cart: "b", step: 1 });
    await runtime.runJobs();
    await Bun.sleep(10);

    // One per key: a:1 and b:1 run; a:2 waits behind its key.
    expect(gates.has("a:1")).toBe(true);
    expect(gates.has("b:1")).toBe(true);
    expect(gates.has("a:2")).toBe(false);
    expect(totalConcurrent).toBe(2);

    gates.get("a:1")!.resolve(undefined);
    await Bun.sleep(10);
    await runtime.runJobs();
    await Bun.sleep(10);
    expect(gates.has("a:2")).toBe(true);
    gates.get("b:1")!.resolve(undefined);
    gates.get("a:2")!.resolve(undefined);
    await Bun.sleep(10);
    expect(maxPerKey).toBe(1);
  });

  test("the global running cap bounds simultaneous handlers", async () => {
    clock = 8_000_000;
    let peak = 0;
    let active = 0;
    const gate = deferred<void>();
    start(declareJobs({
      work: {
        fan: job({
          args: { n: v.int() },
          concurrency: 100,
          handler: async () => {
            active++;
            peak = Math.max(peak, active);
            await gate.promise;
            active--;
          },
        }),
      },
    }), limits({ maxRunning: 2 }));

    for (let index = 0; index < 5; index++) {
      await runtime.jobs.enqueue("work.fan", { n: index });
    }
    await runtime.runJobs();
    await Bun.sleep(10);
    expect(peak).toBe(2);
    gate.resolve(undefined);
  });
});

describe("recurrence", () => {
  test("repeat mints the next occurrence at settle regardless of outcome", async () => {
    clock = 9_000_000;
    let runs = 0;
    start(declareJobs({
      work: {
        tick: job({
          args: {},
          repeat: { everyMs: 60_000 },
          handler: async () => {
            runs++;
            if (runs === 2) throw new Error("one bad tick");
          },
        }),
      },
    }));

    // Bootstrap minted the first occurrence for the argless repeating job.
    await runtime.jobs.activate();
    await Bun.sleep(5);
    let rows = jobRows();
    expect(rows).toMatchObject([{ state: "pending", runAt: 9_060_000 }]);

    clock = 9_060_000;
    await runtime.runJobs();
    await Bun.sleep(10);
    rows = jobRows();
    expect(runs).toBe(1);
    // The settled occurrence is retained; the next one is a fresh row.
    expect(rows).toMatchObject([{ state: "completed" }, { state: "pending", runAt: 9_120_000 }]);

    // A failed occurrence still mints the next one: recurrence cannot die.
    clock = 9_120_000;
    await runtime.runJobs();
    await Bun.sleep(10);
    rows = jobRows();
    expect(runs).toBe(2);
    expect(rows.at(-1)).toMatchObject({ state: "pending", runAt: 9_180_000 });

    // A missed window coalesces to one occurrence, late, not a replay per slot.
    clock = 9_180_000 + 10 * 60_000;
    await runtime.runJobs();
    await Bun.sleep(10);
    expect(runs).toBe(3);
    expect(jobRows().filter((row) => row.state === "pending")).toHaveLength(1);
  });
});

describe("durability", () => {
  test("pending work survives restart and fires once the clock reaches it", async () => {
    clock = 10_000_000;
    const jobs = () => declareJobs({
      work: {
        note: job({
          kind: "mutation" as const,
          args: { line: v.string() },
          handler: async (tx: Ctx, args: Ctx) => {
            await tx.db.log.insert({ line: args.line });
          },
        }),
      },
    });
    start(jobs());
    await runtime.jobs.enqueue("work.note", { line: "after-restart" }, { at: 10_060_000 });
    expect(jobRows()).toMatchObject([{ state: "pending" }]);

    // The crash-equivalent path: nothing ran before the restart.
    clock = 10_060_000;
    await restart(jobs());
    await runtime.runJobs();
    expect(engine.reader.query('SELECT line FROM "log"').all()).toEqual([
      { line: "after-restart" },
    ]);
    expect(jobRows()).toMatchObject([{ state: "completed" }]);
  });

  test("an expired lease is recovered as a failed attempt through the retry policy", async () => {
    clock = 11_000_000;
    const hang = deferred<never>();
    let secondRun = false;
    const jobs = (hangFirst: boolean) => declareJobs({
      work: {
        crashy: job({
          args: {},
          retry: { attempts: 2, backoff: "fixed", delayMs: 5_000 },
          handler: async () => {
            if (hangFirst && !secondRun) return await hang.promise;
            secondRun = true;
            return "second life";
          },
        }),
      },
    });
    start(jobs(true), limits({ leaseMs: 30_000 }));
    const handle = await runtime.jobs.enqueue("work.crashy", {});
    await runtime.runJobs();
    await Bun.sleep(10);
    expect(jobRows()).toMatchObject([{ state: "running", attempt: 1n }]);

    // Crash: the process dies mid-attempt; the lease outlives it.
    engine.close("clean");
    engine = new Engine(schema, join(directory, "data.db"));
    reconcile(engine);
    runtime = new Runtime({
      engine,
      registry: new Registry({}),
      telemetry: false,
      limits: limits({ leaseMs: 30_000 }),
      jobs: jobs(false),
      now: () => clock,
    });
    expect(jobRows()).toMatchObject([{ state: "running" }]);

    // Before the lease deadline nothing is recovered.
    await runtime.runJobs();
    expect(jobRows()).toMatchObject([{ state: "running" }]);

    // Past the deadline: the attempt fails through the policy and reschedules.
    clock = 11_000_000 + 31_000;
    await runtime.runJobs();
    expect(jobRows()).toMatchObject([{ state: "pending", attempt: 1n }]);
    expect(jobRows()[0]!.attemptsJson).toContain("lease expired");

    clock += 5_000;
    const wait = runtime.jobs.wait(handle.id);
    await runtime.runJobs();
    expect(await wait).toEqual({ ok: true, value: "second life" });
  });

  test("terminal rows are reaped after their retention window", async () => {
    clock = 12_000_000;
    start(declareJobs({
      work: {
        brief: job({
          kind: "mutation" as const,
          args: {},
          retention: 1_000,
          handler: async () => "done",
        }),
      },
    }));
    const handle = await runtime.jobs.enqueue("work.brief", {});
    void handle;
    await runtime.runJobs();
    expect(jobRows()).toMatchObject([{ state: "completed" }]);

    // Past retention (and past the reap interval), the row is deleted.
    clock = 12_000_000 + 120_000;
    await runtime.runJobs();
    expect(jobRows()).toHaveLength(0);
  });
});

describe("the jobs table is guarded exactly at the state machine", () => {
  test("CRUD may move scheduling intent but never the runner's columns", async () => {
    clock = 13_000_000;
    const enqueue = mutation({
      access: "public",
      http: true,
      args: {},
      handler: (ctx: Ctx) => ctx.jobs.work.steady.enqueue({}, { delayMs: 60_000 }),
    });
    const surgery = mutation({
      access: "public",
      http: true,
      args: { id: v.bigint(), field: v.string() },
      handler: async (ctx: Ctx, args: Ctx) => {
        switch (args.field) {
          case "runAt":
            await ctx.db[JOBS_TABLE].patch(args.id, { runAt: 13_120_000 });
            return "ok";
          case "state":
            await ctx.db[JOBS_TABLE].patch(args.id, { state: "completed" });
            return "unreachable";
          case "insert":
            await ctx.db[JOBS_TABLE].insert({ name: "x" });
            return "unreachable";
          case "delete":
            await ctx.db[JOBS_TABLE].delete(args.id);
            return "ok";
        }
        return "unknown";
      },
    });
    start(
      declareJobs({
        work: { steady: job({ args: {}, handler: async () => null }) },
      }),
      limits(),
      { admin: { enqueue, surgery } },
    );

    const enqueued = await runtime.runMutation({
      id: 1,
      address: "admin.enqueue",
      args: {},
      principal: ANONYMOUS_PRINCIPAL,
      respond: ({ body, status }: Ctx) => new Response(body, { status }),
    });
    expect(enqueued.status).toBe(200);
    const id = jobRows()[0]!.id;

    const patch = (field: string, requestId: number) => runtime.runMutation({
      id: requestId,
      address: "admin.surgery",
      args: { id, field },
      principal: ANONYMOUS_PRINCIPAL,
      respond: ({ body, status }: Ctx) => new Response(body, { status }),
    });

    // Open column: scheduling intent moves.
    expect((await patch("runAt", 2)).status).toBe(200);
    expect(jobRows()[0]).toMatchObject({ runAt: 13_120_000 });

    // Guarded column: refused, named.
    const guarded = await patch("state", 3);
    expect(guarded.status).not.toBe(200);
    expect(await guarded.text()).toContain("state");
    expect(jobRows()[0]).toMatchObject({ state: "pending" });

    // Inserts go through enqueue only.
    const inserted = await patch("insert", 4);
    expect(inserted.status).not.toBe(200);
    expect(await inserted.text()).toContain("enqueue");

    // Deletes are ordinary CRUD: a pending row deletes cleanly.
    expect((await patch("delete", 5)).status).toBe(200);
    expect(jobRows()).toHaveLength(0);
  });
});
