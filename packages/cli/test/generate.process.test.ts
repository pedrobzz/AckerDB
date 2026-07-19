import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { Subprocess } from "bun";
import { DbzzClient } from "@dbzz/client";
import { defineSchema, defineTable, dbz, indexSqlName, migrationFingerprint, snapshotOf } from "@dbzz/server";
import { makeFixture } from "./fixture.ts";

const CLI = new URL("../src/main.ts", import.meta.url).pathname;
const TEST_TIMEOUT_MS = 60_000;
const STEP_TIMEOUT_MS = 15_000;

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

// A third state so numbering can increment on a fully-applied chain (string -> number).
const SCHEMA_V3 = `import { defineSchema, defineTable, dbz } from "@dbzz/server";

export default defineSchema({
  items: defineTable({
    id: dbz.primaryKey(),
    label: dbz.string(),
    count: dbz.number(),
  }),
});
`;

// v1 plus a UNIQUE index over `label` — an optimistic change whose stored rows may already collide.
const SCHEMA_UNIQUE = `import { defineSchema, defineTable, dbz } from "@dbzz/server";

export default defineSchema({
  items: defineTable({
    id: dbz.primaryKey(),
    label: dbz.string(),
    count: dbz.number(),
  }).index("by_label", ["label"], { unique: true }),
});
`;

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

const V1 = snapshotOf(defineSchema({ items: defineTable({ id: dbz.primaryKey(), label: dbz.string(), count: dbz.number() }) }));
const V2 = snapshotOf(defineSchema({ items: defineTable({ id: dbz.primaryKey(), label: dbz.string(), count: dbz.string() }) }));

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

interface RanCli {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run one CLI command to completion with stdin ignored (a non-TTY invocation). */
async function runCli(args: string[]): Promise<RanCli> {
  const child = Bun.spawn([process.execPath, CLI, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, DBZZ_DURABILITY: "production", DBZZ_TELEMETRY: "disabled" },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

function spawnServer(dir: string): { child: CliProcess; waitReady(): Promise<void>; drained: Promise<void> } {
  const child = Bun.spawn([process.execPath, CLI, "start", dir], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, DBZZ_DURABILITY: "production", DBZZ_TELEMETRY: "disabled" },
  }) as CliProcess;
  children.add(child);
  let stdout = "";
  let stderr = "";
  const pump = async (stream: ReadableStream<Uint8Array>, append: (text: string) => void) => {
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
    pump(child.stdout, (t) => (stdout += t)),
    pump(child.stderr, (t) => (stderr += t)),
  ]).then(() => undefined);
  return {
    child,
    waitReady: () =>
      eventually(() => {
        expect(`${stdout}\n${stderr}`).toContain("ready on");
      }, "server ready"),
    drained,
  };
}

function makeClient(port: number, session: string): DbzzClient {
  const client = new DbzzClient({
    url: `http://127.0.0.1:${port}`,
    credential: { kind: "anonymous" },
    clientSessionId: session,
    reconnect: { baseDelayMs: 20, maxDelayMs: 100, stableOpenMs: 100 },
  });
  clients.push(client);
  return client;
}

async function stopServer(server: ReturnType<typeof spawnServer>): Promise<void> {
  server.child.kill("SIGTERM");
  await withTimeout(server.child.exited, "server graceful exit");
  await withTimeout(server.drained, "server output drain");
  children.delete(server.child);
}

/** Bring up a v1 server, seed rows, and shut it down, leaving a seeded database. */
async function seedV1(dir: string, port: number): Promise<void> {
  const server = spawnServer(dir);
  await server.waitReady();
  const seeder = makeClient(port, "gen-seed");
  expect(await withTimeout(seeder.mutation<{ label: string; count: number }, bigint>("items.add", { label: "alpha", count: 5 }), "seed alpha")).toBe(1n);
  expect(await withTimeout(seeder.mutation<{ label: string; count: number }, bigint>("items.add", { label: "beta", count: 42 }), "seed beta")).toBe(2n);
  seeder.close();
  clients.splice(clients.indexOf(seeder), 1);
  await stopServer(server);
}

