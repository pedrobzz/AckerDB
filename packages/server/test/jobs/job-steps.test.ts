/**
 * Durable steps (ADR-0022) at the Runtime seam: a real Engine and Runtime
 * over a real database file, an injected clock, and step-using job handlers.
 * Everything is observed through public surfaces — outcomes, `_ackerdb_jobs`
 * rows and their step journals, and counted side effects — never through
 * runner internals.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Err, Status } from "@ackerdb/core";
import { Engine } from "../../src/database/engine.ts";
import { reconcile } from "../../src/schema/reconcile.ts";
import { defineSchema, defineTable } from "../../src/schema/definition.ts";
import { v } from "../../src/validation/v.ts";
import { Registry } from "../../src/app/registry.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { PRODUCTION_LIMITS, type ServiceLimits } from "../../src/runtime/limits.ts";
import { declareJobs, job, type DeclaredJob } from "../../src/jobs/definition.ts";
import { JOBS_TABLE } from "../../src/jobs/table.ts";
import { mutation, procedure, query } from "../../src/app/functions.ts";

// Tests exercise runtime ownership, not generated application types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

const schema = defineSchema({
  log: defineTable({ id: v.primaryKey(), line: v.string() }),
});

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
  functions: Record<string, Record<string, unknown>> = {},
): void {
  directory = mkdtempSync(join(tmpdir(), "ackerdb-steps-"));
  directories.push(directory);
  engine = new Engine(schema, join(directory, "data.db"));
  reconcile(engine);
  runtime = new Runtime({
    engine,
    registry: new Registry(functions),
    telemetry: false,
    limits: limits(),
    jobs,
    now: () => clock,
  });
}

/** Reopen the same database file with a fresh Runtime: the restart seam. */
async function restart(
  jobs: DeclaredJob[],
  functions: Record<string, Record<string, unknown>> = {},
): Promise<void> {
  await runtime.drain().catch(() => {});
  engine.close("clean");
  engine = new Engine(schema, join(directory, "data.db"));
  reconcile(engine);
  runtime = new Runtime({
    engine,
    registry: new Registry(functions),
    telemetry: false,
    limits: limits(),
    jobs,
    now: () => clock,
  });
}

function jobRows(): Array<{
  id: bigint;
  state: string;
  runAt: number;
  attempt: bigint;
  attemptsJson: string;
  stepsJson: string | null;
}> {
  return engine.reader
    .query(
      `SELECT id, state, runAt, attempt, attemptsJson, stepsJson FROM "${JOBS_TABLE}" ORDER BY id`,
    )
    .all() as never;
}

function journalNames(): string[] {
  const row = jobRows()[0]!;
  return (JSON.parse(row.stepsJson ?? "[]") as Array<{ name: string }>).map((e) => e.name);
}

function logLines(): string[] {
  return (engine.reader.query('SELECT line FROM "log" ORDER BY id').all() as Array<{
    line: string;
  }>).map((row) => row.line);
}

afterEach(async () => {
  await runtime?.drain().catch(() => {});
  engine?.close("clean");
  while (directories.length > 0) {
    rmSync(directories.pop()!, { recursive: true, force: true });
  }
});

/** Registered targets for `step.run`, shared across tests. */
const record = mutation({
  internal: true,
  access: "system",
  args: { line: v.string() },
  handler: async (ctx: Ctx, args: Ctx) => {
    await ctx.db.log.insert({ line: args.line });
    return args.line;
  },
});
const snapshot = query({
  access: "authenticated",
  args: {},
  handler: () => "observed",
});
const payInvoice = procedure({
  internal: true,
  access: "authenticated",
  args: { invoiceId: v.string() },
  handler: (_ctx: Ctx, args: Ctx) =>
    args.invoiceId === "bad"
      ? Err("invoice-unpayable", { invoiceId: args.invoiceId }, Status.UnprocessableContent)
      : { paid: args.invoiceId },
});
const functions = { fns: { record, snapshot, payInvoice } };

