/**
 * The one-way transform from the pre-split `_ackerdb_jobs` table to the Job /
 * Job run pair, exercised against a database that actually holds the released
 * `0.16.0` shape — rows and all.
 *
 * The old shape is rebuilt here rather than imported, because it no longer
 * exists in the source tree: `withJobsTables` leaves a schema that already
 * declares `_ackerdb_jobs` alone, so an Engine opened over this schema writes
 * exactly the database an older AckerDB left behind.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../../src/database/engine.ts";
import { reconcile } from "../../src/schema/reconcile.ts";
import { planFrameworkMigrations } from "../../src/schema/migrations/framework.ts";
import { canonicalSnapshotJson, snapshotOf } from "../../src/schema/snapshot.ts";
import { withFrameworkTables } from "../../src/database/framework-schema.ts";
import { defineSchema, defineTable, Schema, TableDef } from "../../src/schema/definition.ts";
import { defineMigration } from "../../src/schema/migrations/types.ts";
import { v } from "../../src/validation/v.ts";
import { JOB_RUNS_TABLE, JOBS_TABLE } from "../../src/jobs/table.ts";
import { declareJobs, job, type DeclaredJob } from "../../src/jobs/definition.ts";
import { Registry } from "../../src/app/registry.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { PRODUCTION_LIMITS } from "../../src/runtime/limits.ts";

// Tests exercise runtime ownership, not generated application types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

const directories: string[] = [];
afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

function freshPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "ackerdb-jobs-migrate-"));
  directories.push(directory);
  return join(directory, "data.db");
}

const application = defineSchema({
  log: defineTable({ id: v.primaryKey(), line: v.string() }),
});

/** `_ackerdb_jobs` exactly as `0.16.0` shipped it; `0.17.0` added `stepsJson`. */
function legacyJobsTable(withStepJournal: boolean): TableDef {
  const columns = {
    id: v.primaryKey(),
    name: v.string(),
    argsJson: v.string(),
    argsHash: v.string(),
    key: v.string().nullable(),
    state: v.string(),
    runAt: v.scheduleAt(),
    attempt: v.int(),
    attemptsJson: v.string(),
    ...(withStepJournal ? { stepsJson: v.string().nullable() } : {}),
    outputJson: v.string().nullable(),
    leaseToken: v.string().nullable(),
    leaseUntil: v.float().nullable(),
    enqueuedAt: v.float(),
    settledAt: v.float().nullable(),
  };
  return new TableDef(columns as never, "table")
    .index(["name", "argsHash"])
    .index(["state", "runAt"])
    .index(["state", "settledAt"]) as TableDef;
}

/** The pre-split root schema: the application plus the old jobs table. */
function legacySchema(withStepJournal: boolean): Schema {
  return new Schema(
    { ...application.tables, [JOBS_TABLE]: legacyJobsTable(withStepJournal) },
    new Map(application.namedTypes),
  );
}

interface LegacyRow {
  name: string;
  argsJson?: string;
  key?: string | null;
  state: string;
  runAt: number;
  attempt: number;
  attemptsJson: string;
  stepsJson?: string | null;
  outputJson?: string | null;
  leaseToken?: string | null;
  leaseUntil?: number | null;
  enqueuedAt: number;
  settledAt?: number | null;
}

const HASH_OF = new Map<string, string>();
function argsHashOf(argsJson: string): string {
  if (!HASH_OF.has(argsJson)) HASH_OF.set(argsJson, `hash-${HASH_OF.size}`);
  return HASH_OF.get(argsJson)!;
}

