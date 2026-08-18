/**
 * The jobs feature at the Runtime seam: a real Engine and Runtime over a real
 * database file, an injected clock, and job definitions declared per test
 * app. Everything is observed through public surfaces — enqueue/run/wait
 * outcomes, `_ackerdb_jobs` / `_ackerdb_job_runs` rows, and lifecycle effects
 * — never through runner internals.
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
import { JOB_RUNS_TABLE, JOBS_TABLE } from "../../src/jobs/table.ts";
import { mutation } from "../../src/app/functions.ts";
import { ANONYMOUS_PRINCIPAL } from "../../src/auth/credentials.ts";
import { outcomeFromError } from "../../src/runtime/outcome.ts";
import { testHttpCodec } from "../support/http.ts";

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

async function start(
  jobs: DeclaredJob[],
  customLimits = limits(),
  functions: Record<string, Record<string, unknown>> = {},
): Promise<void> {
  directory = mkdtempSync(join(tmpdir(), "ackerdb-jobs-"));
  directories.push(directory);
  engine = new Engine(schema, join(directory, "data.db"));
  reconcile(engine);
  runtime = new Runtime({
    engine,
    registry: new Registry(functions),
    limits: customLimits,
    jobs,
    now: () => clock,
  });
  await runtime.start();
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
    limits: customLimits,
    jobs,
    now: () => clock,
  });
  await runtime.start();
}

function jobRows(): Array<{
  id: bigint;
  name: string;
  state: string;
  trigger: string;
  parentJobId: bigint | null;
  scheduledAt: number;
  nextRunAt: number;
  runCount: bigint;
  nextRunTrigger: string | null;
  key: string | null;
  deleteAfter: number | null;
}> {
  return engine.reader
    .query(
      `SELECT id, name, state, trigger, parentJobId, scheduledAt, nextRunAt, runCount, nextRunTrigger, key, deleteAfter FROM "${JOBS_TABLE}" ORDER BY id`,
    )
    .all() as never;
}

function runRows(): Array<{
  id: bigint;
  jobId: bigint;
  number: bigint;
  trigger: string;
  state: string;
  scheduledAt: number;
  startedAt: number;
  settledAt: number | null;
  outputJson: string | null;
  errorCode: string | null;
  errorText: string | null;
  deleteAfter: number | null;
}> {
  return engine.reader
    .query(
      `SELECT id, jobId, number, trigger, state, scheduledAt, startedAt, settledAt, outputJson, errorCode, errorText, deleteAfter FROM "${JOB_RUNS_TABLE}" ORDER BY jobId, number`,
    )
    .all() as never;
}

/** Stable text of a row set, bigints included: an exact "nothing moved" probe. */
function snapshotOf(rows: readonly unknown[]): string {
  return JSON.stringify(rows, (_key, value) =>
    typeof value === "bigint" ? `${value}n` : value);
}

/**
 * The primary keys the jobs tables have handed out. Unlike the row sets, this
 * still moves when a row is inserted and then removed, so it catches a write
 * that a later delete would hide.
 */
function jobKeysIssued(): string {
  const rows = engine.reader
    .query(
      `SELECT name, seq FROM sqlite_sequence WHERE name IN ('${JOBS_TABLE}', '${JOB_RUNS_TABLE}') ORDER BY name`,
    )
    .all() as { name: string; seq: number | bigint }[];
  return rows.map((row) => `${row.name}=${row.seq}`).join(",");
}

afterEach(async () => {
  await runtime?.drain().catch(() => {});
  engine?.close("clean");
  while (directories.length > 0) {
    rmSync(directories.pop()!, { recursive: true, force: true });
  }
});