describe("step replay", () => {
  test("a retried attempt re-runs only unrecorded steps", async () => {
    clock = 1_000_000;
    let externalCalls = 0;
    let attempts = 0;
    start(
      declareJobs({
        flows: {
          fulfill: job({
            args: {},
            retry: (attempt: number) => (attempt < 3 ? 1_000 : null),
            handler: async (ctx: Ctx) => {
              const charged = await ctx.step.procedure("charge", async () => {
                externalCalls++;
                return { receipt: `r-${externalCalls}` };
              });
              const written = await ctx.step.run("fns.record", { line: charged.receipt });
              expect(written).toMatchObject({ ok: true, data: "r-1" });
              attempts++;
              if (attempts < 3) throw new Error(`boom ${attempts}`);
              return charged.receipt;
            },
          }),
        },
      }),
      functions,
    );

    const handle = await runtime.jobs.enqueue("flows.fulfill", {});
    let wait = runtime.jobs.wait(handle.id);
    await runtime.runJobs();
    expect(await wait).toMatchObject({ ok: false, state: "pending" });

    clock = 1_001_000;
    wait = runtime.jobs.wait(handle.id);
    await runtime.runJobs();
    expect(await wait).toMatchObject({ ok: false, state: "pending" });

    clock = 1_002_000;
    wait = runtime.jobs.wait(handle.id);
    await runtime.runJobs();
    expect(await wait).toEqual({ ok: true, value: "r-1" });

    // The external call and the mutation ran exactly once across 3 attempts.
    expect(externalCalls).toBe(1);
    expect(logLines()).toEqual(["r-1"]);
    expect(journalNames()).toEqual(["charge", "fns.record"]);
    expect(jobRows()[0]).toMatchObject({ state: "completed", attempt: 3n });
  });

  test("completed steps survive a process restart", async () => {
    clock = 2_000_000;
    let externalCalls = 0;
    let succeed = false;
    const definitions = () =>
      declareJobs({
        flows: {
          sync: job({
            args: {},
            retry: { attempts: 5, backoff: "fixed", delayMs: 1_000 },
            handler: async (ctx: Ctx) => {
              const first = await ctx.step.procedure("pull", async () => {
                externalCalls++;
                return "pulled";
              });
              if (!succeed) throw new Error("push failed");
              return first;
            },
          }),
        },
      });

    start(definitions(), functions);
    const handle = await runtime.jobs.enqueue("flows.sync", {});
    const wait = runtime.jobs.wait(handle.id);
    await runtime.runJobs();
    expect(await wait).toMatchObject({ ok: false, state: "pending" });
    expect(externalCalls).toBe(1);

    await restart(definitions(), functions);
    succeed = true;
    clock = 2_001_000;
    const resumed = runtime.jobs.wait(handle.id);
    await runtime.runJobs();
    expect(await resumed).toEqual({ ok: true, value: "pulled" });
    expect(externalCalls).toBe(1); // journaled before the restart; never re-ran
  });
});

describe("step.run", () => {
  test("registered callees: query and mutation results are journaled Results", async () => {
    clock = 3_000_000;
    start(
      declareJobs({
        flows: {
          observe: job({
            args: {},
            handler: async (ctx: Ctx) => {
              const seen = await ctx.step.run("fns.snapshot", {});
              const written = await ctx.step.run("fns.record", { line: seen.data });
              return { seen: seen.data, wrote: written.data };
            },
          }),
        },
      }),
      functions,
    );
    const handle = await runtime.jobs.enqueue("flows.observe", {});
    const wait = runtime.jobs.wait(handle.id);
    await runtime.runJobs();
    expect(await wait).toEqual({ ok: true, value: { seen: "observed", wrote: "observed" } });
    expect(logLines()).toEqual(["observed"]);
  });

  test("a returned Err is a journaled value, not a failure", async () => {
    clock = 4_000_000;
    let attempts = 0;
    start(
      declareJobs({
        flows: {
          dunning: job({
            args: {},
            retry: { attempts: 3, backoff: "fixed", delayMs: 1_000 },
            handler: async (ctx: Ctx) => {
              attempts++;
              const payment = await ctx.step.run("fns.payInvoice", { invoiceId: "bad" });
              if (!payment.ok) return { failed: payment.error.code };
              return { paid: true };
            },
          }),
        },
      }),
      functions,
    );
    const handle = await runtime.jobs.enqueue("flows.dunning", {});
    const wait = runtime.jobs.wait(handle.id);
    await runtime.runJobs();
    // The Err flowed back to the handler; the attempt itself succeeded.
    expect(await wait).toEqual({ ok: true, value: { failed: "invoice-unpayable" } });
    expect(attempts).toBe(1);
  });

  test("an unknown callee fails the attempt through the ordinary retry policy", async () => {
    clock = 5_000_000;
    start(
      declareJobs({
        flows: {
          typo: job({
            args: {},
            handler: async (ctx: Ctx) => await ctx.step.run("fns.doesNotExist", {}),
          }),
        },
      }),
      functions,
    );
    const handle = await runtime.jobs.enqueue("flows.typo", {});
    const wait = runtime.jobs.wait(handle.id);
    await runtime.runJobs();
    expect(await wait).toMatchObject({ ok: false, state: "discarded" });
  });
});

