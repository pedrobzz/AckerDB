import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  CorruptDatabaseError,
  v,
  defineSchema,
  defineTable,
  Engine,
  IncompatibleDatabaseError,
  reconcile,
} from "@dbzz/server";
import { mutationReplayOwner } from "../src/mutation-replay.ts";

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
  records: defineTable({ id: v.primaryKey(), value: v.string() }),
});

function catalog(database: string): unknown[] {
  const db = new Database(database, { readonly: true, safeIntegers: true });
  try {
    return db
      .query("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
      .all();
  } finally {
    db.close();
  }
}

function ownedState(database: string): Record<string, unknown> {
  const db = new Database(database, { readonly: true, safeIntegers: true });
  try {
    return {
      catalog: db
        .query("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
        .all(),
      meta: db.query("SELECT key, value FROM _dbz_meta ORDER BY key").all(),
      state: db.query("SELECT * FROM _dbz_state ORDER BY singleton").all(),
      tags: db.query("SELECT type, variant, tag FROM _dbz_tags ORDER BY type, variant").all(),
    };
  } finally {
    db.close();
  }
}

function cleanShutdown(database: string): bigint {
  const db = new Database(database, { readonly: true, safeIntegers: true });
  try {
    return (db.query("SELECT clean_shutdown FROM _dbz_state WHERE singleton = 1").get() as {
      clean_shutdown: bigint;
    }).clean_shutdown;
  } finally {
    db.close();
  }
}

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
    production.close("clean");

    const balanced = new Engine(schema, database, { durability: "balanced" });
    expect(balanced.status()).toMatchObject({
      durability: "balanced",
      synchronous: "NORMAL",
      commitVersion: 1n,
      recoveredFromCrash: false,
    });
    balanced.close("clean");
  });

  test("rejects another process owner and legacy internal schemas", () => {
    const { database } = fresh();
    const owner = new Engine(schema, database);
    expect(() => new Engine(schema, database)).toThrow("already open by process");
    owner.close("clean");

    const legacy = fresh().database;
    const db = new Database(legacy, { create: true });
    db.exec("CREATE TABLE _dbz_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.close();
    expect(() => new Engine(schema, legacy)).toThrow(IncompatibleDatabaseError);
  });

  test("refuses to adopt user or partial internal objects when metadata is absent", () => {
    for (const ddl of [
      "CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL)",
      "CREATE TABLE _dbz_tags (type TEXT NOT NULL, variant TEXT NOT NULL, tag INTEGER NOT NULL)",
    ]) {
      const { database } = fresh();
      const db = new Database(database, { create: true });
      db.exec(ddl);
      db.close();
      const before = catalog(database);
      expect(() => new Engine(schema, database)).toThrow(CorruptDatabaseError);
      expect(catalog(database)).toEqual(before);
    }
  });

  test("validates every internal object and singleton before writing startup state", () => {
    const { database } = fresh();
    const engine = new Engine(schema, database);
    reconcile(engine);
    engine.close("clean");
    const db = new Database(database);
    db.exec("ALTER TABLE _dbz_mutations ADD COLUMN unexpected TEXT");
    db.close();
    const before = ownedState(database);
    expect(() => new Engine(schema, database)).toThrow(IncompatibleDatabaseError);
    expect(ownedState(database)).toEqual(before);
  });

  test("rejects dropped, extra, or changed application columns despite a matching snapshot", () => {
    const corruptions = [
      'ALTER TABLE "records" DROP COLUMN "value"',
      'ALTER TABLE "records" ADD COLUMN "extra" TEXT',
      `CREATE TABLE "replacement" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "value" INTEGER NOT NULL);
       DROP TABLE "records";
       ALTER TABLE "replacement" RENAME TO "records"`,
    ];
    for (const corruption of corruptions) {
      const { database } = fresh();
      const engine = new Engine(schema, database);
      reconcile(engine);
      engine.close("clean");
      const db = new Database(database);
      db.exec(corruption);
      db.close();
      const before = ownedState(database);
      expect(() => new Engine(schema, database)).toThrow(CorruptDatabaseError);
      expect(ownedState(database)).toEqual(before);
    }
  });

  test("rejects missing and wrong application indexes before ready or reconciliation", () => {
    const indexed = defineSchema({
      records: defineTable({ id: v.primaryKey(), value: v.string() }).index("by_value", ["value"], {
        unique: true,
      }),
    });
    const corruptions = [
      "DROP INDEX ix_records_by_value",
      "DROP INDEX ix_records_by_value; CREATE INDEX ix_records_by_value ON records (value)",
    ];
    for (const corruption of corruptions) {
      const { database } = fresh();
      const engine = new Engine(indexed, database);
      reconcile(engine);
      engine.close("clean");
      const db = new Database(database);
      db.exec(corruption);
      db.close();
      const before = ownedState(database);
      expect(() => new Engine(indexed, database)).toThrow(CorruptDatabaseError);
      expect(ownedState(database)).toEqual(before);
    }

    const { database } = fresh();
    const live = new Engine(indexed, database);
    reconcile(live);
    live.writer.exec("DROP INDEX ix_records_by_value");
    const before = live.writer.query("SELECT key, value FROM _dbz_meta ORDER BY key").all();
    expect(() => reconcile(live)).toThrow(CorruptDatabaseError);
    expect(live.writer.query("SELECT key, value FROM _dbz_meta ORDER BY key").all()).toEqual(before);
    live.close("clean");
  });

  test("stored index columns must be own snapshot entries", () => {
    for (const inheritedName of ["toString", "constructor"]) {
      const { database } = fresh();
      const engine = new Engine(schema, database);
      reconcile(engine);
      const snapshot = engine.loadSnapshot()!;
      snapshot.tables.records!.indexes.push({
        name: "by_missing",
        columns: [inheritedName],
        unique: false,
        algorithm: "btree",
      });
      engine.saveSnapshot(snapshot);
      expect(() => engine.loadSnapshot()).toThrow(
        "stored schema snapshot is invalid: records.by_missing has an invalid definition",
      );
      engine.close("clean");
    }
  });

  test("rejects corrupt tag assignments without repairing them", () => {
    const tagged = defineSchema({
      records: defineTable({
        id: v.primaryKey(),
        value: v.enum("RecordState", ["draft", "ready", "done"]),
      }),
    });
    for (const corruption of [
      "UPDATE _dbz_tags SET tag = 0 WHERE type = 'RecordState' AND variant = 'ready'",
      "DELETE FROM _dbz_tags WHERE type = 'RecordState' AND variant = 'done'",
    ]) {
      const { database } = fresh();
      const engine = new Engine(tagged, database);
      reconcile(engine);
      engine.close("clean");
      const db = new Database(database);
      db.exec(corruption);
      db.close();
      const before = ownedState(database);
      expect(() => new Engine(tagged, database)).toThrow(CorruptDatabaseError);
      expect(ownedState(database)).toEqual(before);
    }
  });

  test("rejects inconsistent internal ledger state", () => {
    const { database } = fresh();
    const engine = new Engine(schema, database);
    reconcile(engine);
    engine.close("clean");

    const db = new Database(database, { safeIntegers: true });
    db.query("UPDATE _dbz_state SET mutation_records = 1 WHERE singleton = 1").run();
    db.close();
    expect(() => new Engine(schema, database)).toThrow(CorruptDatabaseError);
  });

  test("stores scoped mutation receipts atomically and prunes only selected expired rows", () => {
    const { database } = fresh();
    const engine = new Engine(schema, database);
    reconcile(engine);
    expect(engine.writer.query("PRAGMA index_list('_dbz_mutations')").all()).toEqual([]);
    engine.writer.exec("BEGIN IMMEDIATE");
    const staged = engine[mutationReplayOwner].stage({
      sessionId: "session-a",
      requestId: "request-a",
      issuedAt: 10,
      principalFingerprint: "principal",
      functionRef: "records.create",
      argsFingerprint: "args",
      resultDisposition: "replayable",
      result: "{\"value\":1}",
      resultBytes: 11,
      durability: "production",
    }, 20);
    engine.writer.exec("COMMIT");
    engine[mutationReplayOwner].committed(staged);
    expect(staged.commitVersion).toBe(1n);
    expect(engine[mutationReplayOwner].lookup("session-a", "request-a")).toMatchObject({
      functionRef: "records.create",
      commitVersion: 1n,
      durability: "production",
    });
    expect(engine.status()).toMatchObject({ mutationRecords: 1, mutationResultBytes: 11 });
    expect(engine[mutationReplayOwner].prune(20)).toBe(0);
    expect(engine[mutationReplayOwner].prune(21)).toBe(1);
    expect(engine.status()).toMatchObject({ mutationRecords: 0, mutationResultBytes: 0 });
    engine.close("clean");
  });

  test("publishes replay index entries only after commit and rebuilds them on restart", () => {
    const { database } = fresh();
    const engine = new Engine(schema, database);
    reconcile(engine);
    const base = {
      sessionId: "session-a",
      issuedAt: 10,
      principalFingerprint: "principal",
      functionRef: "records.create",
      resultDisposition: "replayable" as const,
      result: "null",
      resultBytes: 4,
      durability: "production" as const,
    };
    engine.writer.exec("BEGIN IMMEDIATE");
    const rolledBack = engine[mutationReplayOwner].stage({
      ...base,
      requestId: "rolled-back",
      argsFingerprint: "rolled-back",
    }, 20);
    engine.writer.exec("ROLLBACK");
    expect(engine[mutationReplayOwner].lookup("session-a", "rolled-back")).toBeNull();

    engine.writer.exec("BEGIN IMMEDIATE");
    const committed = engine[mutationReplayOwner].stage({
      ...base,
      requestId: "committed",
      argsFingerprint: "committed",
    }, 20);
    engine.writer.exec("COMMIT");
    engine[mutationReplayOwner].committed(committed);
    engine.close("clean");

    const reopened = new Engine(schema, database);
    expect(reopened[mutationReplayOwner].lookup("session-a", "rolled-back")).toBeNull();
    expect(reopened[mutationReplayOwner].lookup("session-a", "committed")).toEqual(committed);
    reopened.close("clean");
  });

  test("prunes one bounded expired prefix and keeps counters and cache exact", () => {
    const { database } = fresh();
    const engine = new Engine(schema, database);
    reconcile(engine);
    engine.writer.exec("BEGIN IMMEDIATE");
    const staged = Array.from({ length: 1_002 }, (_, index) => engine[mutationReplayOwner].stage({
      sessionId: `session-${index % 3}`,
      requestId: `request-${index}`,
      issuedAt: index,
      principalFingerprint: "principal",
      functionRef: "records.create",
      argsFingerprint: String(index),
      resultDisposition: "replayable",
      result: "0",
      resultBytes: 1,
      durability: "production",
    }, index + 1));
    engine.writer.exec("COMMIT");
    for (const receipt of staged) engine[mutationReplayOwner].committed(receipt);

    expect(engine[mutationReplayOwner].prune(1_001)).toBe(1_000);
    expect(engine[mutationReplayOwner].prune(1_001)).toBe(0);
    expect(engine[mutationReplayOwner].lookup("session-0", "request-0")).toBeNull();
    expect(engine[mutationReplayOwner].lookup("session-1", "request-1000")).not.toBeNull();
    expect(engine.status()).toMatchObject({ mutationRecords: 2, mutationResultBytes: 2 });
    engine.close("clean");
  });

  test("clamps a backward clock so newer receipts remain in the ordered retention prefix", () => {
    const { database } = fresh();
    const engine = new Engine(schema, database);
    reconcile(engine);
    const append = (requestId: string, now: number) => {
      engine.writer.exec("BEGIN IMMEDIATE");
      const staged = engine[mutationReplayOwner].stage({
        sessionId: "session",
        requestId,
        issuedAt: now,
        principalFingerprint: "principal",
        functionRef: "records.create",
        argsFingerprint: requestId,
        resultDisposition: "replayable",
        result: "0",
        resultBytes: 1,
        durability: "production",
      }, now);
      engine.writer.exec("COMMIT");
      engine[mutationReplayOwner].committed(staged);
      return staged;
    };
    expect(append("first", 100).completedAt).toBe(100);
    expect(append("clock-went-back", 50).completedAt).toBe(100);
    expect(engine[mutationReplayOwner].prune(100)).toBe(0);
    expect(engine[mutationReplayOwner].prune(101)).toBe(2);
    engine.close("clean");
  });

  test("rejects duplicate scopes, future versions, and nonmonotonic completion order", () => {
    const corrupt = (
      mutate: (database: Database) => void,
      expected: string,
    ) => {
      const { database } = fresh();
      const engine = new Engine(schema, database);
      reconcile(engine);
      engine.writer.exec("BEGIN IMMEDIATE");
      const staged = [1, 2].map((version) => engine[mutationReplayOwner].stage({
        sessionId: "session",
        requestId: `request-${version}`,
        issuedAt: version,
        principalFingerprint: "principal",
        functionRef: "records.create",
        argsFingerprint: String(version),
        resultDisposition: "replayable",
        result: "0",
        resultBytes: 1,
        durability: "production",
      }, version));
      engine.writer.exec("COMMIT");
      for (const receipt of staged) engine[mutationReplayOwner].committed(receipt);
      engine.close("clean");
      const databaseHandle = new Database(database, { safeIntegers: true });
      mutate(databaseHandle);
      databaseHandle.close();
      expect(() => new Engine(schema, database)).toThrow(expected);
    };

    corrupt(
      (database) => database.query("UPDATE _dbz_mutations SET request_id = 'request-1' WHERE commit_version = 2").run(),
      "duplicate scoped request",
    );
    corrupt(
      (database) => database.query("UPDATE _dbz_state SET commit_version = 1 WHERE singleton = 1").run(),
      "invalid commit order",
    );
    corrupt(
      (database) => database.query("UPDATE _dbz_mutations SET completed_at = 0 WHERE commit_version = 2").run(),
      "completion time is not monotonic",
    );
  });

  test("detects an unclean prior process without deleting WAL state", async () => {
    const { database } = fresh();
    const script = `
      import { v, defineSchema, defineTable, Engine, reconcile } from "@dbzz/server";
      const schema = defineSchema({ records: defineTable({ id: v.primaryKey(), value: v.string() }) });
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
    recovered.close("clean");
  });

  test("records only the first explicit shutdown outcome", () => {
    const { database } = fresh();
    const failed = new Engine(schema, database);
    reconcile(failed);
    failed.close("unclean");
    failed.close("clean");
    expect(cleanShutdown(database)).toBe(0n);

    const recovered = new Engine(schema, database);
    expect(recovered.recoveredFromCrash).toBe(true);
    recovered.close("clean");
    recovered.close("unclean");
    expect(cleanShutdown(database)).toBe(1n);

    const orderly = new Engine(schema, database);
    expect(orderly.recoveredFromCrash).toBe(false);
    orderly.close("clean");
  });

  test("rejects an absent shutdown outcome without releasing ownership", () => {
    const { database } = fresh();
    const engine = new Engine(schema, database);
    expect(() => (engine.close as (shutdown?: string) => void)()).toThrow(
      'engine close disposition must be exactly "clean" or "unclean"',
    );
    expect(engine.writer.query("SELECT 1 AS value").get()).toEqual({ value: 1n });
    engine.close("unclean");
    expect(cleanShutdown(database)).toBe(0n);
  });

  test("releases every native handle when the clean marker write fails", () => {
    const { database } = fresh();
    const engine = new Engine(schema, database);
    const additionalReader = engine.createReader();
    const closeAdditionalReader = additionalReader.close.bind(additionalReader);
    additionalReader.close = () => {
      closeAdditionalReader();
      throw new Error("secondary reader close failure");
    };
    engine.writer.exec("DROP TABLE _dbz_state");

    expect(() => engine.close("clean")).toThrow("no such table: _dbz_state");
    for (const connection of [engine.writer, engine.reader, additionalReader]) {
      expect(() => connection.query("SELECT 1").get()).toThrow("closed database");
    }
    expect(existsSync(`${database}.dbzz.lock`)).toBe(false);
  });

  test("scavenges pre-publish and post-publish bootstrap crash remnants", () => {
    const { database } = fresh();
    const prefix = `${database}.dbzz-init-`;
    const prePublish = `${prefix}00000000-0000-4000-8000-000000000001`;
    const unrelatedFile = `${prefix}deployment-notes`;
    const unrelatedDirectory = `${prefix}00000000-0000-4000-8000-000000000003`;
    writeFileSync(prePublish, "incomplete bootstrap");
    writeFileSync(`${prePublish}-journal`, "incomplete rollback journal");
    writeFileSync(unrelatedFile, "user-owned");
    mkdirSync(unrelatedDirectory);

    const initialized = new Engine(schema, database);
    reconcile(initialized);
    const lockedArtifact = `${prefix}00000000-0000-4000-8000-000000000004`;
    writeFileSync(lockedArtifact, "must remain while another process owns the lock");
    expect(() => new Engine(schema, database)).toThrow("already open by process");
    expect(existsSync(lockedArtifact)).toBe(true);
    initialized.close("clean");
    expect(existsSync(prePublish)).toBe(false);
    expect(existsSync(`${prePublish}-journal`)).toBe(false);
    expect(readFileSync(unrelatedFile, "utf8")).toBe("user-owned");
    expect(existsSync(unrelatedDirectory)).toBe(true);

    const postPublish = `${prefix}00000000-0000-4000-8000-000000000002`;
    linkSync(database, postPublish);
    writeFileSync(`${postPublish}-wal`, "stale staging WAL");
    expect(existsSync(postPublish)).toBe(true);

    const reopened = new Engine(schema, database);
    expect(reopened.commitVersion()).toBe(0n);
    reopened.close("clean");
    expect(existsSync(postPublish)).toBe(false);
    expect(existsSync(`${postPublish}-wal`)).toBe(false);
    expect(existsSync(lockedArtifact)).toBe(false);
    expect(readFileSync(unrelatedFile, "utf8")).toBe("user-owned");
    expect(existsSync(unrelatedDirectory)).toBe(true);
  });

  test("reopens a large recovery-free database without temporary-copy storage", async () => {
    const { root, database } = fresh();
    const engine = new Engine(schema, database);
    reconcile(engine);
    engine.writer.exec("BEGIN IMMEDIATE");
    engine.writer.query("INSERT INTO records (value) VALUES (?)").run("x".repeat(16 * 1_024 * 1_024));
    engine.allocateCommitVersion();
    engine.writer.exec("COMMIT");
    engine.close("clean");
    expect(statSync(database).size).toBeGreaterThan(16 * 1_024 * 1_024);
    expect(existsSync(`${database}-journal`)).toBe(false);
    expect(existsSync(`${database}-wal`) ? statSync(`${database}-wal`).size : 0).toBe(0);

    const unavailableTmp = join(root, "missing-tmp");
    const script = `
      import { v, defineSchema, defineTable, Engine } from "@dbzz/server";
      const schema = defineSchema({ records: defineTable({ id: v.primaryKey(), value: v.string() }) });
      const engine = new Engine(schema, ${JSON.stringify(database)});
      engine.close("clean");
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: join(import.meta.dir, "../../.."),
      env: { ...process.env, TMPDIR: unavailableTmp, TMP: unavailableTmp, TEMP: unavailableTmp },
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    expect(existsSync(unavailableTmp)).toBe(false);
  }, 15_000);
});

