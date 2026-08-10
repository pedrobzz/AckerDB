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
import { JOB_RUNS_TABLE, JOBS_TABLE } from "../../src/jobs/table.ts";
import { mutation, procedure, query } from "../../src/app/functions.ts";
import { ANONYMOUS_PRINCIPAL } from "../../src/auth/credentials.ts";

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
    registry: new Registry(functions, ["internal"]),
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
    registry: new Registry(functions, ["internal"]),
    limits: limits(),
    jobs,
    now: () => clock,
  });
}

function jobRows(): Array<{
  id: bigint;
  state: string;
  nextRunAt: number;
  runCount: bigint;
  stepsJson: string | null;
}> {
  return engine.reader
    .query(
      `SELECT id, state, nextRunAt, runCount, stepsJson FROM "${JOBS_TABLE}" ORDER BY id`,
    )
    .all() as never;
}

function runRows(): Array<{
  id: bigint;
  jobId: bigint;
  number: bigint;
  state: string;
  errorText: string | null;
}> {
  return engine.reader
    .query(
      `SELECT id, jobId, number, state, errorText FROM "${JOB_RUNS_TABLE}" ORDER BY jobId, number`,
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
  apiPath: "internal",
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
  apiPath: "internal",
  access: "authenticated",
  args: { invoiceId: v.string() },
  handler: (_ctx: Ctx, args: Ctx) =>
    args.invoiceId === "bad"
      ? Err("invoice-unpayable", { invoiceId: args.invoiceId }, Status.UnprocessableContent)
      : { paid: args.invoiceId },
});
const functions = { fns: { record, snapshot, payInvoice } };