describe("mismatch refusals", () => {
  test("a duplicate step name in one run discards without consulting retry", async () => {
    clock = 6_000_000;
    start(
      declareJobs({
        flows: {
          doubled: job({
            args: {},
            retry: { attempts: 5 }, // never consulted: a mismatch is not retryable
            handler: async (ctx: Ctx) => {
              await ctx.step.procedure("once", async () => 1);
              await ctx.step.procedure("once", async () => 2);
            },
          }),
        },
      }),
    );
    const handle = await runtime.jobs.enqueue("flows.doubled", {});
    const wait = runtime.jobs.wait(handle.id);
    await runtime.runJobs();
    expect(await wait).toMatchObject({ ok: false, state: "discarded", nextRetryAt: null });
    const history = JSON.parse(jobRows()[0]!.attemptsJson) as Array<{
      outcome: string;
      error: string | null;
    }>;
    expect(history).toHaveLength(1);
    expect(history[0]!.error).toContain('step "once"');
    expect(history[0]!.error).toContain("duplicate");
  });

  test("changed args under a step.run name is the determinism tripwire", async () => {
    clock = 7_000_000;
    let nondeterministic = 0;
    start(
      declareJobs({
        flows: {
          drifting: job({
            args: {},
            retry: { attempts: 5, backoff: "fixed", delayMs: 1_000 },
            handler: async (ctx: Ctx) => {
              // The classic bug: a value from outside any step feeds args.
              const line = `line-${nondeterministic++}`;
              await ctx.step.run("fns.record", { line });
              throw new Error("later step fails");
            },
          }),
        },
      }),
      functions,
    );
    const handle = await runtime.jobs.enqueue("flows.drifting", {});
    let wait = runtime.jobs.wait(handle.id);
    await runtime.runJobs();
    expect(await wait).toMatchObject({ ok: false, state: "pending" });

    clock = 7_001_000;
    wait = runtime.jobs.wait(handle.id);
    await runtime.runJobs();
    const outcome = await wait;
    expect(outcome).toMatchObject({ ok: false, state: "discarded", nextRetryAt: null });
    const history = JSON.parse(jobRows()[0]!.attemptsJson) as Array<{ error: string | null }>;
    expect(history.at(-1)!.error).toContain("nondeterminism");
    // The first attempt's write committed with its journal entry, exactly once.
    expect(logLines()).toEqual(["line-0"]);
  });

  test("a kind change under a name discards, and retry after a code fix resumes", async () => {
    clock = 8_000_000;
    let sends = 0;
    const v1 = () =>
      declareJobs({
        flows: {
          notify: job({
            args: {},
            retry: { attempts: 5, backoff: "fixed", delayMs: 1_000 },
            handler: async (ctx: Ctx) => {
              await ctx.step.procedure("send", async () => ++sends);
              throw new Error("not done yet");
            },
          }),
        },
      });
    // v2 redeclares "send" as a different step kind: same name, changed meaning.
    const v2 = () =>
      declareJobs({
        flows: {
          notify: job({
            args: {},
            retry: { attempts: 5, backoff: "fixed", delayMs: 1_000 },
            handler: async (ctx: Ctx) => {
              await ctx.step.mutation("send", async () => "rewritten");
              return "v2";
            },
          }),
        },
      });

    start(v1());
    const handle = await runtime.jobs.enqueue("flows.notify", {});
    const wait = runtime.jobs.wait(handle.id);
    await runtime.runJobs();
    expect(await wait).toMatchObject({ ok: false, state: "pending" });
    expect(sends).toBe(1);

    await restart(v2());
    clock = 8_001_000;
    const mismatch = runtime.jobs.wait(handle.id);
    await runtime.runJobs();
    expect(await mismatch).toMatchObject({ ok: false, state: "discarded", nextRetryAt: null });

    // Deploying matching code again and using the retry verb resumes from the
    // journal: the recorded "send" answers, and the run completes.
    await restart(v1(), {});
    await restart(
      declareJobs({
        flows: {
          notify: job({
            args: {},
            handler: async (ctx: Ctx) => {
              const sent = await ctx.step.procedure("send", async () => ++sends);
              return { sent };
            },
          }),
        },
      }),
    );
    await runtime.jobs.retryNow(handle.id);
    const revived = runtime.jobs.wait(handle.id);
    await runtime.runJobs();
    expect(await revived).toEqual({ ok: true, value: { sent: 1 } });
    expect(sends).toBe(1); // answered from the journal, not re-run
  });
});

describe("step.sleep", () => {
  test("suspends to pending at the wake time without consuming an attempt", async () => {
    clock = 9_000_000;
    let before = 0;
    let after = 0;
    start(
      declareJobs({
        flows: {
          settle: job({
            args: {},
            handler: async (ctx: Ctx) => {
              await ctx.step.procedure("charge", async () => ++before);
              await ctx.step.sleep("settlement-window", 60_000);
              await ctx.step.procedure("receipt", async () => ++after);
              return { before, after };
            },
          }),
        },
      }),
    );

    const handle = await runtime.jobs.enqueue("flows.settle", {});
    const wait = runtime.jobs.wait(handle.id);
    await runtime.runJobs();
    // The awaiter learns the run is suspended and when it resumes.
    expect(await wait).toMatchObject({
      ok: false,
      state: "pending",
      nextRetryAt: 9_060_000,
    });
    expect(jobRows()[0]).toMatchObject({ state: "pending", runAt: 9_060_000, attempt: 0n });
    expect(before).toBe(1);
    expect(after).toBe(0);

    // Not due before the wake.
    clock = 9_030_000;
    await runtime.runJobs();
    expect(after).toBe(0);

    clock = 9_060_000;
    const resumed = runtime.jobs.wait(handle.id);
    await runtime.runJobs();
    expect(await resumed).toEqual({ ok: true, value: { before: 1, after: 1 } });
    expect(before).toBe(1); // replayed from the journal
    expect(jobRows()[0]).toMatchObject({ state: "completed", attempt: 1n });
  });
});
