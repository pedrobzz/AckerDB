import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  CorruptDatabaseError,
  dbz,
  defineSchema,
  defineTable,
  Engine,
  IncompatibleDatabaseError,
  reconcile,
} from "@dbzz/server";

const roots: string[] = [];
const fresh = () => {
  const root = mkdtempSync(join(tmpdir(), "dbzz-storage-"));
  roots.push(root);
  return { root, database: join(root, "data.db") };
};

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

const schema = defineSchema({
  records: defineTable({ id: dbz.primaryKey(), value: dbz.string() }),
});

describe("durability and internal state", () => {
  test("defaults to FULL, reports balanced explicitly, and persists monotonic versions", () => {
    const { database } = fresh();
    const production = new Engine(schema, database);
    reconcile(production);
    expect(production.status()).toMatchObject({
      durability: "production",
      synchronous: "FULL",
      commitVersion: 0n,
      recoveredFromCrash: false,
    });
    production.writer.exec("BEGIN IMMEDIATE");
    expect(production.allocateCommitVersion()).toBe(1n);
    production.writer.exec("COMMIT");
    production.close();

    const balanced = new Engine(schema, database, { durability: "balanced" });
    expect(balanced.status()).toMatchObject({
      durability: "balanced",
      synchronous: "NORMAL",
      commitVersion: 1n,
      recoveredFromCrash: false,
    });
    balanced.close();
  });

  test("rejects another process owner and legacy internal schemas", () => {
    const { database } = fresh();
    const owner = new Engine(schema, database);
    expect(() => new Engine(schema, database)).toThrow("already open by process");
    owner.close();

    const legacy = fresh().database;
    const db = new Database(legacy, { create: true });
    db.exec("CREATE TABLE _dbz_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.close();
    expect(() => new Engine(schema, legacy)).toThrow(IncompatibleDatabaseError);
  });

  test("rejects inconsistent internal ledger state", () => {
    const { database } = fresh();
    const engine = new Engine(schema, database);
    reconcile(engine);
    engine.close();

    const db = new Database(database, { safeIntegers: true });
    db.query("UPDATE _dbz_state SET mutation_records = 1 WHERE singleton = 1").run();
    db.close();
    expect(() => new Engine(schema, database)).toThrow(CorruptDatabaseError);
  });

  test("stores scoped mutation receipts atomically and prunes only selected expired rows", () => {
    const { database } = fresh();
    const engine = new Engine(schema, database);
    reconcile(engine);
    engine.writer.exec("BEGIN IMMEDIATE");
    const commitVersion = engine.allocateCommitVersion();
    engine.insertStoredMutation({
      sessionId: "session-a",
      requestId: "request-a",
      issuedAt: 10,
      principalFingerprint: "principal",
      functionRef: "records.create",
      argsFingerprint: "args",
      result: "{\"value\":1}",
      resultBytes: 11,
      commitVersion,
      durability: "production",
      completedAt: 20,
    });
    engine.writer.exec("COMMIT");
    expect(engine.storedMutation("session-a", "request-a")).toMatchObject({
      functionRef: "records.create",
      commitVersion: 1n,
      durability: "production",
    });
    expect(engine.status()).toMatchObject({ mutationRecords: 1, mutationResultBytes: 11 });
    expect(engine.pruneStoredMutations(20)).toBe(0);
    expect(engine.pruneStoredMutations(21)).toBe(1);
    expect(engine.status()).toMatchObject({ mutationRecords: 0, mutationResultBytes: 0 });
    engine.close();
  });

  test("detects an unclean prior process without deleting WAL state", async () => {
    const { database } = fresh();
    const script = `
      import { dbz, defineSchema, defineTable, Engine, reconcile } from "@dbzz/server";
      const schema = defineSchema({ records: defineTable({ id: dbz.primaryKey(), value: dbz.string() }) });
      const engine = new Engine(schema, ${JSON.stringify(database)});
      reconcile(engine);
      engine.writer.exec("BEGIN IMMEDIATE");
      engine.writer.query('INSERT INTO records (value) VALUES (?)').run("survives");
      engine.allocateCommitVersion();
      engine.writer.exec("COMMIT");
      process.exit(0);
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: join(import.meta.dir, "../../.."),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(0);

    const recovered = new Engine(schema, database);
    expect(recovered.recoveredFromCrash).toBe(true);
    expect(recovered.commitVersion()).toBe(1n);
    expect(recovered.writer.query("SELECT value FROM records").get()).toEqual({ value: "survives" });
    recovered.close();
  });
});

describe("checkpoint, backup, and restore", () => {
  test("reports checkpoint progress and restores a verified continued database", () => {
    const source = fresh();
    const engine = new Engine(schema, source.database);
    reconcile(engine);
    engine.writer.exec("BEGIN IMMEDIATE");
    engine.writer.query("INSERT INTO records (value) VALUES (?)").run("backed-up");
    expect(engine.allocateCommitVersion()).toBe(1n);
    engine.writer.exec("COMMIT");

    const checkpoint = engine.checkpoint("PASSIVE");
    expect(checkpoint).toMatchObject({ mode: "PASSIVE", busy: 0, oldestReader: null });
    expect(checkpoint.totalFrames).toBeGreaterThanOrEqual(checkpoint.checkpointedFrames);
    expect(engine.status().lastCheckpointAtMs).toBeGreaterThan(0);

    const artifact = join(source.root, "backup.db");
    const manifest = engine.backup(artifact);
    expect(manifest).toMatchObject({
      format: 1,
      commitVersion: 1n,
      durability: "production",
      schemaFingerprint: engine.schemaFingerprint(),
    });
    expect(manifest.sha256).toBe(createHash("sha256").update(readFileSync(artifact)).digest("hex"));
    engine.close();

    const restored = fresh().database;
    Engine.restore(artifact, restored, manifest);
    const reopened = new Engine(schema, restored);
    reconcile(reopened);
    expect(reopened.commitVersion()).toBe(1n);
    expect(reopened.writer.query("SELECT value FROM records").get()).toEqual({ value: "backed-up" });
    reopened.writer.exec("BEGIN IMMEDIATE");
    expect(reopened.allocateCommitVersion()).toBe(2n);
    reopened.writer.exec("COMMIT");
    reopened.close();
  });

  test("refuses an artifact whose manifest digest no longer matches", () => {
    const source = fresh();
    const engine = new Engine(schema, source.database);
    reconcile(engine);
    const artifact = join(source.root, "backup.db");
    const manifest = engine.backup(artifact);
    engine.close();
    const bytes = readFileSync(artifact);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
    writeFileSync(artifact, bytes);
    expect(() => Engine.restore(artifact, fresh().database, manifest)).toThrow(CorruptDatabaseError);
  });
});