describe("checkpoint, backup, and restore", () => {
  test("reports checkpoint progress and restores a verified continued database", () => {
    const source = fresh();
    const engine = new Engine(schema, source.database);
    reconcile(engine);
    expect(engine.status()).toMatchObject({
      lastCheckpointAtMs: null,
      lastCheckpoint: null,
    });
    engine.writer.exec("BEGIN IMMEDIATE");
    engine.writer.query("INSERT INTO records (value) VALUES (?)").run("backed-up");
    expect(engine.allocateCommitVersion()).toBe(1n);
    engine.writer.exec("COMMIT");

    const checkpoint = engine.checkpoint("PASSIVE");
    expect(checkpoint).toMatchObject({ mode: "PASSIVE", busy: 0, oldestReader: null });
    expect(Object.isFrozen(checkpoint)).toBe(true);
    expect(checkpoint.totalFrames).toBeGreaterThanOrEqual(checkpoint.checkpointedFrames);
    expect(engine.status()).toMatchObject({
      lastCheckpointAtMs: expect.any(Number),
      lastCheckpoint: checkpoint,
    });
    const latestCheckpoint = engine.checkpoint("PASSIVE");
    expect(latestCheckpoint).not.toBe(checkpoint);
    expect(engine.status().lastCheckpoint).toBe(latestCheckpoint);

    const artifact = join(source.root, "backup.db");
    const manifest = engine.backup(artifact);
    expect(manifest).toMatchObject({
      format: 1,
      commitVersion: 1n,
      durability: "production",
      schemaFingerprint: engine.schemaFingerprint(),
    });
    expect(manifest.sha256).toBe(createHash("sha256").update(readFileSync(artifact)).digest("hex"));
    engine.close("clean");

    const restored = fresh().database;
    Engine.restore(artifact, restored, manifest);
    const reopened = new Engine(schema, restored);
    reconcile(reopened);
    expect(reopened.commitVersion()).toBe(1n);
    expect(reopened.status()).toMatchObject({
      lastCheckpointAtMs: expect.any(Number),
      lastCheckpoint: null,
    });
    expect(reopened.writer.query("SELECT value FROM records").get()).toEqual({ value: "backed-up" });
    reopened.writer.exec("BEGIN IMMEDIATE");
    expect(reopened.allocateCommitVersion()).toBe(2n);
    reopened.writer.exec("COMMIT");
    reopened.close("clean");
  });

  test("refuses an artifact whose manifest digest no longer matches", () => {
    const source = fresh();
    const engine = new Engine(schema, source.database);
    reconcile(engine);
    const artifact = join(source.root, "backup.db");
    const manifest = engine.backup(artifact);
    engine.close("clean");
    const bytes = readFileSync(artifact);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
    writeFileSync(artifact, bytes);
    expect(() => Engine.restore(artifact, fresh().database, manifest)).toThrow(CorruptDatabaseError);
  });
});
