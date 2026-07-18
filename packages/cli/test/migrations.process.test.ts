import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { DbzzClient } from "@dbzz/client";
import { dbz, defineSchema, defineTable, migrationFingerprint, snapshotOf } from "@dbzz/server";
import { loadConfig } from "../src/config.ts";
import { inspectDatabase, type StatusReport } from "../src/operations.ts";
import { makeFixture } from "./fixture.ts";

const CLI = new URL("../src/main.ts", import.meta.url).pathname;
const TEST_TIMEOUT_MS = 60_000;
const STEP_TIMEOUT_MS = 15_000;

// The on-disk schema sources and the in-process snapshots are the same schema:
// snapshotOf is deterministic, so PRE/TARGET here equal what the server derives
// from schema.ts. Only the `count` column type changes (number -> string).
const SCHEMA_V1 = `import { defineSchema, defineTable, dbz } from "@dbzz/server";

export default defineSchema({
  items: defineTable({
    id: dbz.primaryKey(),
    label: dbz.string(),
    count: dbz.number(),
  }),
});
`;

const SCHEMA_V2 = `import { defineSchema, defineTable, dbz } from "@dbzz/server";

export default defineSchema({
  items: defineTable({
    id: dbz.primaryKey(),
    label: dbz.string(),
    count: dbz.string(),
  }),
});
`;

const PRE = snapshotOf(
  defineSchema({ items: defineTable({ id: dbz.primaryKey(), label: dbz.string(), count: dbz.number() }) }),
);
const TARGET = snapshotOf(
  defineSchema({ items: defineTable({ id: dbz.primaryKey(), label: dbz.string(), count: dbz.string() }) }),
);

const ITEMS_FUNCTIONS = `import { dbz } from "@dbzz/server";
import { mutation, query } from "../_generated/server.ts";

export const add = mutation({
  access: "public",
  args: { label: dbz.string(), count: dbz.number() },
  handler: (ctx, args) => ctx.db.items.insert(args),
});

export const list = query({
  access: "public",
  args: {},
  handler: (ctx) => ctx.db.items.scan().collect(),
});
`;

// Answers the count number -> string refusal by stringifying every old row.
const MIGRATION_0001 = `import { defineMigration } from "@dbzz/server";

export default defineMigration({
  tables: {
    items: (row) => ({ ...row, count: String(row.count) }),
  },
});
`;

type CliProcess = Subprocess<"ignore", "pipe", "pipe">;
type Item = { id: bigint; label: string; count: unknown };

const dirs: string[] = [];
const clients: DbzzClient[] = [];
const children = new Set<CliProcess>();

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await Promise.all(
    [...children].map(async (child) => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already exited.
      }
      await child.exited.catch(() => {});
    }),
  );
  children.clear();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = STEP_TIMEOUT_MS): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    handle = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(handle));
}

async function eventually(assertion: () => void | Promise<void>, label: string): Promise<void> {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await Bun.sleep(25);
    }
  }
  throw new Error(`timed out waiting for ${label}`, { cause: lastError });
}

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = probe.port!;
  await probe.stop(true);
  return port;
}

function spawnServer(dir: string): {
  child: CliProcess;
  output(): string;
  waitFor(needle: string): Promise<void>;
  drained: Promise<void>;
} {
  const child = Bun.spawn([process.execPath, CLI, "start", dir], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, DBZZ_DURABILITY: "production", DBZZ_TELEMETRY: "disabled" },
  }) as CliProcess;
  children.add(child);
  let stdout = "";
  let stderr = "";
  const drain = async (stream: ReadableStream<Uint8Array>, append: (text: string) => void) => {
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        append(decoder.decode(chunk.value, { stream: true }));
      }
      append(decoder.decode());
    } finally {
      reader.releaseLock();
    }
  };
  const drained = Promise.all([
    drain(child.stdout, (text) => {
      stdout += text;
    }),
    drain(child.stderr, (text) => {
      stderr += text;
    }),
  ]).then(() => undefined);
  const combined = () => `${stdout}${stderr.length === 0 ? "" : `\n[stderr]\n${stderr}`}`;
  return {
    child,
    output: combined,
    waitFor: (needle) => eventually(() => {
      expect(combined()).toContain(needle);
    }, `${JSON.stringify(needle)} in server output`),
    drained,
  };
}

function makeClient(port: number, clientSessionId: string): DbzzClient {
  const client = new DbzzClient({
    url: `http://127.0.0.1:${port}`,
    credential: { kind: "anonymous" },
    clientSessionId,
    reconnect: { baseDelayMs: 20, maxDelayMs: 100, stableOpenMs: 100 },
  });
  clients.push(client);
  return client;
}