/** Write a populated pre-split database and return its path. */
function seedLegacy(rows: LegacyRow[], withStepJournal = true): string {
  const path = freshPath();
  const engine = new Engine(legacySchema(withStepJournal), path);
  reconcile(engine);
  const columns = [
    "name",
    "argsJson",
    "argsHash",
    "key",
    "state",
    "runAt",
    "attempt",
    "attemptsJson",
    ...(withStepJournal ? ["stepsJson"] : []),
    "outputJson",
    "leaseToken",
    "leaseUntil",
    "enqueuedAt",
    "settledAt",
  ];
  const insert = engine.writer.query(
    `INSERT INTO "${JOBS_TABLE}" (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
  );
  for (const row of rows) {
    const argsJson = row.argsJson ?? "{}";
    const values: unknown[] = [
      row.name,
      argsJson,
      argsHashOf(argsJson),
      row.key ?? null,
      row.state,
      row.runAt,
      row.attempt,
      row.attemptsJson,
      ...(withStepJournal ? [row.stepsJson ?? null] : []),
      row.outputJson ?? null,
      row.leaseToken ?? null,
      row.leaseUntil ?? null,
      row.enqueuedAt,
      row.settledAt ?? null,
    ];
    insert.run(...(values as never[]));
  }
  engine.close("clean");
  return path;
}

function attempt(
  startedAt: number,
  settledAt: number,
  outcome: string,
  error: string | null = null,
): Record<string, unknown> {
  return { startedAt, settledAt, outcome, error, durationMs: settledAt - startedAt };
}

/** Open the upgraded schema and run the startup pass an empty chain takes. */
async function upgrade(path: string): Promise<Engine> {
  const engine = new Engine(application, path);
  await reconcile(engine, []);
  return engine;
}

function jobRows(engine: Engine): Record<string, unknown>[] {
  return engine.reader.query(`SELECT * FROM "${JOBS_TABLE}" ORDER BY id`).all() as never;
}

function runRows(engine: Engine): Record<string, unknown>[] {
  return engine.reader
    .query(`SELECT * FROM "${JOB_RUNS_TABLE}" ORDER BY jobId, number`)
    .all() as never;
}

describe("the pre-split jobs table is transformed, never dropped", () => {
  test("every Job survives, and every recorded attempt becomes the run it was", async () => {
    const path = seedLegacy([
      // Never claimed: scheduling intent is still exactly what was admitted.
      {
        name: "work.later",
        state: "pending",
        runAt: 5_000,
        attempt: 0,
        attemptsJson: "[]",
        enqueuedAt: 1_000,
      },
      // Two failures behind it, waiting out a backoff: a Retrying Job.
      {
        name: "work.flaky",
        argsJson: '{"n":1}',
        key: "k1",
        state: "pending",
        runAt: 9_000,
        attempt: 2,
        attemptsJson: JSON.stringify([
          attempt(2_000, 2_100, "failed", "Error: boom 1"),
          attempt(4_000, 4_100, "failed", "Error: boom 2"),
        ]),
        enqueuedAt: 1_000,
      },
      // Settled with a memoized outcome.
      {
        name: "work.done",
        argsJson: '{"n":2}',
        state: "completed",
        runAt: 3_000,
        attempt: 1,
        attemptsJson: JSON.stringify([attempt(3_000, 3_500, "completed")]),
        outputJson: '{"ok":true}',
        enqueuedAt: 1_000,
        settledAt: 3_500,
      },
      // Exhausted: the released vocabulary called this discarded.
      {
        name: "work.doomed",
        argsJson: '{"n":3}',
        state: "discarded",
        runAt: 6_000,
        attempt: 1,
        attemptsJson: JSON.stringify([attempt(6_000, 6_200, "discarded", "Error: always fails")]),
        enqueuedAt: 1_000,
        settledAt: 6_200,
      },
      // Canceled while running: the recorded attempt was canceled with it.
      {
        name: "work.stopped",
        argsJson: '{"n":4}',
        state: "canceled",
        runAt: 7_000,
        attempt: 1,
        attemptsJson: JSON.stringify([attempt(7_000, 7_050, "canceled")]),
        enqueuedAt: 1_000,
        settledAt: 7_050,
      },
    ]);

    const engine = await upgrade(path);
    const jobs = jobRows(engine);
    const runs = runRows(engine);

    expect(jobs.map((row) => [row["name"], row["state"], row["runCount"]])).toEqual([
      ["work.later", "pending", 0n],
      ["work.flaky", "retrying", 2n],
      ["work.done", "completed", 1n],
      // `discarded` is the old name of a Failed Job.
      ["work.doomed", "failed", 1n],
      ["work.stopped", "canceled", 1n],
    ]);

    // Identity, journal, and scheduling intent carry over untouched.
    expect(jobs[1]).toMatchObject({
      argsJson: '{"n":1}',
      key: "k1",
      trigger: "enqueue",
      parentJobId: null,
      nextRunAt: 9_000,
      enqueuedAt: 1_000,
      nextRunTrigger: null,
      // The old row overwrote its due time on every retry; the first run is the
      // only surviving evidence of the occurrence it was admitted for.
      scheduledAt: 2_000,
    });
    // A Job that never ran still carries its admitted occurrence.
    expect(jobs[0]).toMatchObject({ scheduledAt: 5_000, nextRunAt: 5_000, runCount: 0n });
    // A Job that never ran has no invented run.
    expect(runs.filter((run) => run["jobId"] === jobs[0]!["id"])).toEqual([]);

    expect(
      runs.map((run) => [run["number"], run["trigger"], run["state"], run["errorText"]]),
    ).toEqual([
      [1n, "initial", "failed", "Error: boom 1"],
      [2n, "automatic_retry", "failed", "Error: boom 2"],
      [1n, "initial", "completed", null],
      [1n, "initial", "failed", "Error: always fails"],
      [1n, "initial", "canceled", null],
    ]);

    // The completed Job's output moved onto the run that produced it.
    const completed = runs.find((run) => run["jobId"] === jobs[2]!["id"])!;
    expect(completed).toMatchObject({
      outputJson: '{"ok":true}',
      startedAt: 3_000,
      settledAt: 3_500,
    });
    // Retention belongs to a definition that is not loaded during schema work,
    // so migrated rows are retained rather than guessed at.
    expect(jobs.every((row) => row["deleteAfter"] === null)).toBe(true);
    expect(runs.every((run) => run["deleteAfter"] === null)).toBe(true);

    engine.close("clean");
  });

  test("a database that predates the step journal migrates just as exactly", async () => {
    const path = seedLegacy(
      [{
        name: "work.old",
        state: "completed",
        runAt: 3_000,
        attempt: 1,
        attemptsJson: JSON.stringify([attempt(3_000, 3_100, "completed")]),
        outputJson: '"value"',
        enqueuedAt: 1_000,
        settledAt: 3_100,
      }],
      false,
    );
    const engine = await upgrade(path);
    expect(jobRows(engine)).toMatchObject([{ state: "completed", stepsJson: null, runCount: 1n }]);
    expect(runRows(engine)).toMatchObject([{ number: 1n, state: "completed", outputJson: '"value"' }]);
    engine.close("clean");
  });

  test("an in-flight Job keeps its lease on its run so recovery finishes it", async () => {
    const path = seedLegacy([{
      name: "work.crashed",
      state: "running",
      runAt: 4_000,
      attempt: 2,
      attemptsJson: JSON.stringify([attempt(2_000, 2_100, "failed", "Error: first")]),
      leaseToken: "lease-1",
      leaseUntil: 34_000,
      enqueuedAt: 1_000,
    }]);
    const engine = await upgrade(path);
    expect(jobRows(engine)).toMatchObject([{ state: "running", runCount: 2n }]);
    expect(runRows(engine)).toMatchObject([
      { number: 1n, state: "failed", leaseToken: null },
      { number: 2n, state: "running", leaseToken: "lease-1", leaseUntil: 34_000, settledAt: null },
    ]);
    engine.close("clean");
  });

  test("an unreadable attempt history still keeps the Job and its retry budget", async () => {
    const path = seedLegacy([{
      name: "work.corrupt",
      state: "pending",
      runAt: 9_000,
      attempt: 3,
      attemptsJson: "{not json",
      enqueuedAt: 1_000,
    }]);
    const engine = await upgrade(path);
    // ADR-0018 promises the admitted job is durable: the Job survives, and the
    // runs it claims to have had are materialized so the retry policy sees the
    // same budget it saw before the upgrade.
    expect(jobRows(engine)).toMatchObject([{ state: "retrying", runCount: 3n }]);
    const runs = runRows(engine);
    expect(runs.map((run) => run["number"])).toEqual([1n, 2n, 3n]);
    expect(runs.every((run) => run["state"] === "failed")).toBe(true);
    expect(runs[0]!["errorText"]).toContain("unreadable");
    engine.close("clean");
  });

  test("the transform runs while the old shape is on disk, and never again", async () => {
    const path = seedLegacy([{
      name: "work.once",
      state: "completed",
      runAt: 3_000,
      attempt: 1,
      attemptsJson: JSON.stringify([attempt(3_000, 3_100, "completed")]),
      outputJson: "1",
      enqueuedAt: 1_000,
      settledAt: 3_100,
    }]);

    const first = await upgrade(path);
    const after = first.loadSnapshot()!;
    const jobsAfter = JSON.stringify(jobRows(first), (_k, value) =>
      typeof value === "bigint" ? String(value) : value);
    const runsAfter = JSON.stringify(runRows(first), (_k, value) =>
      typeof value === "bigint" ? String(value) : value);
    // A framework migration is recognized by shape, not by a recorded identity:
    // it takes no number in the application's chain and writes no history row.
    expect(first.writer.query("SELECT COUNT(*) AS n FROM _ackerdb_migrations").get())
      .toEqual({ n: 0n });
    first.close("clean");

    const second = await upgrade(path);
    expect(canonicalSnapshotJson(second.loadSnapshot()!)).toBe(canonicalSnapshotJson(after));
    expect(JSON.stringify(jobRows(second), (_k, value) =>
      typeof value === "bigint" ? String(value) : value)).toBe(jobsAfter);
    expect(JSON.stringify(runRows(second), (_k, value) =>
      typeof value === "bigint" ? String(value) : value)).toBe(runsAfter);
    second.close("clean");
  });

  test("the snapshot the CLI diffs against is the one the server will store", async () => {
    const path = seedLegacy([{
      name: "work.any",
      state: "pending",
      runAt: 5_000,
      attempt: 0,
      attemptsJson: "[]",
      enqueuedAt: 1_000,
    }]);
    const before = new Engine(legacySchema(true), path);
    const stored = before.loadSnapshot()!;
    before.close("clean");

    const engine = await upgrade(path);
    // The CLI never opens an Engine; its pure advance must land on exactly the
    // snapshot the server commits, or a developer is asked to migrate a table
    // they do not declare.
    expect(canonicalSnapshotJson(planFrameworkMigrations(stored).snapshot))
      .toBe(canonicalSnapshotJson(engine.loadSnapshot()!));
    expect(canonicalSnapshotJson(engine.loadSnapshot()!))
      .toBe(canonicalSnapshotJson(snapshotOf(withFrameworkTables(application))));
    engine.close("clean");
  });

  test("the chain-free entry refuses loudly instead of reporting framework refusals", () => {
    const path = seedLegacy([{
      name: "work.any",
      state: "pending",
      runAt: 5_000,
      attempt: 0,
      attemptsJson: "[]",
      enqueuedAt: 1_000,
    }]);
    const engine = new Engine(application, path);
    expect(() => reconcile(engine)).toThrow(/split_jobs_into_runs/);
    engine.close("clean");
  });

  test("an application chain applies across the upgrade, whichever side it was generated on", async () => {
    // The two chains a developer can actually be holding when they upgrade:
    // one generated before the framework changed (its snapshots carry the old
    // jobs table) and one generated after but before the server ever opened
    // the database (its snapshots carry the new pair). Neither is about
    // `_ackerdb_jobs`, and neither may be refused for it.
    const widened = defineSchema({
      log: defineTable({ id: v.primaryKey(), line: v.string(), level: v.string() }),
    });
    for (const generatedAgainst of ["old", "new"] as const) {
      const path = seedLegacy([{
        name: "work.any",
        state: "pending",
        runAt: 5_000,
        attempt: 0,
        attemptsJson: "[]",
        enqueuedAt: 1_000,
      }]);
      const peek = new Engine(legacySchema(true), path);
      peek.writer.query('INSERT INTO "log" (line) VALUES (?)').run("before");
      const stored = peek.loadSnapshot()!;
      peek.close("clean");

      const pre = generatedAgainst === "old" ? stored : planFrameworkMigrations(stored).snapshot;
      const target = generatedAgainst === "old"
        ? {
            version: 2 as const,
            tables: {
              ...snapshotOf(widened).tables,
              [JOBS_TABLE]: stored.tables[JOBS_TABLE]!,
            },
          }
        : snapshotOf(withFrameworkTables(widened));

      const engine = new Engine(widened, path);
      await reconcile(engine, [{
        number: 1,
        name: "add_level",
        pre,
        target,
        code: "",
        migration: defineMigration({
          tables: { log: (row) => ({ ...row, level: "info" }) },
        }),
      }]);

      // The application's own change applied, the jobs tables reached the live
      // shape, and the seeded Job survived both.
      expect(engine.reader.query('SELECT line, level FROM "log"').all())
        .toEqual([{ line: "before", level: "info" }]);
      expect(jobRows(engine)).toMatchObject([{ name: "work.any", state: "pending", runCount: 0n }]);
      expect(canonicalSnapshotJson(engine.loadSnapshot()!))
        .toBe(canonicalSnapshotJson(snapshotOf(withFrameworkTables(widened))));
      expect(engine.writer.query("SELECT COUNT(*) AS n FROM _ackerdb_migrations").get())
        .toEqual({ n: 1n });
      engine.close("clean");
    }
  });

  test("an application migration may not transform a framework-owned table", async () => {
    const path = seedLegacy([{
      name: "work.durable",
      state: "pending",
      runAt: 5_000,
      attempt: 0,
      attemptsJson: "[]",
      enqueuedAt: 1_000,
    }]);
    const engine = new Engine(application, path);
    const stored = engine.loadSnapshot()!;
    // A transform returning null deletes every row it is handed. Over
    // `_ackerdb_jobs` that is every durable job in the database — so the
    // framework refuses the entry rather than running it.
    await expect(reconcile(engine, [{
      number: 1,
      name: "hostile",
      pre: stored,
      target: stored,
      code: "",
      migration: defineMigration({ tables: { [JOBS_TABLE]: () => null } }),
    }])).rejects.toThrow(/framework-owned table/);
    engine.close("clean");

    // Nothing was touched: the Job is still there for the real migration.
    const upgraded = await upgrade(path);
    expect(jobRows(upgraded)).toMatchObject([{ name: "work.durable", state: "pending" }]);
    upgraded.close("clean");
  });

  test("an application migration may not emit into a framework-owned table", async () => {
    const path = seedLegacy([]);
    const engine = new Engine(application, path);
    const stored = engine.loadSnapshot()!;
    engine.writer.query('INSERT INTO "log" (line) VALUES (?)').run("seed");
    // A forged Job row would be a job nothing admitted: no validated
    // arguments, no computed identity, no dedupe. The emit is refused.
    await expect(reconcile(engine, [{
      number: 1,
      name: "forge",
      pre: stored,
      target: stored,
      code: "",
      migration: defineMigration({
        tables: {
          log: (row, ctx) => {
            ctx.insert(JOBS_TABLE, {
              name: "work.fake",
              argsJson: "{}",
              argsHash: "forged",
              key: null,
              state: "pending",
              trigger: "enqueue",
              parentJobId: null,
              scheduledAt: 0,
              nextRunAt: 0,
              runCount: 0,
              nextRunTrigger: null,
              stepsJson: "[]",
              enqueuedAt: 0,
              settledAt: null,
              deleteAfter: null,
            });
            return row;
          },
        },
      }),
    }])).rejects.toThrow(/framework-owned/);
    engine.close("clean");

    const upgraded = await upgrade(path);
    expect(jobRows(upgraded)).toHaveLength(0);
    upgraded.close("clean");
  });

  test("a malformed attempt keeps its position instead of renumbering the rest", async () => {
    const path = seedLegacy([{
      name: "work.dented",
      state: "completed",
      runAt: 3_000,
      attempt: 3,
      attemptsJson: JSON.stringify([
        attempt(1_000, 1_100, "failed", "Error: one"),
        { garbage: true },
        attempt(3_000, 3_100, "completed"),
      ]),
      outputJson: '"done"',
      enqueuedAt: 1_000,
      settledAt: 3_100,
    }]);
    const engine = await upgrade(path);
    // Attempt 3 stays run 3, so the Job's recorded output lands on the run
    // that produced it rather than on a renumbered neighbour.
    expect(runRows(engine).map((run) => [run["number"], run["state"], run["outputJson"]])).toEqual([
      [1n, "failed", null],
      [2n, "failed", null],
      [3n, "completed", '"done"'],
    ]);
    expect(runRows(engine)[1]!["errorText"]).toContain("unreadable");
    engine.close("clean");
  });

  test("a terminal Job whose last attempt is unreadable takes its outcome from itself", async () => {
    const path = seedLegacy([
      {
        name: "work.won",
        argsJson: '{"n":1}',
        state: "completed",
        runAt: 3_000,
        attempt: 1,
        // Readable JSON, unreadable entry — and it is the entry the Job's
        // outcome lives on.
        attemptsJson: JSON.stringify([{ startedAt: "not a number", outcome: "completed" }]),
        outputJson: '"kept"',
        enqueuedAt: 1_000,
        settledAt: 3_100,
      },
      {
        name: "work.lost",
        argsJson: '{"n":2}',
        state: "discarded",
        runAt: 4_000,
        attempt: 1,
        // An object-valued error would reach the new table's validator and
        // roll the whole migration back if it were let through.
        attemptsJson: JSON.stringify([
          { startedAt: 4_000, settledAt: 4_100, outcome: "discarded", error: { deep: true } },
        ]),
        enqueuedAt: 1_000,
        settledAt: 4_100,
      },
    ]);
    const engine = await upgrade(path);
    expect(jobRows(engine).map((row) => row["state"])).toEqual(["completed", "failed"]);
    // A completed Job answers with its recorded output, never with `undefined`
    // from a run the migration invented as failed.
    expect(runRows(engine)).toMatchObject([
      { jobId: 1n, number: 1n, state: "completed", outputJson: '"kept"' },
      { jobId: 2n, number: 1n, state: "failed", outputJson: null },
    ]);
    for (const run of runRows(engine)) expect(run["errorText"]).toContain("unreadable");
    engine.close("clean");
  });

  test("a state this migration does not understand refuses instead of inventing a failure", async () => {
    // The five states 0.16.0 could persist are all mapped, so reaching this
    // means the database was not written by a version this transform knows.
    // The transform is one-way and drops the source table, so coercing the
    // unknown to "failed" would record a guess as an outcome and destroy the
    // row that could have explained it. Refuse, and leave the database intact.
    const path = seedLegacy([
      {
        name: "work.strange",
        argsJson: "{}",
        state: "quarantined",
        runAt: 3_000,
        attempt: 0,
        attemptsJson: "[]",
        enqueuedAt: 1_000,
      },
    ]);
    await expect(upgrade(path)).rejects.toThrow(/unrecognized state "quarantined"/);
  });

  test("a Job suspended in step.sleep resumes as the run the old model would have claimed", async () => {
    let clock = 200_000;
    // What the old `step.sleep` transaction left behind: pending, woken at the
    // journaled time, and one attempt *given back* so the resume reclaims it.
    const path = seedLegacy([{
      name: "work.sleeper",
      state: "pending",
      runAt: 200_000,
      attempt: 1,
      attemptsJson: JSON.stringify([attempt(1_000, 1_100, "failed", "Error: first")]),
      stepsJson: JSON.stringify([{ name: "hold", kind: "sleep", wakeAt: 200_000, completedAt: 1_500 }]),
      enqueuedAt: 1_000,
    }]);
    const engine = await upgrade(path);
    expect(jobRows(engine)).toMatchObject([{ state: "retrying", runCount: 1n, stepsJson: expect.any(String) }]);

    const seen: number[] = [];
    const runtime = new Runtime({
      engine,
      registry: new Registry({}),
      limits: PRODUCTION_LIMITS,
      jobs: declareJobs({
        work: {
          sleeper: job({
            args: {},
            handler: async (ctx: Ctx) => {
              seen.push(ctx.runNumber);
              await ctx.step.sleep("hold", 60_000); // recorded: satisfied by the claim
              return "woke";
            },
          }),
        },
      }),
      now: () => clock,
    } as Ctx);

    await runtime.runJobs();
    await Bun.sleep(20);
    // The old model would have claimed this as attempt 2, and so does the new
    // one — the sleep gave its attempt back before the upgrade, and the
    // journal answers the recorded step instead of sleeping again.
    expect(seen).toEqual([2]);
    expect(jobRows(engine)).toMatchObject([{ state: "completed", runCount: 2n }]);
    expect(runRows(engine).map((run) => Number(run["number"]))).toEqual([1, 2]);
    await runtime.drain().catch(() => {});
    engine.close("clean");
  });

  test("the runner picks a migrated Job up where the old model left it", async () => {
    const clock = 100_000;
    const path = seedLegacy([{
      name: "work.crashed",
      state: "running",
      runAt: 4_000,
      attempt: 1,
      attemptsJson: "[]",
      leaseToken: "lease-1",
      leaseUntil: 34_000,
      enqueuedAt: 1_000,
    }]);
    const engine = await upgrade(path);
    const declared: DeclaredJob[] = declareJobs({
      work: {
        crashed: job({
          args: {},
          retry: { attempts: 3, backoff: "fixed", delayMs: 0 },
          handler: async () => "recovered",
        }),
      },
    });
    const runtime = new Runtime({
      engine,
      registry: new Registry({}),
      limits: PRODUCTION_LIMITS,
      jobs: declared,
      now: () => clock,
    } as Ctx);

    // The lease it carried across the upgrade is already expired: recovery
    // settles the run it inherited through the retry policy, and the next run
    // of the same Job finishes the work the old model had admitted.
    await runtime.runJobs();
    await Bun.sleep(20);
    expect(jobRows(engine)).toMatchObject([{ state: "completed", runCount: 2n }]);
    expect(runRows(engine)).toMatchObject([
      { number: 1n, trigger: "initial", state: "failed" },
      { number: 2n, trigger: "automatic_retry", state: "completed", outputJson: '"recovered"' },
    ]);
    expect(runRows(engine)[0]!["errorText"]).toContain("lease expired");
    await runtime.drain().catch(() => {});
    engine.close("clean");
  });
});
