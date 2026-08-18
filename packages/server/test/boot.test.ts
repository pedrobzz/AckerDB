/**
 * The boot, observed from outside: what the listener answers, what the
 * reporter was told, what storage looks like after drain, and that a failed
 * or interrupted boot releases ownership so the next boot succeeds. No test
 * here asserts constructor order or private wiring.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { defineApp } from "../src/app/definition.ts";
import { mutation, procedure } from "../src/app/functions.ts";
import { LocalFileStore } from "../src/files/store/local.ts";
import { job } from "../src/jobs/definition.ts";
import { JOBS_TABLE } from "../src/jobs/table.ts";
import { defineServiceLimits, PRODUCTION_LIMITS } from "../src/runtime/limits.ts";
import { defineSchema, defineTable } from "../src/schema/definition.ts";
import type { MigrationStep } from "../src/schema/migrations/types.ts";
import { snapshotOf } from "../src/schema/snapshot.ts";
import { v } from "../src/validation/v.ts";
import { AckerDBError } from "../src/shared/errors.ts";
import {
  testDefinitions,
  type TestDefinitionModules,
} from "ackerdb-test-support/server";
import {
  boot,
  MigrationsHeldError,
  type BootOptions,
  type BootReporter,
  type RunningApp,
} from "../src/boot.ts";
import type { AckerDBStartupPhase } from "../src/transport/server.ts";
import { within } from "ackerdb-test-support/async";

const limits = defineServiceLimits({ ...PRODUCTION_LIMITS, gracefulShutdownMs: 2_000 });

// Boot tests do not exercise generated application types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

const schema = defineSchema({
  notes: defineTable({ id: v.primaryKey(), body: v.string() }),
});
const app = defineApp({ schema });

const functions: TestDefinitionModules = {
  notes: {
    add: mutation({
      access: "public",
      http: true,
      args: { body: v.string() },
      handler: (ctx: Ctx, args: Ctx) => ctx.db.notes.insert(args),
    }),
    ping: procedure({
      access: "public",
      http: true,
      args: {},
      handler: () => "pong",
    }),
  },
};

const dirs: string[] = [];
const running: RunningApp[] = [];
afterEach(async () => {
  for (const app of running.splice(0)) await app.drain().catch(() => {});
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "ackerdb-boot-"));
  dirs.push(dir);
  return dir;
}

interface PartsOverrides {
  readonly dir?: string;
  readonly port?: number;
  readonly hostname?: string;
  readonly signal?: AbortSignal;
  readonly reporter?: BootReporter;
  readonly prepare?: (signal: AbortSignal) => Promise<unknown>;
  readonly pendingMigrations?: "apply" | "hold";
  readonly migrations?: MigrationStep[];
  readonly definitions?: TestDefinitionModules;
  readonly loadRuntime?: BootOptions["load"]["runtime"];
}

function parts(overrides: PartsOverrides = {}): BootOptions & { readonly dir: string } {
  const dir = overrides.dir ?? workspace();
  return {
    dir,
    listener: {
      port: overrides.port ?? 0,
      ...(overrides.hostname === undefined ? {} : { hostname: overrides.hostname }),
    },
    storage: { path: join(dir, ".ackerdb", "data.db") },
    files: { store: new LocalFileStore({ root: join(dir, "files") }) },
    limits,
    ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
    ...(overrides.reporter === undefined ? {} : { reporter: overrides.reporter }),
    ...(overrides.prepare === undefined ? {} : { prepare: overrides.prepare }),
    ...(overrides.pendingMigrations === undefined ? {} : { pendingMigrations: overrides.pendingMigrations }),
    load: {
      app: async () => ({ app, migrations: overrides.migrations ?? [] }),
      runtime: overrides.loadRuntime ?? (async () => ({
        definitions: testDefinitions(overrides.definitions ?? functions),
      })),
    },
  };
}

async function start(overrides: PartsOverrides = {}): Promise<RunningApp & { readonly dir: string }> {
  const options = parts(overrides);
  const app = await boot(options);
  running.push(app);
  return Object.assign(app, { dir: options.dir });
}

function shutdownMarker(dir: string): bigint {
  const db = new Database(join(dir, ".ackerdb", "data.db"), { readonly: true, safeIntegers: true });
  try {
    return (db.query("SELECT clean_shutdown FROM _ackerdb_state WHERE singleton = 1").get() as {
      clean_shutdown: bigint;
    }).clean_shutdown;
  } finally {
    db.close();
  }
}

const bindable = async (port: number) => {
  const rebound = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("released") });
  await rebound.stop(true);
};

describe("boot", () => {
  test("boots, answers readiness, serves functions, and drains storage clean", async () => {
    const app = await start();
    const base = `http://127.0.0.1:${app.server.port}`;
    expect(await (await fetch(`${base}/ready`)).json()).toEqual({ version: 1, ready: true, state: "ready" });
    const added = await fetch(`${base}/api/notes/add`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "hello" }),
    });
    expect(added.status).toBe(200);
    expect(app.runtime.state).toBe("ready");
    await app.drain();
    expect(shutdownMarker(app.dir)).toBe(1n);
    expect(app.server.state).toBe("stopped");
    expect(app.runtime.state).toBe("stopped");
  });

  test("every phase reaches the reporter, in order, and reconcile lines flow through it", async () => {
    const phases: AckerDBStartupPhase[] = [];
    const reconciled: string[][] = [];
    const app = await start({
      prepare: async () => undefined,
      reporter: {
        phase: (phase) => phases.push(phase),
        reconciled: (lines) => reconciled.push([...lines]),
      },
    });
    expect(phases).toEqual([
      "listening",
      "codegen",
      "loading",
      "opening-storage",
      "reconciling",
      "loading-runtime",
      "starting-runtime",
    ]);
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]!.length).toBeGreaterThan(0);
    await app.drain();

    // A restart with nothing to prepare skips codegen and reconciles again.
    const again: AckerDBStartupPhase[] = [];
    await start({ dir: app.dir, reporter: { phase: (phase) => again.push(phase) } });
    expect(again).toEqual([
      "listening",
      "loading",
      "opening-storage",
      "reconciling",
      "loading-runtime",
      "starting-runtime",
    ]);
  });

  test("never owns process signal listeners", async () => {
    const before = { sigint: process.listeners("SIGINT"), sigterm: process.listeners("SIGTERM") };
    const app = await start();
    expect(process.listeners("SIGINT")).toEqual(before.sigint);
    expect(process.listeners("SIGTERM")).toEqual(before.sigterm);
    await app.drain();
    expect(process.listeners("SIGINT")).toEqual(before.sigint);
    expect(process.listeners("SIGTERM")).toEqual(before.sigterm);
  });

  test("refuses an already-aborted signal with its reason, without binding a port or touching storage", async () => {
    const lifecycle = new AbortController();
    const reason = new Error("stopped before it began");
    lifecycle.abort(reason);
    const port = await new Promise<number>((resolve) => {
      const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
      const chosen = probe.port!;
      void probe.stop(true).then(() => resolve(chosen));
    });
    // Hold the port ourselves: a boot that tried to bind it would fail with
    // EADDRINUSE instead of the signal's reason.
    const holder = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("held") });
    try {
      const options = parts({ port, signal: lifecycle.signal });
      await expect(boot(options)).rejects.toBe(reason);
      expect(existsSync(options.storage.path)).toBe(false);
      expect(existsSync(join(options.dir, "files"))).toBe(false);
    } finally {
      await holder.stop(true);
    }
  });

  test("interruption stops the boot at the next boundary, drains, and releases the port", async () => {
    const lifecycle = new AbortController();
    const preparationEntered = Promise.withResolvers<void>();
    const preparationStopped = Promise.withResolvers<void>();
    const phases: AckerDBStartupPhase[] = [];
    const options = parts({
      signal: lifecycle.signal,
      reporter: { phase: (phase) => phases.push(phase) },
      prepare: async (signal) => {
        preparationEntered.resolve();
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
        preparationStopped.resolve();
      },
    });
    const startup = boot(options);
    await preparationEntered.promise;

    lifecycle.abort();
    await expect(startup).rejects.toBe(lifecycle.signal.reason);
    await preparationStopped.promise;
    expect(phases).toEqual(["listening", "codegen"]);
    expect(existsSync(options.storage.path)).toBe(false);
  });

  test("interruption during runtime loading rejects with the reason and releases the listener port", async () => {
    const lifecycle = new AbortController();
    const loading = Promise.withResolvers<void>();
    const port = await new Promise<number>((resolve) => {
      const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
      const chosen = probe.port!;
      void probe.stop(true).then(() => resolve(chosen));
    });
    const startup = boot(parts({
      port,
      signal: lifecycle.signal,
      loadRuntime: async (signal) => {
        loading.resolve();
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        return { definitions: testDefinitions(functions) };
      },
    }));
    await loading.promise;
    expect((await (await fetch(`http://127.0.0.1:${port}/ready`)).json()).phase).toBe("loading-runtime");
    lifecycle.abort();
    await expect(startup).rejects.toBe(lifecycle.signal.reason);
    await bindable(port);
  });

  test("runs trusted work directly under the system principal", async () => {
    const app = await start();
    const outcome = await app.system.run("fixture.direct", async (ctx) => {
      const external = await (await fetch("data:text/plain,direct")).text();
      const transaction = await ctx.tx((tx: Ctx) => tx.db.notes.insert({ body: external }));
      return { principal: ctx.auth.kind, external, committed: transaction.ok };
    });
    expect(outcome).toEqual({ principal: "system", external: "direct", committed: true });
    expect(app.engine.reader.query('SELECT body FROM "notes"').all()).toEqual([{ body: "direct" }]);
  });

  test("drain signals and settles system work before closing storage", async () => {
    const app = await start();
    const entered = Promise.withResolvers<void>();
    const signaled = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let storageClosed = false;
    const closeEngine = app.engine.close.bind(app.engine);
    app.engine.close = (shutdown) => {
      storageClosed = true;
      closeEngine(shutdown);
    };
    const work = app.system.run("fixture.drain", async (ctx) => {
      entered.resolve();
      await new Promise<void>((resolve) => {
        if (ctx.abortSignal.aborted) resolve();
        else ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true });
      });
      signaled.resolve();
      await release.promise;
    });
    const outcome = work.catch((error: unknown) => error);
    await entered.promise;

    const drain = app.drain();
    expect(app.drain()).toBe(drain);
    await signaled.promise;
    expect(storageClosed).toBe(false);

    release.resolve();
    await expect(outcome).resolves.toMatchObject({
      code: "indeterminate",
      message: "system callback completion is unknown after cancellation",
    });
    await drain;
    expect(storageClosed).toBe(true);
    expect(shutdownMarker(app.dir)).toBe(1n);
  });

  test("a failed drain releases ownership without recording a clean shutdown", async () => {
    const failed = await start();
    const failure = new Error("injected drain failure");
    const drainServer = failed.server.drain.bind(failed.server);
    failed.server.drain = async () => {
      await drainServer();
      throw failure;
    };
    await expect(within(failed.drain(), "failed drain")).rejects.toBe(failure);
    await expect(failed.drain()).rejects.toBe(failure);
    expect(shutdownMarker(failed.dir)).toBe(0n);

    const restarted = await start({ dir: failed.dir });
    expect(restarted.engine.recoveredFromCrash).toBe(true);
    await within(restarted.drain(), "successful drain");
    expect(shutdownMarker(failed.dir)).toBe(1n);
  });

  test("a startup failure releases the listener, the Runtime and storage ownership before retry", async () => {
    const port = await new Promise<number>((resolve) => {
      const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
      const chosen = probe.port!;
      void probe.stop(true).then(() => resolve(chosen));
    });
    const dir = workspace();
    await expect(boot(parts({
      dir,
      port,
      loadRuntime: async () => {
        throw new Error("module import exploded");
      },
    }))).rejects.toThrow("module import exploded");

    const retried = await start({ dir, port });
    expect((await (await fetch(`http://127.0.0.1:${port}/ready`)).json()).ready).toBe(true);
    await retried.drain();
    await bindable(port);
  });

  test("binds the configured listener hostname", async () => {
    const app = await start({ hostname: "0.0.0.0" });
    expect(app.server.hostname).toBe("0.0.0.0");
    expect(await (await fetch(`http://127.0.0.1:${app.server.port}/ready`)).json()).toEqual({
      version: 1,
      ready: true,
      state: "ready",
    });
  });

  test("hold refuses pending migrations before storage is touched", async () => {
    // A first boot establishes the database and its history.
    const first = await start();
    await first.drain();
    const before = Bun.file(join(first.dir, ".ackerdb", "data.db")).lastModified;

    const pending: MigrationStep = {
      number: 1,
      name: "add-title",
      pre: snapshotOf(schema),
      target: snapshotOf(schema),
      code: "",
      migration: {},
    };
    const held = await boot(parts({ dir: first.dir, pendingMigrations: "hold", migrations: [pending] }))
      .catch((error: unknown) => error);
    expect(held).toBeInstanceOf(MigrationsHeldError);
    expect((held as MigrationsHeldError).pending).toBe(1);
    expect((held as Error).message).toBe("1 pending migration(s) held for confirmation");
    expect(Bun.file(join(first.dir, ".ackerdb", "data.db")).lastModified).toBe(before);

    // A fresh database is never held: there is nothing to rewrite.
    const fresh = await start({ pendingMigrations: "hold", migrations: [] });
    expect(fresh.runtime.state).toBe("ready");
  });

  test("issues no credential, and starts an application that has none", async () => {
    const events: string[] = [];
    const jobs = jobModules(() => events.push("job ran"));
    const app = await start({
      loadRuntime: async () => {
        events.push("runtime loaded");
        return { definitions: testDefinitions(functions, jobs) };
      },
    });
    expect(events[0]).toBe("runtime loaded");
    // The repeat job was minted at start and can only run after activation.
    expect(app.runtime.status().declaredJobs).toBe(1);
    // Nothing was written to the credential table, and no administration
    // surface exists to reach: an application with zero credentials is valid.
    const credentials = app.engine.reader
      .query("SELECT COUNT(*) AS count FROM _ackerdb_credentials")
      .get() as { count: number | bigint };
    expect(Number(credentials.count)).toBe(0);
    const base = `http://127.0.0.1:${app.server.port}`;
    expect((await fetch(`${base}/admin/credentials/list`, {
      method: "POST",
      body: JSON.stringify({}),
    })).status).toBe(404);
    await app.drain();
  });

  test("system runs are refused after drain", async () => {
    const app = await start();
    await app.drain();
    const refused = await app.system.run("fixture.late", async () => "no").catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(AckerDBError);
  });
});

function jobModules(onRun: () => void): TestDefinitionModules {
  return {
    beat: {
      tick: job({
        args: {},
        repeat: (now: number) => now,
        handler: () => {
          onRun();
        },
      }),
    },
  };
}