describe("procedure-mode Jobs", () => {
  test("claims, runs the handler as a system operation, and settles the outcome", async () => {
    clock = 1_000_000;
    const seen: unknown[] = [];
    await start(declareJobs({
      work: {
        greet: job({
          args: { who: v.string() },
          handler: async (ctx: Ctx, args: Ctx) => {
            seen.push({ runNumber: ctx.runNumber, who: args.who });
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
    expect(seen).toEqual([{ runNumber: 1, who: "ana" }]);
    expect(jobRows()).toMatchObject([{ state: "completed", runCount: 1n, trigger: "enqueue" }]);
    // The claim created exactly one run; the outcome lives on it, not the Job.
    expect(runRows()).toMatchObject([
      { jobId: handle.id, number: 1n, trigger: "initial", state: "completed", settledAt: 1_000_000 },
    ]);
    expect(runRows()[0]!.outputJson).toContain("hi ana");
    expect(engine.reader.query('SELECT line FROM "log"').all()).toEqual([{ line: "hi ana" }]);

    // A terminal Job answers waiters immediately from its latest run's output.
    expect(await runtime.jobs.wait(handle.id)).toEqual({ ok: true, value: { greeting: "hi ana" } });
  });

  test("a failed run reports nextRetryAt and the next run retries on schedule", async () => {
    clock = 2_000_000;
    let attempts = 0;
    await start(declareJobs({
      work: {
        flaky: job({
          args: {},
          retry: (runNumber: number) => (runNumber < 3 ? runNumber * 1_000 : null),
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
    expect(await first).toMatchObject({ ok: false, state: "retrying", nextRetryAt: 2_001_000 });
    expect(jobRows()).toMatchObject([{ state: "retrying", runCount: 1n, nextRunAt: 2_001_000 }]);
    expect(runRows()).toMatchObject([{ number: 1n, trigger: "initial", state: "failed" }]);

    // Not due yet: nothing runs.
    await runtime.runJobs();
    expect(attempts).toBe(1);

    clock = 2_001_000;
    const second = runtime.jobs.wait(handle.id);
    await runtime.runJobs();
    expect(await second).toMatchObject({ ok: false, state: "retrying", nextRetryAt: 2_003_000 });

    clock = 2_003_000;
    const third = runtime.jobs.wait(handle.id);
    await runtime.runJobs();
    expect(await third).toEqual({ ok: true, value: "recovered" });
    // Every execution is its own run of the same Job; the Job stays one row.
    expect(jobRows()).toHaveLength(1);
    expect(runRows().map((run) => [Number(run.number), run.trigger, run.state])).toEqual([
      [1, "initial", "failed"],
      [2, "automatic_retry", "failed"],
      [3, "automatic_retry", "completed"],
    ]);
    // The Job's admitted occurrence never moved with the retries.
    expect(jobRows()[0]).toMatchObject({ scheduledAt: 2_000_000, runCount: 3n });
  });

  test("exhausted retries fail the Job, and a manual retry adds a run to it", async () => {
    clock = 3_000_000;
    let runs = 0;
    await start(declareJobs({
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
    expect(await wait).toMatchObject({ ok: false, state: "failed", nextRetryAt: null });
    expect(jobRows()).toMatchObject([{ state: "failed" }]);
    expect(runRows()[0]!.errorText).toContain("always fails");
    expect(runRows()[0]!.errorCode).toBe("internal");

    // Manual retry keeps the Job's identity and history, and adds a run.
    await runtime.jobs.retry(handle.id);
    expect(jobRows()).toMatchObject([
      { state: "retrying", runCount: 1n, nextRunTrigger: "manual_retry" },
    ]);
    const second = runtime.jobs.wait(handle.id);
    await runtime.runJobs();
    await second;
    expect(runs).toBe(2);
    expect(runRows().map((run) => [Number(run.number), run.trigger])).toEqual([
      [1, "initial"],
      [2, "manual_retry"],
    ]);
  });

  test("cancel aborts a running handler cooperatively and discards its result", async () => {
    clock = 4_000_000;
    const started = deferred<void>();
    const finish = deferred<string>();
    let abortedInHandler = false;
    await start(declareJobs({
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
    // The run in flight settles as canceled with its Job.
    expect(runRows()).toMatchObject([{ number: 1n, state: "canceled", settledAt: 4_000_000 }]);

    // The late result self-discards on the stale lease: still canceled.
    finish.resolve("too late");
    await Bun.sleep(10);
    expect(jobRows()).toMatchObject([{ state: "canceled" }]);
    expect(runRows()).toMatchObject([{ state: "canceled", outputJson: null }]);
    // Cancel on a terminal row is a no-op reporting the state.
    expect(await runtime.jobs.cancel(handle.id)).toBe("canceled");
  });
});

describe("dedupe and memoization", () => {
  test("in-flight dedupe collapses equal args into one Job; fresh args run fresh", async () => {
    clock = 5_000_000;
    await start(declareJobs({
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
    // No handler ran, so no run exists for either Job yet.
    expect(runRows()).toHaveLength(0);

    // Two awaiters of the deduped row observe one settle.
    clock = 5_060_000;
    const [one, two] = [runtime.jobs.wait(first.id), runtime.jobs.wait(first.id)];
    await runtime.runJobs();
    expect(await one).toEqual({ ok: true, value: "sent:a" });
    expect(await two).toEqual({ ok: true, value: "sent:a" });

    // The completed Job does not dedupe (no window): a new call runs fresh.
    const again = await runtime.jobs.enqueue("work.send", { to: "a" });
    expect(again.deduped).toBe(false);
  });

  test("a dedupe hit is write-free: it changes no row and creates no run", async () => {
    clock = 5_500_000;
    await start(declareJobs({
      work: {
        once: job({
          args: { key: v.string() },
          dedupe: { completed: "forever" },
          handler: async (_ctx: Ctx, args: Ctx) => `done:${args.key}`,
        }),
      },
    }));

    const first = await runtime.jobs.enqueue("work.once", { key: "k" });
    const wait = runtime.jobs.wait(first.id);
    await runtime.runJobs();
    expect(await wait).toEqual({ ok: true, value: "done:k" });

    const jobsBefore = snapshotOf(jobRows());
    const runsBefore = snapshotOf(runRows());
    const keysBefore = jobKeysIssued();

    clock = 5_600_000;
    const hit = await runtime.jobs.enqueue("work.once", { key: "k" });
    expect(hit).toEqual({ id: first.id, deduped: true });
    // A dedupe hit executes no handler, so it stores nothing: not a Job row,
    // not a run, not a touched timestamp, and not even a primary key it later
    // gave back. (It still takes the writer turn that makes the check and the
    // insert one atomic step, so the engine's global commit counter advances
    // as it does for any transaction that writes nothing.)
    expect(snapshotOf(jobRows())).toBe(jobsBefore);
    expect(snapshotOf(runRows())).toBe(runsBefore);
    expect(jobKeysIssued()).toBe(keysBefore);
    // ...and the hit still answers with the memoized outcome.
    expect(await runtime.jobs.wait(hit.id)).toEqual({ ok: true, value: "done:k" });
  });

  test("two settles in one millisecond resolve to the newer outcome, not the luckier row", async () => {
    clock = 5_800_000;
    let runs = 0;
    await start(declareJobs({
      work: {
        beat: job({
          args: {},
          // A recurrence due the instant it is minted: the successor settles
          // in the same millisecond as the occurrence that created it.
          repeat: () => (runs >= 2 ? null : clock),
          dedupe: { completed: "forever", failed: "forever" },
          handler: async () => {
            if (++runs === 1) return "first";
            throw new Error("second fails");
          },
        }),
      },
    }));
    await Bun.sleep(5);

    await runtime.runJobs();
    await Bun.sleep(10);
    await runtime.runJobs();
    await Bun.sleep(10);
    const settled = jobRows().filter((row) => row.state === "completed" || row.state === "failed");
    expect(settled.map((row) => row.state)).toEqual(["completed", "failed"]);
    expect(settled.every((row) => row.deleteAfter === null)).toBe(true);

    // "Newest" has to mean one row: the later Job, not whichever the index
    // reached first.
    const hit = await runtime.jobs.enqueue("work.beat", {});
    expect(hit.deduped).toBe(true);
    expect(hit.id).toBe(settled.at(-1)!.id);
    expect(await runtime.jobs.wait(hit.id)).toMatchObject({ ok: false, state: "failed" });
  });

  test("a completed window memoizes, and expiry releases a fresh run", async () => {
    clock = 6_000_000;
    let runs = 0;
    await start(declareJobs({
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
    await start(declareJobs({
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
    await start(declareJobs({
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
    await start(declareJobs({
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
    await Bun.sleep(5);
    let rows = jobRows();
    expect(rows).toMatchObject([{ state: "pending", nextRunAt: 9_060_000, trigger: "repeat" }]);

    clock = 9_060_000;
    await runtime.runJobs();
    await Bun.sleep(10);
    rows = jobRows();
    expect(runs).toBe(1);
    // The settled occurrence is retained; the next one is a fresh Job that
    // names the occurrence it followed.
    expect(rows).toMatchObject([
      { state: "completed" },
      { state: "pending", nextRunAt: 9_120_000, trigger: "repeat", parentJobId: rows[0]!.id },
    ]);

    // A failed occurrence still mints the next one: recurrence cannot die.
    clock = 9_120_000;
    await runtime.runJobs();
    await Bun.sleep(10);
    rows = jobRows();
    expect(runs).toBe(2);
    expect(rows.at(-1)).toMatchObject({ state: "pending", nextRunAt: 9_180_000 });

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
          mode: "mutation" as const,
          args: { line: v.string() },
          handler: async (tx: Ctx, args: Ctx) => {
            await tx.db.log.insert({ line: args.line });
          },
        }),
      },
    });
    await start(jobs());
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

  test("an expired lease is recovered as a failed run through the retry policy", async () => {
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
    await start(jobs(true), limits({ leaseMs: 30_000 }));
    const handle = await runtime.jobs.enqueue("work.crashy", {});
    await runtime.runJobs();
    await Bun.sleep(10);
    expect(jobRows()).toMatchObject([{ state: "running", runCount: 1n }]);
    expect(runRows()).toMatchObject([{ number: 1n, state: "running" }]);

    // Crash: the process dies mid-run; the lease outlives it.
    engine.close("clean");
    engine = new Engine(schema, join(directory, "data.db"));
    reconcile(engine);
    runtime = new Runtime({
      engine,
      registry: new Registry({}),
      limits: limits({ leaseMs: 30_000 }),
      jobs: jobs(false),
      now: () => clock,
    });
    await runtime.start();
    expect(jobRows()).toMatchObject([{ state: "running" }]);

    // Before the lease deadline nothing is recovered.
    await runtime.runJobs();
    expect(jobRows()).toMatchObject([{ state: "running" }]);

    // Past the deadline: the run fails through the policy and reschedules.
    clock = 11_000_000 + 31_000;
    await runtime.runJobs();
    expect(jobRows()).toMatchObject([{ state: "retrying", runCount: 1n }]);
    expect(runRows()[0]!.errorText).toContain("lease expired");

    clock += 5_000;
    const wait = runtime.jobs.wait(handle.id);
    await runtime.runJobs();
    expect(await wait).toEqual({ ok: true, value: "second life" });
    expect(runRows().map((run) => run.state)).toEqual(["failed", "completed"]);
  });

  test("an abandoned lease wakes the runner by itself: no manual drive needed", async () => {
    clock = 14_000_000;
    const hang = deferred<never>();
    let recovered = 0;
    const jobs = () => declareJobs({
      work: {
        stuck: job({
          args: {},
          retry: { attempts: 2, backoff: "fixed", delayMs: 0 },
          handler: async (ctx: Ctx) => {
            if (ctx.runNumber === 1) return await hang.promise;
            recovered++;
            return "recovered";
          },
        }),
      },
    });
    await start(jobs(), limits({ leaseMs: 30_000 }));
    await runtime.jobs.enqueue("work.stuck", {});
    await runtime.runJobs();
    await Bun.sleep(10);
    expect(jobRows()).toMatchObject([{ state: "running" }]);

    // Crash mid-attempt, restart with the clock already past the lease.
    engine.close("clean");
    clock = 14_000_000 + 31_000;
    engine = new Engine(schema, join(directory, "data.db"));
    reconcile(engine);
    runtime = new Runtime({
      engine,
      registry: new Registry({}),
      limits: limits({ leaseMs: 30_000 }),
      jobs: jobs(),
      now: () => clock,
    });
    await runtime.start();
    // No runJobs() call: the arm pass must see the expired lease and wake
    // recovery on its own timer.
    const deadline = Date.now() + 2_000;
    while (recovered === 0 && Date.now() < deadline) await Bun.sleep(5);
    expect(recovered).toBe(1);
    expect(jobRows()).toMatchObject([{ state: "completed" }]);
  });

  test("dedupe identity survives more than 64 retained same-identity Jobs", async () => {
    clock = 15_000_000;
    await start(declareJobs({
      work: {
        tick: job({
          mode: "mutation" as const,
          args: {},
          repeat: { everyMs: 1_000 },
          retention: "forever",
          handler: async () => "tick",
        }),
      },
    }));
    await Bun.sleep(5);
    // 70 settled occurrences share one identity; the mint-time live check must
    // still see the newest pending row or every settle would fork a duplicate.
    for (let index = 0; index < 70; index++) {
      clock += 1_000;
      await runtime.runJobs();
    }
    const rows = jobRows();
    expect(rows.filter((row) => row.state === "completed").length).toBe(70);
    expect(rows.filter((row) => row.state === "pending").length).toBe(1);
  });

  test("a gate-blocked overdue row parks the runner instead of spinning", async () => {
    clock = 16_000_000;
    const first = deferred<string>();
    await start(declareJobs({
      work: {
        serial: job({
          args: { n: v.int() },
          key: () => "one",
          concurrency: 1,
          handler: async (_ctx: Ctx, args: Ctx) =>
            args.n === 1 ? await first.promise : `ran:${args.n}`,
        }),
      },
    }));
    const one = await runtime.jobs.enqueue("work.serial", { n: 1 });
    void one;
    const two = await runtime.jobs.enqueue("work.serial", { n: 2 });
    await runtime.runJobs();
    await Bun.sleep(10);
    // n=1 runs; n=2 is due but gated: the runner must not arm a zero-delay
    // timer for it — the settle commit wakes it instead.
    expect(jobRows()).toMatchObject([{ state: "running" }, { state: "pending" }]);
    expect(runtime.jobs.armed).toBe(false);
    const waitTwo = runtime.jobs.wait(two.id);
    first.resolve("done");
    expect(await waitTwo).toEqual({ ok: true, value: "ran:2" });
  });

  test("claiming pages past a saturated key to eligible work behind it", async () => {
    clock = 17_000_000;
    const gate = deferred<string>();
    let otherRan = false;
    await start(declareJobs({
      work: {
        keyed: job({
          args: { n: v.int() },
          key: () => "hot",
          concurrency: 1,
          handler: async (_ctx: Ctx, args: Ctx) =>
            args.n === 1 ? await gate.promise : `ran:${args.n}`,
        }),
        other: job({
          args: {},
          handler: async () => {
            otherRan = true;
            return "other";
          },
        }),
      },
    }), limits({ claimBatchSize: 2 }));
    // Due order: keyed 1..3 first, then the unrelated job — beyond the first
    // claim page.
    await runtime.jobs.enqueue("work.keyed", { n: 1 }, { at: 17_000_000 - 40 });
    await runtime.jobs.enqueue("work.keyed", { n: 2 }, { at: 17_000_000 - 30 });
    await runtime.jobs.enqueue("work.keyed", { n: 3 }, { at: 17_000_000 - 20 });
    const other = await runtime.jobs.enqueue("work.other", {}, { at: 17_000_000 - 10 });
    await runtime.runJobs();
    const outcome = await runtime.jobs.wait(other.id);
    expect(outcome).toEqual({ ok: true, value: "other" });
    expect(otherRan).toBe(true);
    gate.resolve("done");
  });

  test("drain delivers a typed outcome to stranded waiters instead of holding them", async () => {
    clock = 18_000_000;
    const never = deferred<never>();
    await start(declareJobs({
      work: { forever: job({ args: {}, handler: async () => await never.promise }) },
    }));
    const handle = await runtime.jobs.enqueue("work.forever", {});
    const wait = runtime.jobs.wait(handle.id);
    await runtime.runJobs();
    await Bun.sleep(10);
    const drained = runtime.drain();
    // The waiter resolves promptly — it must not hold out for the drain
    // deadline while the uncooperative handler ignores its abort signal.
    const outcome = await Promise.race([
      wait,
      Bun.sleep(1_000).then(() => "timed-out" as const),
    ]);
    expect(outcome).toMatchObject({ ok: false, state: "pending", nextRetryAt: null });
    never.reject(new Error("shutdown")); // release the handler so drain completes
    await drained;
  });

  test("a terminal Job and its runs are reaped after the retention window", async () => {
    clock = 12_000_000;
    await start(declareJobs({
      work: {
        brief: job({
          mode: "mutation" as const,
          args: {},
          retention: 1_000,
          handler: async () => "done",
        }),
      },
    }));
    const handle = await runtime.jobs.enqueue("work.brief", {});
    void handle;
    await runtime.runJobs();
    expect(jobRows()).toMatchObject([{ state: "completed", deleteAfter: 12_001_000 }]);
    expect(runRows()).toMatchObject([{ state: "completed", deleteAfter: 12_001_000 }]);

    // Past retention (and past the reap interval), the Job goes and takes its
    // run history with it — no run is left parented to nothing.
    clock = 12_000_000 + 120_000;
    await runtime.runJobs();
    expect(jobRows()).toHaveLength(0);
    expect(runRows()).toHaveLength(0);
  });

  test("retention outlives a longer dedupe window rather than cutting it short", async () => {
    clock = 19_000_000;
    await start(declareJobs({
      work: {
        cached: job({
          mode: "mutation" as const,
          args: {},
          retention: 1_000,
          dedupe: { completed: 500_000 },
          handler: async () => "cached",
        }),
      },
    }));
    await runtime.jobs.enqueue("work.cached", {});
    await runtime.runJobs();
    // The stamp is the longer of retention and the dedupe window, so the run a
    // dedupe hit reads can never be reaped while the hit still resolves.
    expect(jobRows()).toMatchObject([{ deleteAfter: 19_500_000 }]);
    expect(runRows()).toMatchObject([{ deleteAfter: 19_500_000 }]);

    clock = 19_000_000 + 120_000;
    await runtime.runJobs();
    expect(jobRows()).toHaveLength(1);
    const hit = await runtime.jobs.enqueue("work.cached", {});
    expect(hit.deduped).toBe(true);
  });

  test("a failed run of a live Job expires on its own, bounding a long retry chain", async () => {
    clock = 20_000_000;
    await start(declareJobs({
      work: {
        grinding: job({
          args: {},
          retention: 1_000,
          retry: { attempts: 100, backoff: "fixed", delayMs: 60_000 },
          handler: async () => {
            throw new Error("still bad");
          },
        }),
      },
    }));
    const handle = await runtime.jobs.enqueue("work.grinding", {});
    void handle;
    await runtime.runJobs();
    await Bun.sleep(10);
    expect(runRows()).toHaveLength(1);
    expect(jobRows()).toMatchObject([{ state: "retrying", deleteAfter: null }]);

    // The Job is alive and never reaped, but its settled runs are not history
    // the operator asked to keep forever — except the latest, which is the run
    // its outcome is read from and only ever leaves with its Job.
    clock = 20_000_000 + 120_000;
    await runtime.runJobs();
    await Bun.sleep(10);
    const surviving = runRows();
    expect(jobRows()).toHaveLength(1);
    expect(surviving.map((run) => Number(run.number))).toEqual([Number(jobRows()[0]!.runCount)]);
  });

  test("a terminal Job never loses the run its outcome is read from", async () => {
    clock = 25_000_000;
    await start(declareJobs({
      work: {
        brief: job({
          mode: "mutation" as const,
          args: { n: v.int() },
          retention: 1_000,
          handler: async (_tx: Ctx, args: Ctx) => `value:${args.n}`,
        }),
      },
    }), limits({ claimBatchSize: 1 }));
    // More expired Jobs than one sweep of the Job reaper can take, so the run
    // reaper meets the leftovers' runs on its own.
    for (let index = 0; index < 3; index++) {
      await runtime.jobs.enqueue("work.brief", { n: index });
      await runtime.runJobs();
    }
    expect(jobRows()).toHaveLength(3);

    clock = 25_000_000 + 120_000;
    await runtime.runJobs();
    // Whatever the sweep managed, no surviving Job is left without its outcome.
    for (const survivor of jobRows()) {
      const outcome = runRows().find(
        (run) => run.jobId === survivor.id && run.number === survivor.runCount,
      );
      expect(outcome).toBeDefined();
      expect(outcome!.outputJson).toContain("value:");
    }
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
          case "nextRunAt":
            await ctx.db[JOBS_TABLE].patch(args.id, { nextRunAt: 13_120_000 });
            return "ok";
          case "state":
            await ctx.db[JOBS_TABLE].patch(args.id, { state: "completed" });
            return "unreachable";
          case "insert":
            await ctx.db[JOBS_TABLE].insert({ name: "x" });
            return "unreachable";
          case "delete":
            await ctx.db[JOBS_TABLE].delete(args.id);
            return "unreachable";
          case "insertRun":
            await ctx.db[JOB_RUNS_TABLE].insert({ jobId: args.id, number: 1 });
            return "unreachable";
          case "deleteRun":
            await ctx.db[JOB_RUNS_TABLE].delete(args.id);
            return "unreachable";
        }
        return "unknown";
      },
    });
    await start(
      declareJobs({
        work: { steady: job({ args: {}, handler: async () => null }) },
      }),
      limits(),
      { admin: { enqueue, surgery } },
    );

    const enqueued = await runtime.runMutation({
      id: 1,
      address: "api.admin.enqueue",
      args: {},
      codec: testHttpCodec,
      principal: ANONYMOUS_PRINCIPAL,
      respond: ({ body, status }: Ctx) => new Response(body, { status }),
    });
    expect(enqueued.status).toBe(200);
    const id = jobRows()[0]!.id;

    const patch = (field: string, requestId: number) => runtime.runMutation({
      id: requestId,
      address: "api.admin.surgery",
      args: { id, field },
      codec: testHttpCodec,
      principal: ANONYMOUS_PRINCIPAL,
      respond: ({ body, status }: Ctx) => new Response(body, { status }),
    });

    // Open column: scheduling intent moves.
    expect((await patch("nextRunAt", 2)).status).toBe(200);
    expect(jobRows()[0]).toMatchObject({ nextRunAt: 13_120_000 });

    // Guarded column: refused, named.
    const guarded = await patch("state", 3);
    expect(guarded.status).not.toBe(200);
    expect(await guarded.text()).toContain("state");
    expect(jobRows()[0]).toMatchObject({ state: "pending" });

    // Inserts go through enqueue only.
    const inserted = await patch("insert", 4);
    expect(inserted.status).not.toBe(200);
    expect(await inserted.text()).toContain("enqueue");

    // Deleting a Job through CRUD would strand its run history: the one door
    // is the transition that removes both.
    const deleted = await patch("delete", 5);
    expect(deleted.status).not.toBe(200);
    expect(await deleted.text()).toContain("delete");
    expect(jobRows()).toHaveLength(1);

    // Runs are the runner's record of what executed: read-only, entirely.
    for (const [index, field] of ["insertRun", "deleteRun"].entries()) {
      const refused = await patch(field, 6 + index);
      expect(refused.status).not.toBe(200);
      expect(await refused.text()).toContain("runner");
    }

    await runtime.jobs.delete(id);
    expect(jobRows()).toHaveLength(0);
  });
});

describe("administration transitions", () => {
  test("run again re-submits through dedupe; force adds a run under one identity", async () => {
    clock = 21_000_000;
    let runs = 0;
    await start(declareJobs({
      work: {
        report: job({
          args: { day: v.string() },
          dedupe: { completed: "forever" },
          handler: async (_ctx: Ctx, args: Ctx) => `${args.day}:${++runs}`,
        }),
      },
    }));

    const first = await runtime.jobs.enqueue("work.report", { day: "mon" });
    const wait = runtime.jobs.wait(first.id);
    await runtime.runJobs();
    expect(await wait).toEqual({ ok: true, value: "mon:1" });

    // Run again goes through ordinary enqueue, so a forever window resolves it
    // to the same Job and the same outcome — no second execution.
    const again = await runtime.jobs.runAgain(first.id);
    expect(again).toEqual({ id: first.id, deduped: true });
    expect(runs).toBe(1);
    expect(runRows()).toHaveLength(1);

    // Force run again keeps the identity and replaces the outcome dedupe hands out.
    clock = 21_010_000;
    await runtime.jobs.forceRunAgain(first.id);
    expect(jobRows()).toMatchObject([{ state: "pending", runCount: 1n, nextRunTrigger: "force" }]);
    const forced = runtime.jobs.wait(first.id);
    await runtime.runJobs();
    expect(await forced).toEqual({ ok: true, value: "mon:2" });
    expect(jobRows()).toHaveLength(1);
    expect(runRows().map((run) => [Number(run.number), run.trigger])).toEqual([
      [1, "initial"],
      [2, "force"],
    ]);
    // Future dedupe hits receive the new outcome.
    const hit = await runtime.jobs.enqueue("work.report", { day: "mon" });
    expect(hit).toEqual({ id: first.id, deduped: true });
    expect(await runtime.jobs.wait(hit.id)).toEqual({ ok: true, value: "mon:2" });
  });

  test("canceling one occurrence does not disable the definition's repeat policy", async () => {
    clock = 24_000_000;
    await start(declareJobs({
      work: {
        tick: job({
          args: {},
          repeat: { everyMs: 60_000 },
          handler: async () => "tick",
        }),
      },
    }));
    await Bun.sleep(5);
    const upcoming = jobRows();
    expect(upcoming).toMatchObject([{ state: "pending", nextRunAt: 24_060_000 }]);

    // Cancel is an operator ending one occurrence, not the recurrence: the
    // next Job is still persisted, exactly as a failed occurrence's would be.
    expect(await runtime.jobs.cancel(upcoming[0]!.id)).toBe("canceled");
    expect(jobRows()).toMatchObject([
      { state: "canceled", runCount: 0n },
      { state: "pending", nextRunAt: 24_120_000, trigger: "repeat", parentJobId: upcoming[0]!.id },
    ]);
    expect(runRows()).toHaveLength(0);
  });

  test("retention wakes an idle runner, and a full page brings it straight back", async () => {
    clock = 26_000_000;
    await start(declareJobs({
      work: {
        brief: job({
          mode: "mutation" as const,
          args: { n: v.int() },
          retention: 1_000,
          handler: async () => "done",
        }),
      },
    }), limits({ claimBatchSize: 1 }));
    for (let index = 0; index < 3; index++) {
      await runtime.jobs.enqueue("work.brief", { n: index });
      await runtime.runJobs();
    }
    expect(jobRows()).toHaveLength(3);

    // Nothing is due and nothing is enqueued ever again: the only reason left
    // to wake is the retention the operator asked for. No runJobs() below —
    // the runner has to schedule every one of these sweeps itself.
    clock = 26_000_000 + 120_000;
    runtime.jobs.arm();
    const deadline = Date.now() + 5_000;
    let swept = jobRows().length;
    while (swept > 0 && Date.now() < deadline) {
      await Bun.sleep(5);
      if (jobRows().length === swept) continue;
      swept = jobRows().length;
      // A page went; the sweep interval is the next wake, so move the clock
      // onto it. A runner that parked after a full page would stop here.
      clock += 120_000;
      runtime.jobs.arm("requeue");
    }
    expect(jobRows()).toHaveLength(0);
    expect(runRows()).toHaveLength(0);
  });

  test("cancel before the claim creates no run at all", async () => {
    clock = 22_000_000;
    await start(declareJobs({
      work: { later: job({ args: {}, handler: async () => "never" }) },
    }));
    const handle = await runtime.jobs.enqueue("work.later", {}, { delayMs: 60_000 });
    expect(await runtime.jobs.cancel(handle.id)).toBe("canceled");
    expect(jobRows()).toMatchObject([{ state: "canceled", runCount: 0n }]);
    expect(runRows()).toHaveLength(0);
    expect(await runtime.jobs.wait(handle.id)).toMatchObject({ ok: false, state: "canceled" });
  });

  test("reopening a terminal Job restamps the run it leaves behind as history", async () => {
    clock = 27_000_000;
    await start(declareJobs({
      work: {
        cached: job({
          mode: "mutation" as const,
          args: {},
          retention: 1_000,
          dedupe: { completed: "forever" },
          handler: async () => "value",
        }),
      },
    }));
    const handle = await runtime.jobs.enqueue("work.cached", {});
    await runtime.runJobs();
    // Settled as the Job's outcome, so it carries the forever dedupe stamp.
    expect(runRows()).toMatchObject([{ number: 1n, deleteAfter: null }]);

    clock = 27_010_000;
    await runtime.jobs.forceRunAgain(handle.id);
    // It is history now, and history keeps the plain retention it was settled
    // with — not the forever stamp of an outcome nothing can reach again.
    expect(runRows()).toMatchObject([{ number: 1n, deleteAfter: 27_001_000 }]);
    await runtime.runJobs();
    expect(runRows().map((run) => Number(run.number))).toEqual([1, 2]);
    expect(runRows()[1]!.deleteAfter).toBeNull();
  });

  test("deleting a Job removes every run it owns", async () => {
    clock = 23_000_000;
    await start(declareJobs({
      work: {
        twice: job({
          args: {},
          retry: { attempts: 2, backoff: "fixed", delayMs: 0 },
          handler: async () => {
            throw new Error("nope");
          },
        }),
      },
    }));
    const handle = await runtime.jobs.enqueue("work.twice", {});
    await runtime.runJobs();
    await Bun.sleep(10);
    await runtime.runJobs();
    await Bun.sleep(10);
    expect(runRows().length).toBeGreaterThan(1);

    await runtime.jobs.delete(handle.id);
    expect(jobRows()).toHaveLength(0);
    expect(runRows()).toHaveLength(0);
  });

  test("a mutation Job whose stored arguments no longer decode fails instead of wedging", async () => {
    // ADR-0018 promises an admitted Job is durable, and durable includes
    // reaching an end. Arguments that cannot be decoded — bytes corrupted
    // underneath us, or an encoding this version no longer reads — used to
    // throw out of the claim transaction before any savepoint existed, rolling
    // the claim back and leaving the Job due: claimed again, thrown out of
    // again, forever, with no run to show for it. It must fail once, durably.
    //
    // The mode matters. A procedure-mode Job decodes inside its settlement
    // boundary and always failed correctly; the mutation envelope collapses
    // claim, handler and settle into one transaction, and decoding before the
    // savepoint took the claim down with it. The two envelopes had drifted.
    clock = 31_000_000;
    let ran = 0;
    await start(declareJobs({
      work: {
        readArgs: job({
          mode: "mutation",
          args: { note: v.string() },
          handler: async () => {
            ran++;
            return "ok";
          },
        }),
      },
    }));
    const handle = await runtime.jobs.enqueue("work.readArgs", { note: "fine" }, {
      delayMs: 60_000,
    });
    engine.writer.query(`UPDATE ${JOBS_TABLE} SET argsJson = ?, nextRunAt = ? WHERE id = ?`)
      .run("{ not canonical json", clock, handle.id);

    await runtime.runJobs();
    await Bun.sleep(10);

    expect(ran).toBe(0);
    expect(runRows()).toHaveLength(1);
    expect(runRows()[0]).toMatchObject({ state: "failed" });
    expect(jobRows()[0]).toMatchObject({ state: "failed" });
    // And it stays settled: a second sweep adds no run, which is the assertion
    // that would have failed forever before — a wedged Job produces a claim
    // every sweep and a run from none of them.
    await runtime.runJobs();
    await Bun.sleep(10);
    expect(runRows()).toHaveLength(1);
    expect(ran).toBe(0);
  });
});

describe("the injected clock", () => {
  /**
   * The clock is checked once, where it is injected, so the jobs runner never
   * has to remember to check its own reads. Breaking the clock inside the
   * mutation puts the failure at the jobs seam — past admission, inside the
   * writer transaction — which is the one place a bad millisecond could have
   * reached a durable column. Whichever injected wrapper reads first refuses;
   * they all wrap the one clock the Runtime was given.
   */
  test("refuses to enqueue on a clock that stopped returning milliseconds", async () => {
    clock = 15_000_000;
    let thrown: unknown;
    const enqueue = mutation({
      access: "public",
      http: true,
      args: {},
      handler: async (ctx: Ctx) => {
        clock = Number.NaN;
        try {
          return await ctx.jobs.work.steady.enqueue({}, { delayMs: 60_000 });
        } catch (error) {
          thrown = error;
          throw error;
        } finally {
          clock = 15_000_000;
        }
      },
    });
    await start(
      declareJobs({ work: { steady: job({ args: {}, handler: async () => null }) } }),
      limits(),
      { admin: { enqueue } },
    );
    const keysBefore = jobKeysIssued();

    const response = await runtime.runMutation({
      id: 1,
      address: "api.admin.enqueue",
      args: {},
      codec: testHttpCodec,
      principal: ANONYMOUS_PRINCIPAL,
      respond: ({ body, status }: Ctx) => new Response(body, { status }),
    });
    expect(thrown).toBeInstanceOf(RangeError);
    expect((thrown as Error).message).toContain("must be finite milliseconds");
    expect(response.status).toBe(500);
    expect(JSON.parse(await response.text())).toMatchObject({ code: "internal" });
    // The transaction rolled back, so no Job row exists and no key was spent.
    expect(jobRows()).toHaveLength(0);
    expect(runRows()).toHaveLength(0);
    expect(jobKeysIssued()).toBe(keysBefore);
  });
});