describe("step replay", () => {
  test("a retried run re-executes only unrecorded steps", async () => {
    clock = 1_000_000;
    let externalCalls = 0;
    let attempts = 0;
    start(
      declareJobs({
        flows: {
          fulfill: job({
            args: {},
            retry: (runNumber: number) => (runNumber < 3 ? 1_000 : null),
            handler: async (ctx: Ctx) => {
              const charged = await ctx.step.procedure("charge", async () => {
                externalCalls++;
                return { receipt: `r-${externalCalls}` };
              });
              const written = await ctx.step.run("internal.fns.record", { line: charged.receipt });
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
    expect(await wait).toMatchObject({ ok: false, state: "retrying" });

    clock = 1_001_000;
    wait = runtime.jobs.wait(handle.id);
    await runtime.runJobs();
    expect(await wait).toMatchObject({ ok: false, state: "retrying" });

    clock = 1_002_000;
    wait = runtime.jobs.wait(handle.id);
    await runtime.runJobs();
    expect(await wait).toEqual({ ok: true, value: "r-1" });

    // The external call and the mutation ran exactly once across 3 runs.
    expect(externalCalls).toBe(1);
    expect(logLines()).toEqual(["r-1"]);
    expect(journalNames()).toEqual(["charge", "internal.fns.record"]);
    expect(jobRows()[0]).toMatchObject({ state: "completed", runCount: 3n });
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
    expect(await wait).toMatchObject({ ok: false, state: "retrying" });
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
              const seen = await ctx.step.run("api.fns.snapshot", {});
              const written = await ctx.step.run("internal.fns.record", { line: seen.data });
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
              const payment = await ctx.step.run("internal.fns.payInvoice", { invoiceId: "bad" });
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
    // The Err flowed back to the handler; the run itself succeeded.
    expect(await wait).toEqual({ ok: true, value: { failed: "invoice-unpayable" } });
    expect(attempts).toBe(1);
  });

  test("an unknown callee fails the run through the ordinary retry policy", async () => {
    clock = 5_000_000;
    start(
      declareJobs({
        flows: {
          typo: job({
            args: {},
            handler: async (ctx: Ctx) => await ctx.step.run("api.fns.doesNotExist", {}),
          }),
        },
      }),
      functions,
    );
    const handle = await runtime.jobs.enqueue("flows.typo", {});
    const wait = runtime.jobs.wait(handle.id);
    await runtime.runJobs();
    expect(await wait).toMatchObject({ ok: false, state: "failed" });
  });
});

describe("mismatch refusals", () => {
  test("a duplicate step name in one run fails without consulting retry", async () => {
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
    expect(await wait).toMatchObject({ ok: false, state: "failed", nextRetryAt: null });
    const history = runRows();
    expect(history).toHaveLength(1);
    expect(history[0]!.errorText).toContain('step "once"');
    expect(history[0]!.errorText).toContain("duplicate");
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
              await ctx.step.run("internal.fns.record", { line });
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
    expect(await wait).toMatchObject({ ok: false, state: "retrying" });

    clock = 7_001_000;
    wait = runtime.jobs.wait(handle.id);
    await runtime.runJobs();
    const outcome = await wait;
    expect(outcome).toMatchObject({ ok: false, state: "failed", nextRetryAt: null });
    const history = runRows();
    expect(history.at(-1)!.errorText).toContain("nondeterminism");
    // The first run's write committed with its journal entry, exactly once.
    expect(logLines()).toEqual(["line-0"]);
  });

  test("a kind change under a name fails, and retry after a code fix resumes", async () => {
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
    expect(await wait).toMatchObject({ ok: false, state: "retrying" });
    expect(sends).toBe(1);

    await restart(v2());
    clock = 8_001_000;
    const mismatch = runtime.jobs.wait(handle.id);
    await runtime.runJobs();
    expect(await mismatch).toMatchObject({ ok: false, state: "failed", nextRetryAt: null });

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
    await runtime.jobs.retry(handle.id);
    const revived = runtime.jobs.wait(handle.id);
    await runtime.runJobs();
    expect(await revived).toEqual({ ok: true, value: { sent: 1 } });
    expect(sends).toBe(1); // answered from the journal, not re-run
  });
});

describe("step.sleep", () => {
  test("suspends to pending at the wake time without consuming a run", async () => {
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
    expect(jobRows()[0]).toMatchObject({ state: "pending", nextRunAt: 9_060_000, runCount: 1n });
    // The run is suspended, not settled: it is the same run that resumes.
    expect(runRows()).toMatchObject([{ number: 1n, state: "running" }]);
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
    expect(jobRows()[0]).toMatchObject({ state: "completed", runCount: 1n });
    expect(runRows()).toMatchObject([{ number: 1n, state: "completed" }]);
  });

  test("a handler that swallows the sleep signal is a stale run", async () => {
    clock = 10_000_000;
    let leaked: string | null = null;
    start(
      declareJobs({
        flows: {
          swallower: job({
            args: {},
            handler: async (ctx: Ctx) => {
              try {
                await ctx.step.sleep("pause", 60_000);
              } catch {
                // The suspend already committed; this run is over. Any
                // further step call must refuse, and the late settle must be
                // discarded on the stale lease.
                try {
                  await ctx.step.procedure("after", async () => "leaked effect");
                } catch (error: Ctx) {
                  leaked = error.code;
                }
                return { escaped: true };
              }
              const after = await ctx.step.procedure("after", async () => "ran");
              return { after };
            },
          }),
        },
      }),
    );

    const handle = await runtime.jobs.enqueue("flows.swallower", {});
    const wait = runtime.jobs.wait(handle.id);
    await runtime.runJobs();
    expect(await wait).toMatchObject({ ok: false, state: "pending", nextRetryAt: 10_060_000 });
    // The waiter resolved at the suspend; let the zombie run finish out.
    while (runtime.jobs.runningCount > 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // The swallowed signal changed nothing: still suspended, nothing leaked,
    // the zombie's "completed" settle was discarded.
    expect(leaked ?? "never-refused").toBe("unavailable");
    expect(jobRows()[0]).toMatchObject({ state: "pending", nextRunAt: 10_060_000, runCount: 1n });

    // At the wake the run replays; the recorded sleep is satisfied, so the
    // same catch-happy code proceeds normally.
    clock = 10_060_000;
    const resumed = runtime.jobs.wait(handle.id);
    await runtime.runJobs();
    expect(await resumed).toEqual({ ok: true, value: { after: "ran" } });
  });

  test("reschedule moves a sleeping run's wake: the row's due time is the authority", async () => {
    clock = 11_000_000;
    let after = 0;
    start(
      declareJobs({
        flows: {
          patient: job({
            args: {},
            handler: async (ctx: Ctx) => {
              await ctx.step.sleep("wait-out", 60_000);
              await ctx.step.procedure("after", async () => ++after);
              return after;
            },
          }),
        },
      }),
    );

    const handle = await runtime.jobs.enqueue("flows.patient", {});
    const wait = runtime.jobs.wait(handle.id);
    await runtime.runJobs();
    expect(await wait).toMatchObject({ ok: false, state: "pending", nextRetryAt: 11_060_000 });

    // An operator moves the wake earlier; the journaled wakeAt does not
    // override the row's due time.
    await runtime.jobs.reschedule(handle.id, 11_010_000);
    clock = 11_010_000;
    const resumed = runtime.jobs.wait(handle.id);
    await runtime.runJobs();
    expect(await resumed).toEqual({ ok: true, value: 1 });
    expect(jobRows()[0]).toMatchObject({ state: "completed" });
  });
});

describe("journal integrity", () => {
  test("an unreadable journal refuses instead of replaying from nothing", async () => {
    clock = 12_000_000;
    let externalCalls = 0;
    start(
      declareJobs({
        flows: {
          careful: job({
            args: {},
            retry: { attempts: 5, backoff: "fixed", delayMs: 1_000 },
            handler: async (ctx: Ctx) => {
              await ctx.step.procedure("charge", async () => ++externalCalls);
              throw new Error("later step fails");
            },
          }),
        },
      }),
    );
    const handle = await runtime.jobs.enqueue("flows.careful", {});
    const wait = runtime.jobs.wait(handle.id);
    await runtime.runJobs();
    expect(await wait).toMatchObject({ ok: false, state: "retrying" });
    expect(externalCalls).toBe(1);

    // Simulated corruption of durable state.
    engine.writer.exec(`UPDATE "${JOBS_TABLE}" SET stepsJson = '{broken' WHERE id = ${handle.id}`);

    clock = 12_001_000;
    const corrupted = runtime.jobs.wait(handle.id);
    await runtime.runJobs();
    // Fail closed: failed with typed evidence — never a replay that
    // re-charges, and never a retry into the same unreadable journal.
    expect(await corrupted).toMatchObject({ ok: false, state: "failed", nextRetryAt: null });
    expect(externalCalls).toBe(1);
    const row = jobRows()[0]!;
    expect(row.stepsJson).toBe("{broken"); // the bytes are preserved evidence
    const history = runRows();
    expect(history.at(-1)!.errorText).toContain("journal");
  });

  test("an impossible entry — readable JSON, invalid shape — also refuses", async () => {
    clock = 12_500_000;
    let externalCalls = 0;
    start(
      declareJobs({
        flows: {
          strict: job({
            args: {},
            retry: { attempts: 5, backoff: "fixed", delayMs: 1_000 },
            handler: async (ctx: Ctx) => {
              await ctx.step.procedure("charge", async () => ++externalCalls);
              throw new Error("later step fails");
            },
          }),
        },
      }),
    );
    const handle = await runtime.jobs.enqueue("flows.strict", {});
    const wait = runtime.jobs.wait(handle.id);
    await runtime.runJobs();
    expect(await wait).toMatchObject({ ok: false, state: "retrying" });

    // A run entry with no recorded result can never replay unambiguously.
    engine.writer.exec(
      `UPDATE "${JOBS_TABLE}" SET stepsJson = '[{"name":"charge","kind":"run","completedAt":1}]' WHERE id = ${handle.id}`,
    );
    clock = 12_501_000;
    const refused = runtime.jobs.wait(handle.id);
    await runtime.runJobs();
    expect(await refused).toMatchObject({ ok: false, state: "failed", nextRetryAt: null });
    expect(externalCalls).toBe(1);
  });

  test("a non-empty journal binds the row to its original arguments", async () => {
    clock = 13_000_000;
    const surgery = mutation({
      access: "public",
      http: true,
      args: { id: v.bigint(), argsJson: v.string() },
      handler: async (ctx: Ctx, args: Ctx) => {
        await ctx.db[JOBS_TABLE].patch(args.id, { argsJson: args.argsJson });
        return "ok";
      },
    });
    start(
      declareJobs({
        flows: {
          bound: job({
            args: { input: v.string() },
            handler: async (ctx: Ctx, args: Ctx) => {
              await ctx.step.procedure("record-input", async () => args.input);
              await ctx.step.sleep("hold", 60_000);
              return args.input;
            },
          }),
        },
      }),
      { admin: { surgery } },
    );

    const handle = await runtime.jobs.enqueue("flows.bound", { input: "original" });
    const wait = runtime.jobs.wait(handle.id);
    await runtime.runJobs();
    // Suspended by the sleep, not failed: the Job is pending on its wake time.
    expect(await wait).toMatchObject({ ok: false, state: "pending" });

    const patched = await runtime.runMutation({
      id: 1,
      address: "api.admin.surgery",
      args: { id: handle.id, argsJson: '{"input":"replaced"}' },
      principal: ANONYMOUS_PRINCIPAL,
      respond: ({ body, status }: Ctx) => new Response(body, { status }),
    });
    expect(patched.status).not.toBe(200);
    expect(await patched.text()).toContain("binds this row to its original arguments");
  });
});
