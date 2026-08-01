/**
 * Services through the real CLI processes: the exit a fatal failure produces,
 * one start per `acker dev` generation, and manifest tooling that opens no
 * external connection at all.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { makeFixture } from "../support/fixture.ts";

const CLI = new URL("../../src/commands/main.ts", import.meta.url).pathname;
const TEST_TIMEOUT_MS = 90_000;
const STEP_TIMEOUT_MS = 20_000;

const children = new Set<Subprocess>();
const dirs: string[] = [];

beforeEach(() => children.clear());

afterEach(async () => {
  for (const child of children) {
    child.kill("SIGKILL");
    await child.exited.catch(() => undefined);
  }
  children.clear();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const APP = `
import { defineApp, defineSchema, defineTable, v } from "@ackerdb/server";

const schema = defineSchema({
  notes: defineTable({ id: v.primaryKey(), body: v.string() }),
});

export default defineApp({ schema });
`;

/**
 * Every service module records to one file, including at import time: an
 * import-time marker is what proves a tooling child never loaded the module.
 */
const RECORDER = `
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const log = join(import.meta.dir, "..", "events.log");

export function record(event) {
  appendFileSync(log, event + "\\n");
}
`;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    server.close();
    throw new Error("port reservation has no address");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return address.port;
}

function events(dir: string): string[] {
  const log = join(dir, "events.log");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").split("\n").filter((line) => line.length > 0);
}

async function eventually(
  assertion: () => void | Promise<void>,
  label: string,
): Promise<void> {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      last = error;
      await Bun.sleep(25);
    }
  }
  throw new Error(`${label} did not settle: ${String(last)}`);
}

function fixture(files: Record<string, string>, port: number): string {
  const dir = makeFixture({
    "app.ts": APP,
    ".ackerdb.config.json": JSON.stringify({ port }),
    "lib/record.ts": RECORDER,
    ...files,
  });
  dirs.push(dir);
  return dir;
}

function spawnCli(args: string[], dir: string, capture: boolean) {
  const stderrPath = join(dir, `.stderr-${args[0]}`);
  if (capture) writeFileSync(stderrPath, "");
  const child = Bun.spawn([process.execPath, CLI, ...args], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: capture ? Bun.file(stderrPath) : "inherit",
    env: { ...process.env, ACKERDB_DURABILITY: "production", ACKERDB_TELEMETRY: "disabled" },
  });
  children.add(child);
  return {
    child,
    stderr: () => (existsSync(stderrPath) ? readFileSync(stderrPath, "utf8") : ""),
  };
}

