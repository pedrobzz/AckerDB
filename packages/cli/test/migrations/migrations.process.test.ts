import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { Database } from "bun:sqlite";
import { AckerDBClient } from "@ackerdb/client";
import { v, defineSchema, defineTable, migrationFingerprint, snapshotOf } from "@ackerdb/server";
import { withFrameworkTables } from "@ackerdb/server/database/framework-schema";
import { loadConfig } from "../../src/app/config.ts";
import { inspectDatabase, type StatusReport } from "../../src/commands/operations.ts";
import { makeFixture } from "../support/fixture.ts";
import { freePort } from "../support/port.ts";

import { steps } from "../support/process.ts";

const CLI = new URL("../../src/commands/main.ts", import.meta.url).pathname;
const TEST_TIMEOUT_MS = 60_000;
const STEP_TIMEOUT_MS = 15_000;
const { withTimeout, eventually } = steps(STEP_TIMEOUT_MS);

// The on-disk schema sources and the in-process snapshots are the same schema:
// snapshotOf is deterministic, so PRE/TARGET here equal what the server derives
// from app.ts. Only the `count` column type changes (float -> string).
const APP_V1 = `import { defineApp, defineSchema, defineTable, v } from "@ackerdb/server";

const schema = defineSchema({
  items: defineTable({
    id: v.primaryKey(),
    label: v.string(),
    count: v.int(),
  }),
});
export default defineApp({ schema });
`;

const APP_V2 = `import { defineApp, defineSchema, defineTable, v } from "@ackerdb/server";

const schema = defineSchema({
  items: defineTable({
    id: v.primaryKey(),
    label: v.string(),
    count: v.string(),
  }),
});
export default defineApp({ schema });
`;

// Real chains record engine-visible snapshots, which carry every framework table.
const PRE = snapshotOf(withFrameworkTables(
  defineSchema({ items: defineTable({ id: v.primaryKey(), label: v.string(), count: v.int() }) }),
));
const TARGET = snapshotOf(withFrameworkTables(
  defineSchema({ items: defineTable({ id: v.primaryKey(), label: v.string(), count: v.string() }) }),
));

const ITEMS_FUNCTIONS = `import { v } from "@ackerdb/server";
import { mutation, query } from "../_generated/server.ts";

export const add = mutation({
  access: "public",
  args: { label: v.string(), count: v.int() },
  handler: (ctx, args) => ctx.db.items.insert(args),
});

export const list = query({
  access: "public",
  args: {},
  handler: (ctx) => ctx.db.items.query().collect(),
});
`;

// Answers the count float -> string refusal by stringifying every old row.
const MIGRATION_0001 = `import { defineMigration } from "@ackerdb/server";

export default defineMigration({
  tables: {
    items: (row) => ({ ...row, count: String(row.count) }),
  },
});
`;

// Same PRE/TARGET, same meta: only the transform body differs (still valid, same
// end result). Its file text shifts the applied identity, so a restart refuses.
const MIGRATION_0001_EDITED = `import { defineMigration } from "@ackerdb/server";

export default defineMigration({
  tables: {
    items: (row) => ({ ...row, count: \`\${row.count}\` }),
  },
});
`;

type CliProcess = Subprocess<"ignore", "pipe", "pipe">;
type Item = { id: bigint; label: string; count: unknown };

const dirs: string[] = [];
const clients: AckerDBClient[] = [];
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

async function waitForReady(port: number): Promise<void> {
  await eventually(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    expect(response.status).toBe(200);
  }, `server on port ${port} to become ready`);
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
    env: { ...process.env, ACKERDB_DURABILITY: "production" },
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

function makeClient(port: number, clientSessionId: string): AckerDBClient {
  const client = new AckerDBClient({
    url: `http://127.0.0.1:${port}`,
    credential: { kind: "anonymous" },
    clientSessionId,
    reconnect: { baseDelayMs: 20, maxDelayMs: 100, stableOpenMs: 100 },
  });
  clients.push(client);
  return client;
}