function closeClient(client: DbzzClient): void {
  client.close();
  const index = clients.indexOf(client);
  if (index >= 0) clients.splice(index, 1);
}

async function stopServer(server: ReturnType<typeof spawnServer>, label: string): Promise<void> {
  server.child.kill("SIGTERM");
  expect(await withTimeout(server.child.exited, `${label} graceful exit`)).toBe(0);
  await withTimeout(server.drained, `${label} output drain`);
  children.delete(server.child);
}

describe("dbz startup migrations", () => {
  test("loads the chain, migrates data, and serves the transformed rows", async () => {
    const port = await freePort();
    const dir = makeFixture({
      "schema.ts": SCHEMA_V1,
      "functions/items.ts": ITEMS_FUNCTIONS,
      ".zdb.config.json": JSON.stringify({ port }),
    });
    dirs.push(dir);

    // v1: insert rows through the running server, then shut down.
    const first = spawnServer(dir);
    await first.waitFor("ready on");
    const seeder = makeClient(port, "migrations-seed");
    expect(await withTimeout(
      seeder.mutation<{ label: string; count: number }, bigint>("items.add", { label: "alpha", count: 5 }),
      "seed alpha",
    )).toBe(1n);
    expect(await withTimeout(
      seeder.mutation<{ label: string; count: number }, bigint>("items.add", { label: "beta", count: 42 }),
      "seed beta",
    )).toBe(2n);
    closeClient(seeder);
    await stopServer(first, "v1 server");

    // Rewrite the schema to v2 and author the migration answering the refusal.
    writeFileSync(join(dir, "schema.ts"), SCHEMA_V2);
    mkdirSync(join(dir, "migrations", "meta"), { recursive: true });
    writeFileSync(join(dir, "migrations", "0001_count_to_string.ts"), MIGRATION_0001);
    writeFileSync(
      join(dir, "migrations", "meta", "0001_count_to_string.json"),
      JSON.stringify({
        number: 1,
        name: "count_to_string",
        fingerprint: migrationFingerprint(TARGET),
        pre: PRE,
        target: TARGET,
      }),
    );

    // v2 restart: the chain applies during startup, before the runtime exists.
    const second = spawnServer(dir);
    await second.waitFor("ready on");
    expect(second.output()).toContain("0001_count_to_string");
    expect(second.output()).toContain("migrated table items");

    const reader = makeClient(port, "migrations-read");
    const rows = await withTimeout(reader.query<Record<string, never>, Item[]>("items.list", {}), "list after migration");
    expect(rows.map((row) => [row.label, row.count])).toEqual([
      ["alpha", "5"],
      ["beta", "42"],
    ]);
    for (const row of rows) expect(typeof row.count).toBe("string");
    closeClient(reader);
    await stopServer(second, "v2 server");

    // status keeps working on a database that now carries migration history.
    const status: StatusReport = await inspectDatabase(loadConfig(dir));
    expect(status.operation).toBe("status");
    expect(status.schemaFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(status.status.commitVersion).toBe("2");
  }, TEST_TIMEOUT_MS);

  test("refuses an unanswered schema change and names dbz generate", async () => {
    const port = await freePort();
    const dir = makeFixture({
      "schema.ts": SCHEMA_V1,
      "functions/items.ts": ITEMS_FUNCTIONS,
      ".zdb.config.json": JSON.stringify({ port }),
    });
    dirs.push(dir);

    const first = spawnServer(dir);
    await first.waitFor("ready on");
    const seeder = makeClient(port, "migrations-refusal-seed");
    expect(await withTimeout(
      seeder.mutation<{ label: string; count: number }, bigint>("items.add", { label: "alpha", count: 5 }),
      "seed alpha",
    )).toBe(1n);
    closeClient(seeder);
    await stopServer(first, "v1 server");

    // The type change is shape-unsafe; with no migration file the startup must
    // refuse and end with the exact generation command.
    writeFileSync(join(dir, "schema.ts"), SCHEMA_V2);
    const second = spawnServer(dir);
    const exitCode = await withTimeout(second.child.exited, "refused startup exit");
    await withTimeout(second.drained, "refused startup output drain");
    children.delete(second.child);
    expect(exitCode).not.toBe(0);
    expect(second.output()).toContain("dbz generate");
  }, TEST_TIMEOUT_MS);
});
