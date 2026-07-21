import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { Database } from "bun:sqlite";
import { v, defineSchema, defineTable, Engine, reconcile } from "@dbzz/server";
import { makeFixture } from "../support/fixture.ts";

const CLI = new URL("../../src/commands/main.ts", import.meta.url).pathname;
const REPO = new URL("../../../..", import.meta.url).pathname;
const STEP_TIMEOUT_MS = 10_000;
const APP_SOURCE = `
import { v, defineApp, defineSchema, defineTable } from "@dbzz/server";
const schema = defineSchema({
  records: defineTable({ id: v.primaryKey(), value: v.string() }),
});
export default defineApp({ schema });
`;
const schema = defineSchema({
  records: defineTable({ id: v.primaryKey(), value: v.string() }),
});

type CliProcess = Subprocess<"ignore", "pipe", "pipe">;

const dirs: string[] = [];
const children = new Set<CliProcess>();

afterEach(async () => {
  await Promise.all([...children].map(async (child) => {
    try {
      child.kill("SIGKILL");
    } catch {
      // The child already exited.
    }
    await child.exited.catch(() => {});
  }));
  children.clear();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    handle = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), STEP_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(handle));
}

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = probe.port!;
  await probe.stop(true);
  return port;
}

function fixture(port: number): string {
  const dir = makeFixture({
    "app.ts": APP_SOURCE,
    ".dbzz.config.json": JSON.stringify({ port }),
  });
  dirs.push(dir);
  return dir;
}

function spawnStart(dir: string) {
  const child = Bun.spawn([process.execPath, CLI, "start", dir], {
    cwd: REPO,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, DBZZ_TELEMETRY: "disabled" },
  }) as CliProcess;
  children.add(child);
  let output = "";
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) output += decoder.decode(chunk, { stream: true });
    output += decoder.decode();
  };
  const drained = Promise.all([drain(child.stdout), drain(child.stderr)]).then(() => undefined);
  return {
    child,
    drained,
    output: () => output,
    waitFor: async (needle: string) => {
      const deadline = Date.now() + STEP_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (output.includes(needle)) return;
        await Bun.sleep(10);
      }
      throw new Error(`timed out waiting for ${JSON.stringify(needle)} in:\n${output}`);
    },
  };
}

async function stopStarted(started: ReturnType<typeof spawnStart>): Promise<void> {
  started.child.kill("SIGTERM");
  expect(await withTimeout(started.child.exited, "graceful CLI exit")).toBe(0);
  await withTimeout(started.drained, "CLI output drain");
  children.delete(started.child);
}