describe("dbz generate", () => {
  test("writes the three artifacts for a type change, numbered 0001, and applies once filled", async () => {
    const port = await freePort();
    const dir = makeFixture({
      "schema.ts": SCHEMA_V1,
      "functions/items.ts": ITEMS_FUNCTIONS,
      ".zdb.config.json": JSON.stringify({ port }),
    });
    dirs.push(dir);

    await seedV1(dir, port);
    writeFileSync(join(dir, "schema.ts"), SCHEMA_V2);

    // Non-TTY generate: no renames, just the scaffold for the count type change.
    const generated = await withTimeout(runCli(["generate", "", dir]), "dbz generate");
    expect(generated.code).toBe(0);

    const scaffold = join(dir, "migrations", "0001_items_count_retype.ts");
    const types = join(dir, "migrations", "meta", "0001_items_count_retype.types.ts");
    const meta = join(dir, "migrations", "meta", "0001_items_count_retype.json");
    expect(existsSync(scaffold)).toBe(true);
    expect(existsSync(types)).toBe(true);
    expect(existsSync(meta)).toBe(true);

    // The typed hole: an annotated transform whose only body is a TODO.
    const scaffoldSource = readFileSync(scaffold, "utf8");
    expect(scaffoldSource).toContain("items: (row): ItemsRow => {");
    expect(scaffoldSource).toContain("// TODO(items.count): type changed; existing rows would need converting");

    // The meta sidecar records pre = v1 (the seeded snapshot) and target = v2.
    const parsedMeta = JSON.parse(readFileSync(meta, "utf8"));
    expect([parsedMeta.number, parsedMeta.name]).toEqual([1, "items_count_retype"]);
    expect(parsedMeta.pre).toEqual(V1);
    expect(parsedMeta.target).toEqual(V2);
    expect(parsedMeta.fingerprint).toBe(migrationFingerprint(V2));

    // Fill the hole with a real conversion (string surgery), then let the server apply it.
    writeFileSync(
      scaffold,
      scaffoldSource.replace(
        "      // TODO(items.count): type changed; existing rows would need converting\n",
        "      return { ...row, count: String(row.count) };\n",
      ),
    );

    const applied = spawnServer(dir);
    await applied.waitReady();
    const reader = makeClient(port, "gen-read");
    const rows = await withTimeout(reader.query<Record<string, never>, Item[]>("items.list", {}), "list after apply");
    expect(rows.map((r) => [r.label, r.count])).toEqual([
      ["alpha", "5"],
      ["beta", "42"],
    ]);
    for (const row of rows) expect(typeof row.count).toBe("string");
    reader.close();
    clients.splice(clients.indexOf(reader), 1);
    await stopServer(applied);

    // With the chain fully applied, a second change generates 0002 (numbering increments).
    writeFileSync(join(dir, "schema.ts"), SCHEMA_V3);
    const second = await withTimeout(runCli(["generate", "", dir]), "dbz generate (second)");
    expect(second.code).toBe(0);
    expect(existsSync(join(dir, "migrations", "0002_items_count_retype.ts"))).toBe(true);
  }, TEST_TIMEOUT_MS);

  test("probes stored duplicates for a new unique index and scaffolds a dedupe stub that applies once filled", async () => {
    const port = await freePort();
    const dir = makeFixture({
      "schema.ts": SCHEMA_V1,
      "functions/items.ts": ITEMS_FUNCTIONS,
      ".zdb.config.json": JSON.stringify({ port }),
    });
    dirs.push(dir);

    // Seed two rows sharing a label (one duplicate group) plus one distinct row.
    const server = spawnServer(dir);
    await server.waitReady();
    const seeder = makeClient(port, "dup-seed");
    const add = (label: string, count: number, label2: string) =>
      withTimeout(seeder.mutation<{ label: string; count: number }, bigint>("items.add", { label, count }), label2);
    expect(await add("dup", 5, "seed dup1")).toBe(1n);
    expect(await add("dup", 42, "seed dup2")).toBe(2n);
    expect(await add("solo", 7, "seed solo")).toBe(3n);
    seeder.close();
    clients.splice(clients.indexOf(seeder), 1);
    await stopServer(server);

    // Add the unique index; the optimistic change refuses because stored rows collide.
    writeFileSync(join(dir, "schema.ts"), SCHEMA_UNIQUE);

    const generated = await withTimeout(runCli(["generate", "", dir]), "dbz generate (dedupe)");
    expect(generated.code).toBe(0);
    // Before the fix computePlan discarded the optimistic bucket and reported clean.
    expect(generated.stdout).not.toContain("nothing to generate");

    const scaffold = join(dir, "migrations", "0001_items_by_label_dedupe.ts");
    expect(existsSync(scaffold)).toBe(true);
    const scaffoldSource = readFileSync(scaffold, "utf8");
    // A volunteered typed-hole transform on the offending table, naming the index and count.
    expect(scaffoldSource).toContain("items: (row): ItemsRow => {");
    expect(scaffoldSource).toContain(
      "// TODO(items.by_label): unique index over (label); 1 duplicate group(s) exist — return the surviving row, or null to drop this one",
    );

    // Fill the hole with a real dedupe: keep the lowest id per label group, drop the rest.
    const filled = scaffoldSource.replace(
      "    items: (row): ItemsRow => {\n" +
        "      // TODO(items.by_label): unique index over (label); 1 duplicate group(s) exist — return the surviving row, or null to drop this one\n" +
        "    },",
      "    items: async (row, ctx) => {\n" +
        "      let lowest = row.id;\n" +
        "      for await (const other of ctx.before.items.scan()) {\n" +
        "        if (other.label === row.label && other.id < lowest) lowest = other.id;\n" +
        "      }\n" +
        "      return row.id === lowest ? row : null;\n" +
        "    },",
    );
    expect(filled).not.toBe(scaffoldSource); // the surgery matched the generated stub
    writeFileSync(scaffold, filled);

    const applied = spawnServer(dir);
    await applied.waitReady();
    const reader = makeClient(port, "dup-read");
    const rows = await withTimeout(reader.query<Record<string, never>, Item[]>("items.list", {}), "list after dedupe");
    // The later duplicate (id 2) is gone; the lowest-id survivor and the distinct row remain.
    expect(rows.map((r) => [r.id, r.label])).toEqual([
      [1n, "dup"],
      [3n, "solo"],
    ]);
    reader.close();
    clients.splice(clients.indexOf(reader), 1);
    await stopServer(applied);

    // The physical index is now UNIQUE — the final enforcer the migration satisfied.
    const db = new Database(join(dir, ".zdb", "data.db"), { readonly: true });
    try {
      const row = db
        .query("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get(indexSqlName("items", "by_label")) as { sql: string } | null;
      expect(row?.sql).toContain("UNIQUE");
    } finally {
      db.close();
    }
  }, TEST_TIMEOUT_MS);

  test("refuses cleanly when a pending migration is not yet applied", async () => {
    const port = await freePort();
    const dir = makeFixture({
      "schema.ts": SCHEMA_V1,
      "functions/items.ts": ITEMS_FUNCTIONS,
      ".zdb.config.json": JSON.stringify({ port }),
    });
    dirs.push(dir);

    await seedV1(dir, port);
    writeFileSync(join(dir, "schema.ts"), SCHEMA_V2);

    // A chain entry on disk that the database has NOT applied (appliedCount 0, chain length 1).
    mkdirSync(join(dir, "migrations", "meta"), { recursive: true });
    writeFileSync(
      join(dir, "migrations", "0001_count_to_string.ts"),
      `import { defineMigration } from "@dbzz/server";\nexport default defineMigration({ tables: { items: (row) => ({ ...row, count: String(row.count) }) } });\n`,
    );
    writeFileSync(
      join(dir, "migrations", "meta", "0001_count_to_string.json"),
      JSON.stringify({ number: 1, name: "count_to_string", fingerprint: migrationFingerprint(V2), pre: V1, target: V2 }),
    );

    const result = await withTimeout(runCli(["generate", "", dir]), "dbz generate (pending)");
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("pending migration");
  }, TEST_TIMEOUT_MS);

  test("refuses when there is no database to diff against", async () => {
    const dir = makeFixture({
      "schema.ts": SCHEMA_V2,
      "functions/items.ts": ITEMS_FUNCTIONS,
      ".zdb.config.json": JSON.stringify({ port: 3999 }),
    });
    dirs.push(dir);

    const result = await withTimeout(runCli(["generate", "", dir]), "dbz generate (no db)");
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("no database");
  }, TEST_TIMEOUT_MS);
});