function closeClient(client: AckerDBClient): void {
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

describe("ackerdb startup migrations", () => {
  test("loads the chain, migrates data, and serves the transformed rows", async () => {
    const port = await freePort();
    const dir = makeFixture({
      "app.ts": APP_V1,
      "app/items.ts": ITEMS_FUNCTIONS,
      ".ackerdb.config.json": JSON.stringify({ port }),
    });
    dirs.push(dir);

    // v1: insert rows through the running server, then shut down.
    const first = spawnServer(dir);
    await first.waitFor("ready on");
    const seeder = makeClient(port, "migrations-seed");
    expect(await withTimeout(
      seeder.mutation<{ label: string; count: number }, bigint>("api.items.add", { label: "alpha", count: 5 }),
      "seed alpha",
    )).toBe(1n);
    expect(await withTimeout(
      seeder.mutation<{ label: string; count: number }, bigint>("api.items.add", { label: "beta", count: 42 }),
      "seed beta",
    )).toBe(2n);
    closeClient(seeder);
    await stopServer(first, "v1 server");

    // Rewrite the schema to v2 and author the migration answering the refusal.
    writeFileSync(join(dir, "app.ts"), APP_V2);
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
    const rows = await withTimeout(reader.query<Record<string, never>, Item[]>("api.items.list", {}), "list after migration");
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
    // Two application mutations, and nothing else: the boot mints no
    // credential, so a restart writes nothing at all.
    expect(status.status.commitVersion).toBe("2");
  }, TEST_TIMEOUT_MS);

  test("applies pending migrations before loading runtime-only modules", async () => {
    const port = await freePort();
    const dir = makeFixture({
      "app.ts": APP_V1,
      "app/items.ts": ITEMS_FUNCTIONS,
      ".ackerdb.config.json": JSON.stringify({ port }),
    });
    dirs.push(dir);

    const first = spawnServer(dir);
    await waitForReady(port);
    const seeder = makeClient(port, "runtime-loading-seed");
    expect(await withTimeout(
      seeder.mutation<{ label: string; count: number }, bigint>("api.items.add", { label: "alpha", count: 5 }),
      "seed before runtime loading failure",
    )).toBe(1n);
    closeClient(seeder);
    await stopServer(first, "pre-migration server");

    writeFileSync(join(dir, "app.ts"), APP_V2);
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
    writeFileSync(
      join(dir, "credential-verifier.ts"),
      `
import { writeFileSync } from "node:fs";
writeFileSync(new URL("./verifier-loaded", import.meta.url), "");
throw new Error("runtime-only verifier failure");
`,
    );
    writeFileSync(
      join(dir, ".ackerdb.config.json"),
      JSON.stringify({ port, credentialVerifier: "./credential-verifier.ts" }),
    );

    const failed = spawnServer(dir);
    expect(await withTimeout(failed.child.exited, "runtime-only module failure")).not.toBe(0);
    await withTimeout(failed.drained, "runtime-only module failure output");
    children.delete(failed.child);
    expect(existsSync(join(dir, "verifier-loaded"))).toBe(true);

    const database = new Database(join(dir, ".ackerdb", "data.db"), { readonly: true });
    try {
      expect(database.query("SELECT number, name FROM _ackerdb_migrations").all()).toEqual([
        { number: 1, name: "count_to_string" },
      ]);
      expect(database.query("SELECT count FROM items").all()).toEqual([{ count: "5" }]);
    } finally {
      database.close();
    }
  }, TEST_TIMEOUT_MS);

  test("refuses on restart after an applied migration's transform body is edited", async () => {
    const port = await freePort();
    const dir = makeFixture({
      "app.ts": APP_V1,
      "app/items.ts": ITEMS_FUNCTIONS,
      ".ackerdb.config.json": JSON.stringify({ port }),
    });
    dirs.push(dir);

    // v1: seed a row, then shut down.
    const first = spawnServer(dir);
    await first.waitFor("ready on");
    const seeder = makeClient(port, "immutable-seed");
    expect(await withTimeout(
      seeder.mutation<{ label: string; count: number }, bigint>("api.items.add", { label: "alpha", count: 5 }),
      "seed alpha",
    )).toBe(1n);
    closeClient(seeder);
    await stopServer(first, "v1 server");

    // Author v2 + the migration and apply it on the next start.
    writeFileSync(join(dir, "app.ts"), APP_V2);
    mkdirSync(join(dir, "migrations", "meta"), { recursive: true });
    writeFileSync(join(dir, "migrations", "0001_count_to_string.ts"), MIGRATION_0001);
    writeFileSync(
      join(dir, "migrations", "meta", "0001_count_to_string.json"),
      JSON.stringify({ number: 1, name: "count_to_string", fingerprint: migrationFingerprint(TARGET), pre: PRE, target: TARGET }),
    );
    const second = spawnServer(dir);
    await second.waitFor("migrated table items");
    await stopServer(second, "v2 server");

    // Edit ONLY the transform body; the meta sidecar (pre/target/fingerprint)
    // is untouched, so the load-time target check passes — but the file text is
    // part of the applied identity, so startup must refuse as immutable.
    writeFileSync(join(dir, "migrations", "0001_count_to_string.ts"), MIGRATION_0001_EDITED);
    const third = spawnServer(dir);
    const exitCode = await withTimeout(third.child.exited, "immutable refusal exit");
    await withTimeout(third.drained, "immutable refusal output drain");
    children.delete(third.child);
    expect(exitCode).not.toBe(0);
    expect(third.output()).toContain("0001_count_to_string");
    expect(third.output()).toContain("immutable");
  }, TEST_TIMEOUT_MS);

  test("refuses an unanswered schema change and names acker generate", async () => {
    const port = await freePort();
    const dir = makeFixture({
      "app.ts": APP_V1,
      "app/items.ts": ITEMS_FUNCTIONS,
      ".ackerdb.config.json": JSON.stringify({ port }),
    });
    dirs.push(dir);

    const first = spawnServer(dir);
    await first.waitFor("ready on");
    const seeder = makeClient(port, "migrations-refusal-seed");
    expect(await withTimeout(
      seeder.mutation<{ label: string; count: number }, bigint>("api.items.add", { label: "alpha", count: 5 }),
      "seed alpha",
    )).toBe(1n);
    closeClient(seeder);
    await stopServer(first, "v1 server");

    // The type change is shape-unsafe; with no migration file the startup must
    // refuse and end with the exact generation command.
    writeFileSync(join(dir, "app.ts"), APP_V2);
    const second = spawnServer(dir);
    const exitCode = await withTimeout(second.child.exited, "refused startup exit");
    await withTimeout(second.drained, "refused startup output drain");
    children.delete(second.child);
    expect(exitCode).not.toBe(0);
    expect(second.output()).toContain("acker generate");
  }, TEST_TIMEOUT_MS);
});