describe("services through the CLI", () => {
  test("a fatal service failure exits non-zero and names the service", async () => {
    const port = await freePort();
    const dir = fixture({
      "services/worker.ts": `
import { service } from "@ackerdb/server";
import { record } from "../lib/record.ts";

export const queue = service({
  start: ({ fail }) => {
    setTimeout(() => fail(new Error("queue connection ended")), 50);
    return () => record("cleanup:queue");
  },
});
`,
    }, port);

    const started = spawnCli(["start", dir], dir, true);
    const code = await started.child.exited;
    children.delete(started.child);

    expect(code).toBe(1);
    expect(started.stderr()).toContain(
      'service "worker.queue" failed during runtime: queue connection ended',
    );
    // Shutdown still released the service that died.
    expect(events(dir)).toEqual(["cleanup:queue"]);
  }, TEST_TIMEOUT_MS);

  test("SIGTERM releases services before the process exits cleanly", async () => {
    const port = await freePort();
    const dir = fixture({
      "services/providers.ts": `
import { service } from "@ackerdb/server";
import { record } from "../lib/record.ts";

export const tuya = service({
  start: () => {
    record("start:tuya");
    return () => record("cleanup:tuya");
  },
});
`,
    }, port);

    const started = spawnCli(["start", dir], dir, false);
    await eventually(async () => {
      expect((await fetch(`http://127.0.0.1:${port}/ready`)).status).toBe(200);
    }, "server ready");

    started.child.kill("SIGTERM");
    expect(await started.child.exited).toBe(0);
    children.delete(started.child);

    expect(events(dir)).toEqual(["start:tuya", "cleanup:tuya"]);
  }, TEST_TIMEOUT_MS);

  test("manifest tooling never imports a service module", async () => {
    const port = await freePort();
    const dir = fixture({
      "services/providers.ts": `
import { record } from "../lib/record.ts";
import { service } from "@ackerdb/server";

// Module scope stands in for a broker client that connects on import.
record("imported");

export const tuya = service({ start: () => () => record("cleanup") });
`,
    }, port);

    // Nothing here has a database yet, and none of it may reach the module.
    for (const args of [["codegen", dir], ["__plan", dir], ["__plugin_plan", dir]]) {
      const run = spawnCli(args, dir, false);
      expect(await run.child.exited).toBe(0);
      children.delete(run.child);
      expect(events(dir)).toEqual([]);
    }

    // The same module is imported the moment the app actually serves.
    const started = spawnCli(["start", dir], dir, false);
    await eventually(async () => {
      expect((await fetch(`http://127.0.0.1:${port}/ready`)).status).toBe(200);
    }, "server ready");
    expect(events(dir)).toEqual(["imported"]);

    started.child.kill("SIGTERM");
    expect(await started.child.exited).toBe(0);
    children.delete(started.child);
    expect(events(dir)).toEqual(["imported", "cleanup"]);

    // Database-owning commands are equally inert now that one exists. Restore
    // needs a fresh target, so the reset between them is part of the path.
    const artifact = join(dir, "backup.ackerdb");
    for (const args of [
      ["status", dir],
      ["backup", artifact, dir],
      ["reset", dir],
      ["restore", artifact, dir],
    ]) {
      const run = spawnCli(args, dir, false);
      expect(await run.child.exited).toBe(0);
      children.delete(run.child);
      expect(events(dir)).toEqual(["imported", "cleanup"]);
    }
  }, TEST_TIMEOUT_MS);

  test("a service module that throws at import fails start but not codegen", async () => {
    const port = await freePort();
    const dir = fixture({
      "services/broken.ts": `
throw new Error("broker client could not initialise");
`,
    }, port);

    const codegen = spawnCli(["codegen", dir], dir, false);
    expect(await codegen.child.exited).toBe(0);
    children.delete(codegen.child);

    const started = spawnCli(["start", dir], dir, true);
    expect(await started.child.exited).toBe(1);
    children.delete(started.child);
    expect(started.stderr()).toContain("broker client could not initialise");
  }, TEST_TIMEOUT_MS);

  test("a service that leaks a handle cannot wedge the dev supervisor", async () => {
    const port = await freePort();
    const dir = fixture({
      "services/leaky.ts": `
import { service } from "@ackerdb/server";
import { record } from "../lib/record.ts";

export const forgetful = service({
  start: () => {
    // The common app bug: a live interval the cleanup forgets to clear. It
    // keeps the event loop alive long after drain has finished.
    setInterval(() => {}, 1_000);
    return () => record("cleanup");
  },
});
`,
    }, port);

    const started = spawnCli(["start", dir], dir, false);
    await eventually(async () => {
      expect((await fetch(`http://127.0.0.1:${port}/ready`)).status).toBe(200);
    }, "server ready");

    const startedAt = Date.now();
    started.child.kill("SIGTERM");
    expect(await started.child.exited).toBe(0);
    children.delete(started.child);

    // Drain is the whole obligation; the leak must not extend the exit.
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(events(dir)).toEqual(["cleanup"]);
  }, TEST_TIMEOUT_MS);

  test("acker dev starts each service exactly once per generation", async () => {
    const port = await freePort();
    const dir = fixture({
      "services/providers.ts": `
import { service } from "@ackerdb/server";
import { record } from "../lib/record.ts";

export const tuya = service({
  start: () => {
    record("start");
    return () => record("cleanup");
  },
});
`,
    }, port);

    const dev = spawnCli(["dev", dir], dir, false);
    await eventually(async () => {
      expect((await fetch(`http://127.0.0.1:${port}/ready`)).status).toBe(200);
    }, "first generation ready");
    expect(events(dir)).toEqual(["start"]);

    // Each save is one generation: released, then started, never overlapping.
    for (let reload = 1; reload <= 3; reload += 1) {
      writeFileSync(join(dir, "app.ts"), `${APP}\n// reload ${reload}\n`);
      const expected = ["start"];
      for (let generation = 0; generation < reload; generation += 1) {
        expected.push("cleanup", "start");
      }
      await eventually(() => {
        expect(events(dir)).toEqual(expected);
      }, `generation ${reload}`);
      await eventually(async () => {
        expect((await fetch(`http://127.0.0.1:${port}/ready`)).status).toBe(200);
      }, `generation ${reload} ready`);
    }

    dev.child.kill("SIGTERM");
    await dev.child.exited;
    children.delete(dev.child);

    await eventually(() => {
      expect(events(dir)).toEqual([
        "start",
        "cleanup", "start",
        "cleanup", "start",
        "cleanup", "start",
        "cleanup",
      ]);
    }, "final cleanup");
  }, TEST_TIMEOUT_MS);
});