async function runSilentCrash(script: string, label: string): Promise<void> {
  const child = Bun.spawn([process.execPath, "-e", script], {
    cwd: REPO,
    stdout: "pipe",
    stderr: "pipe",
  }) as CliProcess;
  children.add(child);
  const [exitCode, stdout, stderr] = await Promise.all([
    withTimeout(child.exited, label),
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  children.delete(child);
  expect(exitCode, stderr).not.toBe(0);
  expect(stdout).toBe("");
  expect(stderr).toBe("");
}

function rollbackJournalCrash(path: string, corruptLedger: boolean): string {
  return `
    import { Database } from "bun:sqlite";
    const database = new Database(${JSON.stringify(path)}, { safeIntegers: true });
    database.exec("PRAGMA journal_mode = DELETE");
    database.exec("PRAGMA synchronous = FULL");
    database.exec("PRAGMA cache_size = 5");
    database.exec("PRAGMA cache_spill = 1");
    ${corruptLedger
      ? 'database.query("UPDATE _dbzz_state SET mutation_records = 999 WHERE singleton = 1").run();'
      : ""}
    database.exec("BEGIN IMMEDIATE");
    const insert = database.query("INSERT INTO records (value) VALUES (?)");
    for (let index = 0; index < 2_000; index++) insert.run("x".repeat(8 * 1_024));
    process.kill(process.pid, "SIGKILL");
  `;
}

async function assertFailedStartup(
  dir: string,
  port: number,
  diagnostic: string,
): Promise<void> {
  const failed = spawnStart(dir);
  expect(await withTimeout(failed.child.exited, "corrupt startup rejection")).toBe(1);
  await withTimeout(failed.drained, "corrupt startup output drain");
  children.delete(failed.child);
  expect(failed.output()).toContain(diagnostic);
  expect(failed.output()).not.toContain("@@dbzz-startup");
  expect(failed.output()).not.toContain("ready on");
  try {
    await fetch(`http://127.0.0.1:${port}/live`, { signal: AbortSignal.timeout(200) });
    throw new Error("corrupt startup left a live listener");
  } catch (error) {
    if (error instanceof Error && error.message === "corrupt startup left a live listener") throw error;
  }
}

function cleanDatabase(): Buffer {
  const dir = fixture(32_111);
  const source = join(dir, ".dbzz", "source.db");
  const artifact = join(dir, "clean.db");
  mkdirSync(join(dir, ".dbzz"), { recursive: true });
  const engine = new Engine(schema, source);
  reconcile(engine);
  engine.backup(artifact);
  engine.close("clean");
  return readFileSync(artifact);
}

function rewriteWalHeader(wal: Buffer, offset: number, value: number): Buffer {
  const bytes = Buffer.from(wal);
  bytes.writeUInt32BE(value, offset);
  const littleEndian = bytes.readUInt32BE(0) === 0x377f0682;
  const words = new DataView(bytes.buffer, bytes.byteOffset, 24);
  let first = 0;
  let second = 0;
  for (let index = 0; index < 24; index += 8) {
    first = (first + words.getUint32(index, littleEndian) + second) >>> 0;
    second = (second + words.getUint32(index + 4, littleEndian) + first) >>> 0;
  }
  bytes.writeUInt32BE(first, 24);
  bytes.writeUInt32BE(second, 28);
  return bytes;
}

describe("fresh-process storage corruption rejection", () => {
  test("never initializes over any pre-existing empty, foreign, or truncated main file", async () => {
    const clean = cleanDatabase();
    const encodedPageSize = clean.readUInt16BE(16);
    const pageSize = encodedPageSize === 1 ? 65_536 : encodedPageSize;
    const variants: Array<{
      name: string;
      diagnostic: string;
      write(path: string): void;
    }> = [
      {
        name: "zero-byte truncation",
        diagnostic: "pre-existing database file is empty",
        write: (path) => writeFileSync(path, new Uint8Array()),
      },
      {
        name: "valid empty SQLite",
        diagnostic: "pre-existing database has no DBZZ metadata",
        write: (path) => {
          const database = new Database(path, { create: true });
          database.exec("VACUUM");
          database.close();
        },
      },
      {
        name: "foreign SQLite",
        diagnostic: "pre-existing database has no DBZZ metadata",
        write: (path) => {
          const database = new Database(path, { create: true });
          database.exec("CREATE TABLE foreign_records (id INTEGER PRIMARY KEY)");
          database.close();
        },
      },
      {
        name: "corrupt header",
        diagnostic: "database file has an invalid SQLite header",
        write: (path) => {
          const bytes = Buffer.from(clean);
          bytes[0] = bytes[0]! ^ 0xff;
          writeFileSync(path, bytes);
        },
      },
      {
        name: "partial header",
        diagnostic: "database file is truncated before its SQLite header",
        write: (path) => writeFileSync(path, clean.subarray(0, 1)),
      },
      {
        name: "partial page",
        diagnostic: "database file is truncated between SQLite pages",
        write: (path) => writeFileSync(path, clean.subarray(0, pageSize + 1)),
      },
      {
        name: "missing whole page",
        diagnostic: "database file size does not match its SQLite header",
        write: (path) => writeFileSync(path, clean.subarray(0, clean.byteLength - pageSize)),
      },
    ];

    for (const variant of variants) {
      const port = await freePort();
      const dir = fixture(port);
      const path = join(dir, ".dbzz", "data.db");
      mkdirSync(join(dir, ".dbzz"), { recursive: true });
      variant.write(path);
      const before = readFileSync(path);

      await assertFailedStartup(dir, port, variant.diagnostic);

      expect(readFileSync(path), variant.name).toEqual(before);
      expect(existsSync(`${path}-wal`), variant.name).toBe(false);
    }

    const orphanPort = await freePort();
    const orphanDir = fixture(orphanPort);
    const orphanPath = join(orphanDir, ".dbzz", "data.db");
    mkdirSync(join(orphanDir, ".dbzz"), { recursive: true });
    const orphanWal = Buffer.from("orphan recovery evidence");
    writeFileSync(`${orphanPath}-wal`, orphanWal);
    await assertFailedStartup(
      orphanDir,
      orphanPort,
      "database main file is missing while SQLite sidecars exist",
    );
    expect(existsSync(orphanPath)).toBe(false);
    expect(readFileSync(`${orphanPath}-wal`)).toEqual(orphanWal);

    const journalPort = await freePort();
    const journalDir = fixture(journalPort);
    const journalPath = join(journalDir, ".dbzz", "data.db");
    mkdirSync(join(journalDir, ".dbzz"), { recursive: true });
    const orphanJournal = Buffer.from("orphan rollback evidence");
    writeFileSync(`${journalPath}-journal`, orphanJournal);
    await assertFailedStartup(
      journalDir,
      journalPort,
      "database main file is missing while SQLite sidecars exist",
    );
    expect(existsSync(journalPath)).toBe(false);
    expect(readFileSync(`${journalPath}-journal`)).toEqual(orphanJournal);
  }, 30_000);

  test("recovers committed and uncommitted hot WALs but rejects structural damage", async () => {
    const clean = cleanDatabase();
    const crashDir = fixture(await freePort());
    const source = join(crashDir, ".dbzz", "data.db");
    mkdirSync(join(crashDir, ".dbzz"), { recursive: true });
    writeFileSync(source, clean);
    const crashScript = `
      import { v, defineSchema, defineTable, Engine } from "@dbzz/server";
      const schema = defineSchema({ records: defineTable({ id: v.primaryKey(), value: v.string() }) });
      const engine = new Engine(schema, ${JSON.stringify(source)});
      engine.writer.exec("PRAGMA wal_autocheckpoint = 0");
      engine.writer.exec("BEGIN IMMEDIATE");
      engine.writer.query("INSERT INTO records (value) VALUES (?)").run("committed-before-crash");
      engine.allocateCommitVersion();
      engine.writer.exec("COMMIT");
      process.kill(process.pid, "SIGKILL");
    `;
    const crashed = Bun.spawn([process.execPath, "-e", crashScript], {
      cwd: REPO,
      stdout: "pipe",
      stderr: "pipe",
    }) as CliProcess;
    children.add(crashed);
    const [exitCode, stdout, stderr] = await Promise.all([
      withTimeout(crashed.exited, "hot-WAL fixture crash"),
      new Response(crashed.stdout).text(),
      new Response(crashed.stderr).text(),
    ]);
    children.delete(crashed);
    expect(exitCode, stderr).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toBe("");
    const main = readFileSync(source);
    const wal = readFileSync(`${source}-wal`);
    expect(wal.byteLength).toBeGreaterThan(32);

    const validPort = await freePort();
    const validDir = fixture(validPort);
    const validPath = join(validDir, ".dbzz", "data.db");
    mkdirSync(join(validDir, ".dbzz"), { recursive: true });
    writeFileSync(validPath, main);
    writeFileSync(`${validPath}-wal`, Buffer.concat([wal, Buffer.alloc(512, 0xa5)]));
    const valid = spawnStart(validDir);
    await valid.waitFor("ready on");
    await stopStarted(valid);
    const recovered = new Database(validPath, { readonly: true, safeIntegers: true });
    expect(recovered.query("SELECT value FROM records").all()).toEqual([
      { value: "committed-before-crash" },
    ]);
    expect(recovered.query("SELECT commit_version FROM _dbzz_state WHERE singleton = 1").get()).toEqual({
      commit_version: 1n,
    });
    recovered.close();

    const uncommittedPort = await freePort();
    const uncommittedDir = fixture(uncommittedPort);
    const uncommittedPath = join(uncommittedDir, ".dbzz", "data.db");
    mkdirSync(join(uncommittedDir, ".dbzz"), { recursive: true });
    writeFileSync(uncommittedPath, clean);
    const spillScript = `
      import { v, defineSchema, defineTable, Engine } from "@dbzz/server";
      const schema = defineSchema({ records: defineTable({ id: v.primaryKey(), value: v.string() }) });
      const engine = new Engine(schema, ${JSON.stringify(uncommittedPath)});
      engine.writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      engine.writer.exec("PRAGMA cache_size = 5");
      engine.writer.exec("PRAGMA cache_spill = 1");
      engine.writer.exec("BEGIN IMMEDIATE");
      const insert = engine.writer.query("INSERT INTO records (value) VALUES (?)");
      for (let index = 0; index < 2_000; index++) insert.run("x".repeat(8 * 1_024));
      process.kill(process.pid, "SIGKILL");
    `;
    const spilled = Bun.spawn([process.execPath, "-e", spillScript], {
      cwd: REPO,
      stdout: "pipe",
      stderr: "pipe",
    }) as CliProcess;
    children.add(spilled);
    const [spillExit, spillStdout, spillStderr] = await Promise.all([
      withTimeout(spilled.exited, "uncommitted WAL fixture crash"),
      new Response(spilled.stdout).text(),
      new Response(spilled.stderr).text(),
    ]);
    children.delete(spilled);
    expect(spillExit, spillStderr).not.toBe(0);
    expect(spillStdout).toBe("");
    expect(spillStderr).toBe("");
    expect(readFileSync(`${uncommittedPath}-wal`).byteLength).toBeGreaterThan(32);

    const uncommitted = spawnStart(uncommittedDir);
    await uncommitted.waitFor("ready on");
    await stopStarted(uncommitted);
    const rolledBack = new Database(uncommittedPath, { readonly: true, safeIntegers: true });
    expect(rolledBack.query("SELECT COUNT(*) AS count FROM records").get()).toEqual({ count: 0n });
    expect(rolledBack.query("SELECT commit_version FROM _dbzz_state WHERE singleton = 1").get()).toEqual({
      commit_version: 0n,
    });
    rolledBack.close();

    const resetPort = await freePort();
    const resetDir = fixture(resetPort);
    const resetPath = join(resetDir, ".dbzz", "data.db");
    mkdirSync(join(resetDir, ".dbzz"), { recursive: true });
    writeFileSync(resetPath, clean);
    const resetScript = `
      import { v, defineSchema, defineTable, Engine } from "@dbzz/server";
      const schema = defineSchema({ records: defineTable({ id: v.primaryKey(), value: v.string() }) });
      const engine = new Engine(schema, ${JSON.stringify(resetPath)});
      engine.writer.exec("PRAGMA wal_autocheckpoint = 0");
      engine.writer.exec("BEGIN IMMEDIATE");
      const insert = engine.writer.query("INSERT INTO records (value) VALUES (?)");
      for (let index = 0; index < 500; index++) insert.run("x".repeat(8 * 1_024));
      engine.allocateCommitVersion();
      engine.writer.exec("COMMIT");
      engine.writer.exec("PRAGMA wal_checkpoint(FULL)");
      engine.writer.exec("BEGIN IMMEDIATE");
      insert.run("after-reset");
      engine.allocateCommitVersion();
      engine.writer.exec("COMMIT");
      process.kill(process.pid, "SIGKILL");
    `;
    const reset = Bun.spawn([process.execPath, "-e", resetScript], {
      cwd: REPO,
      stdout: "pipe",
      stderr: "pipe",
    }) as CliProcess;
    children.add(reset);
    const [resetExit, resetStdout, resetStderr] = await Promise.all([
      withTimeout(reset.exited, "reset WAL fixture crash"),
      new Response(reset.stdout).text(),
      new Response(reset.stderr).text(),
    ]);
    children.delete(reset);
    expect(resetExit, resetStderr).not.toBe(0);
    expect(resetStdout).toBe("");
    expect(resetStderr).toBe("");
    const resetWal = readFileSync(`${resetPath}-wal`);
    expect(resetWal.byteLength).toBeGreaterThan(32);

    const recoveredReset = spawnStart(resetDir);
    await recoveredReset.waitFor("ready on");
    await stopStarted(recoveredReset);
    const resetDatabase = new Database(resetPath, { readonly: true, safeIntegers: true });
    expect(resetDatabase.query("SELECT COUNT(*) AS count FROM records").get()).toEqual({ count: 501n });
    expect(resetDatabase.query("SELECT commit_version FROM _dbzz_state WHERE singleton = 1").get()).toEqual({
      commit_version: 2n,
    });
    resetDatabase.close();

    const variants = [
      {
        name: "unsupported WAL format",
        diagnostic: "database WAL uses an unsupported format",
        bytes: () => rewriteWalHeader(wal, 4, 3_007_001),
      },
      {
        name: "WAL page-size mismatch",
        diagnostic: "database WAL page size does not match its main file",
        bytes: () => rewriteWalHeader(wal, 8, wal.readUInt32BE(8) === 4_096 ? 8_192 : 4_096),
      },
    ];

    for (const variant of variants) {
      const port = await freePort();
      const dir = fixture(port);
      const path = join(dir, ".dbzz", "data.db");
      mkdirSync(join(dir, ".dbzz"), { recursive: true });
      writeFileSync(path, main);
      writeFileSync(`${path}-wal`, variant.bytes());
      const beforeMain = readFileSync(path);
      const beforeWal = readFileSync(`${path}-wal`);

      await assertFailedStartup(dir, port, variant.diagnostic);

      expect(readFileSync(path), variant.name).toEqual(beforeMain);
      expect(readFileSync(`${path}-wal`), variant.name).toEqual(beforeWal);
    }
  }, 30_000);

  test("rejects hot-WAL internal corruption without changing any recovery artifact", async () => {
    const port = await freePort();
    const dir = fixture(port);
    const path = join(dir, ".dbzz", "data.db");
    mkdirSync(join(dir, ".dbzz"), { recursive: true });
    writeFileSync(path, cleanDatabase());
    const corruptScript = `
      import { v, defineSchema, defineTable, Engine } from "@dbzz/server";
      const schema = defineSchema({ records: defineTable({ id: v.primaryKey(), value: v.string() }) });
      const engine = new Engine(schema, ${JSON.stringify(path)});
      engine.writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      engine.writer.query("UPDATE _dbzz_state SET mutation_records = 999 WHERE singleton = 1").run();
      process.kill(process.pid, "SIGKILL");
    `;
    const corrupted = Bun.spawn([process.execPath, "-e", corruptScript], {
      cwd: REPO,
      stdout: "pipe",
      stderr: "pipe",
    }) as CliProcess;
    children.add(corrupted);
    const [exitCode, stdout, stderr] = await Promise.all([
      withTimeout(corrupted.exited, "internal corruption fixture crash"),
      new Response(corrupted.stdout).text(),
      new Response(corrupted.stderr).text(),
    ]);
    children.delete(corrupted);
    expect(exitCode, stderr).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toBe("");

    const artifacts = [path, `${path}-wal`, `${path}-shm`]
      .filter((artifact) => existsSync(artifact))
      .map((artifact) => [artifact, readFileSync(artifact)] as const);
    expect(artifacts.some(([artifact]) => artifact.endsWith("-wal"))).toBe(true);

    await assertFailedStartup(dir, port, "mutation replay ledger counters do not match stored records");

    for (const [artifact, before] of artifacts) {
      expect(existsSync(artifact), artifact).toBe(true);
      expect(readFileSync(artifact), artifact).toEqual(before);
    }
  }, 30_000);

  test("recovers hot rollback journals and preserves rejected recovery evidence byte-for-byte", async () => {
    const validPort = await freePort();
    const validDir = fixture(validPort);
    const validPath = join(validDir, ".dbzz", "data.db");
    mkdirSync(join(validDir, ".dbzz"), { recursive: true });
    writeFileSync(validPath, cleanDatabase());
    await runSilentCrash(rollbackJournalCrash(validPath, false), "hot rollback-journal fixture crash");
    expect(readFileSync(`${validPath}-journal`).byteLength).toBeGreaterThan(512);

    const recovered = spawnStart(validDir);
    await recovered.waitFor("ready on");
    await stopStarted(recovered);
    const recoveredDatabase = new Database(validPath, { readonly: true, safeIntegers: true });
    expect(recoveredDatabase.query("SELECT COUNT(*) AS count FROM records").get()).toEqual({ count: 0n });
    expect(
      recoveredDatabase.query("SELECT commit_version FROM _dbzz_state WHERE singleton = 1").get(),
    ).toEqual({ commit_version: 0n });
    recoveredDatabase.close();

    const corruptPort = await freePort();
    const corruptDir = fixture(corruptPort);
    const corruptPath = join(corruptDir, ".dbzz", "data.db");
    mkdirSync(join(corruptDir, ".dbzz"), { recursive: true });
    writeFileSync(corruptPath, cleanDatabase());
    await runSilentCrash(
      rollbackJournalCrash(corruptPath, true),
      "corrupt hot rollback-journal fixture crash",
    );
    const artifacts = [corruptPath, `${corruptPath}-journal`]
      .filter((artifact) => existsSync(artifact))
      .map((artifact) => [artifact, readFileSync(artifact)] as const);
    expect(artifacts.some(([artifact]) => artifact.endsWith("-journal"))).toBe(true);

    await assertFailedStartup(
      corruptDir,
      corruptPort,
      "mutation replay ledger counters do not match stored records",
    );
    for (const [artifact, before] of artifacts) {
      expect(existsSync(artifact), artifact).toBe(true);
      expect(readFileSync(artifact), artifact).toEqual(before);
    }
  }, 30_000);
});
