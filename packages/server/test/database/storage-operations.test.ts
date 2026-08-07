import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import {
  CorruptDatabaseError,
  DatabaseAlreadyOpenError,
  v,
  defineApp,
  defineSchema,
  defineTable,
  Engine,
  IncompatibleDatabaseError,
  indexSqlName,
  reconcile,
  resetDatabase,
  restoreVerifiedDatabase,
} from "@ackerdb/server";
import { DatabaseRestoreTarget } from "../../src/database/engine.ts";
import { DatabaseOwnership, coordinationDatabasePath } from "../../src/database/ownership.ts";
import { mutationReplayOwner } from "../../src/database/mutation-replay.ts";

const roots: string[] = [];
const fresh = () => {
  const root = mkdtempSync(join(tmpdir(), "ackerdb-storage-"));
  roots.push(root);
  return { root, database: join(root, "data.db") };
};

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

const schema = defineSchema({
  records: defineTable({ id: v.primaryKey(), value: v.string() }),
});
const app = defineApp({ schema });

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
      meta: db.query("SELECT key, value FROM _ackerdb_meta ORDER BY key").all(),
      state: db.query("SELECT * FROM _ackerdb_state ORDER BY singleton").all(),
      tags: db.query("SELECT type, variant, tag FROM _ackerdb_tags ORDER BY type, variant").all(),
      migrations: db.query("SELECT * FROM _ackerdb_migrations ORDER BY number").all(),
    };
  } finally {
    db.close();
  }
}

function cleanShutdown(database: string): bigint {
  const db = new Database(database, { readonly: true, safeIntegers: true });
  try {
    return (db.query("SELECT clean_shutdown FROM _ackerdb_state WHERE singleton = 1").get() as {
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
      engineSchemaVersion: 13,
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

  test("rejects another process owner and incomplete internal schemas", () => {
    const { database } = fresh();
    const owner = new Engine(schema, database);
    expect(() => new Engine(schema, database)).toThrow("database is already open");
    owner.close("clean");

    const legacy = fresh().database;
    const db = new Database(legacy, { create: true });
    db.exec("CREATE TABLE _ackerdb_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.close();
    expect(() => new Engine(schema, legacy)).toThrow(IncompatibleDatabaseError);
  });

  test("keeps persistent coordination identity while releasing ownership with the process handle", () => {
    const { database } = fresh();
    const coordination = coordinationDatabasePath(database);
    const first = new Engine(schema, database);
    expect(existsSync(coordination)).toBe(true);
    first.close("clean");
    expect(existsSync(coordination)).toBe(true);
    const replacement = new Engine(schema, database);
    replacement.close("clean");
    expect(existsSync(coordination)).toBe(true);
  });

  test("uses one canonical data pathname for a symbolic-link database and all SQLite sidecars", () => {
    const { root, database } = fresh();
    const initialized = new Engine(schema, database);
    initialized.close("clean");
    const alias = join(root, "data-alias.db");
    symlinkSync(database, alias);

    const engine = new Engine(schema, alias);
    expect(engine.path).toBe(realpathSync(database));
    expect(() => new Engine(schema, database)).toThrow(DatabaseAlreadyOpenError);
    expect(existsSync(`${engine.path}-wal`)).toBe(true);
    expect(existsSync(`${alias}-wal`)).toBe(false);
    engine.close("clean");
  });

  test("start, restore, and reset share one ownership lease", () => {
    const { database } = fresh();
    const engine = new Engine(schema, database);
    expect(() => DatabaseRestoreTarget.acquire(database)).toThrow(DatabaseAlreadyOpenError);
    expect(() => resetDatabase(database)).toThrow(DatabaseAlreadyOpenError);
    expect(existsSync(database)).toBe(true);
    engine.close("clean");

    const vacant = fresh().database;
    const restore = DatabaseRestoreTarget.acquire(vacant);
    expect(() => new Engine(schema, vacant)).toThrow(DatabaseAlreadyOpenError);
    expect(() => resetDatabase(vacant)).toThrow(DatabaseAlreadyOpenError);
    restore.close();
    const initialized = new Engine(schema, vacant);
    initialized.close("clean");
  });

  test("restore vacancy accepts an exact pre-link coordination crash residue", () => {
    const { database } = fresh();
    const coordination = coordinationDatabasePath(database);
    const residue = `${coordination}.ackerdb-bootstrap-00000000-0000-4000-8000-000000000001`;
    const seed = DatabaseOwnership.acquire(database);
    seed.release();
    renameSync(coordination, residue);

    const restore = DatabaseRestoreTarget.acquire(database);
    expect(existsSync(residue)).toBe(true);
    expect(statSync(residue, { bigint: true }).ino).not.toBe(
      statSync(coordination, { bigint: true }).ino,
    );
    restore.assertVacant();
    restore.close();
  });

  test("restore vacancy clears the framework-owned telemetry journal family", () => {
    const { database } = fresh();
    const telemetry = `${database}.telemetry`;
    for (const artifact of [telemetry, `${telemetry}-wal`, `${telemetry}-shm`]) {
      writeFileSync(artifact, artifact);
    }

    const restore = DatabaseRestoreTarget.acquire(database);
    for (const artifact of [telemetry, `${telemetry}-wal`, `${telemetry}-shm`]) {
      expect(existsSync(artifact)).toBe(false);
    }
    restore.assertVacant();
    restore.close();
  });

  test("restore explicitly refuses a symbolic-link target instead of creating a second path", () => {
    const { root, database } = fresh();
    const alias = join(root, "data-alias.db");
    symlinkSync(database, alias);

    expect(() => DatabaseRestoreTarget.acquire(alias)).toThrow(
      "restore target must not be a symbolic link",
    );
  });

  test("restore canonicalizes a symbolic-link parent before deriving its ownership and staging paths", () => {
    const { root } = fresh();
    const canonicalDirectory = join(root, "canonical");
    const aliasDirectory = join(root, "alias");
    mkdirSync(canonicalDirectory);
    symlinkSync(canonicalDirectory, aliasDirectory);
    const target = join(aliasDirectory, "data.db");
    const canonical = join(realpathSync(canonicalDirectory), "data.db");

    const restore = DatabaseRestoreTarget.acquire(target);
    expect(restore.path).toBe(canonical);
    expect(restore.stagingPath.startsWith(`${canonical}.ackerdb-restore-`)).toBe(true);
    restore.assertVacant();
    restore.close();
  });

  test("reset removes only the canonical family and exact AckerDB staging artifacts", () => {
    const { root, database } = fresh();
    const engine = new Engine(schema, database);
    engine.close("clean");
    const canonical = realpathSync(database);
    const init = `${canonical}.ackerdb-init-00000000-0000-4000-8000-000000000001`;
    const restore = `${canonical}.ackerdb-restore-00000000-0000-4000-8000-000000000002`;
    const lookalike = `${canonical}.ackerdb-restore-not-a-uuid`;
    const unrelated = join(root, "keep-me");
    const telemetry = `${canonical}.telemetry`;
    for (const artifact of [
      init,
      `${init}-journal`,
      restore,
      `${restore}-shm`,
      telemetry,
      `${telemetry}-wal`,
      lookalike,
      unrelated,
    ]) {
      writeFileSync(artifact, artifact);
    }
    writeFileSync(`${canonical}-wal`, "stale WAL");

    const result = resetDatabase(database);
    expect(result.removed).toEqual(expect.arrayContaining([
      canonical,
      `${canonical}-wal`,
      init,
      `${init}-journal`,
      restore,
      `${restore}-shm`,
      telemetry,
      `${telemetry}-wal`,
    ]));
    for (const removed of result.removed) expect(existsSync(removed)).toBe(false);
    expect(readFileSync(lookalike, "utf8")).toBe(lookalike);
    expect(readFileSync(unrelated, "utf8")).toBe(unrelated);
    expect(existsSync(coordinationDatabasePath(database))).toBe(true);

    const repeated = resetDatabase(database);
    expect(repeated.removed).toEqual([]);
    expect(existsSync(coordinationDatabasePath(database))).toBe(true);
  });

  test("reset through a symbolic link clears and can reinitialize the canonical database", () => {
    const { root, database } = fresh();
    const initialized = new Engine(schema, database);
    initialized.close("clean");
    const canonical = realpathSync(database);
    const alias = join(root, "data-alias.db");
    symlinkSync(database, alias);

    const result = resetDatabase(alias);
    expect(result.database).toBe(canonical);
    expect(existsSync(canonical)).toBe(false);
    expect(lstatSync(alias).isSymbolicLink()).toBe(true);
    expect(existsSync(coordinationDatabasePath(canonical))).toBe(true);

    const replacement = new Engine(schema, alias);
    expect(replacement.path).toBe(canonical);
    replacement.close("clean");
    expect(existsSync(canonical)).toBe(true);
  });

  test("refuses to adopt user or partial internal objects when metadata is absent", () => {
    for (const ddl of [
      "CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL)",
      "CREATE TABLE _ackerdb_tags (type TEXT NOT NULL, variant TEXT NOT NULL, tag INTEGER NOT NULL)",
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
    db.exec("ALTER TABLE _ackerdb_mutations ADD COLUMN unexpected TEXT");
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
      records: defineTable({ id: v.primaryKey(), value: v.string() }).index(["value"], {
        unique: true,
      }),
    });
    const physicalIndex = indexSqlName("records", indexed.tables.records.indexes[0]!.name);
    const corruptions = [
      `DROP INDEX "${physicalIndex}"`,
      `DROP INDEX "${physicalIndex}"; CREATE INDEX "${physicalIndex}" ON records (value)`,
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
    live.writer.exec(`DROP INDEX "${physicalIndex}"`);
    const before = live.writer.query("SELECT key, value FROM _ackerdb_meta ORDER BY key").all();
    expect(() => reconcile(live)).toThrow(CorruptDatabaseError);
    expect(live.writer.query("SELECT key, value FROM _ackerdb_meta ORDER BY key").all()).toEqual(before);
    live.close("clean");
  });

  test("stored index columns must be own snapshot entries", () => {
    for (const inheritedName of ["toString", "constructor"]) {
      const { database } = fresh();
      const engine = new Engine(schema, database);
      reconcile(engine);
      const snapshot = engine.loadSnapshot()!;
      const malformedIndex = `s_n_b_${inheritedName.length}_${inheritedName}`;
      snapshot.tables.records!.indexes.push({
        name: malformedIndex,
        columns: [inheritedName],
        unique: false,
        algorithm: "btree",
      });
      engine.saveSnapshot(snapshot);
      expect(() => engine.loadSnapshot()).toThrow(
        `stored schema snapshot is invalid: records.${malformedIndex} has an invalid definition`,
      );
      engine.close("clean");
    }
  });

  test("rejects malformed stored descriptor metadata before startup writes", () => {
    const constrained = defineSchema({
      records: defineTable({
        id: v.primaryKey(),
        score: v.int().min(0).max(10),
        serial: v.bigint().min(0n).max(10n),
        profile: v.object({ handle: v.string().regex(/^[a-z]+$/) }),
      }),
    });
    const corruptions: Array<{
      readonly name: string;
      readonly mutate: (columns: Record<string, Record<string, unknown>>) => void;
    }> = [
      {
        name: "numeric bound with the wrong type",
        mutate: (columns) => {
          columns.score!.min = "0";
        },
      },
      {
        name: "noncanonical bigint bound",
        mutate: (columns) => {
          columns.serial!.min = "01";
        },
      },
      {
        name: "out-of-range bigint bound",
        mutate: (columns) => {
          columns.serial!.max = "9223372036854775808";
        },
      },
      {
        name: "contradictory bounds",
        mutate: (columns) => {
          columns.score!.min = 11;
        },
      },
      {
        name: "uncompilable regex",
        mutate: (columns) => {
          const shape = columns.profile!.shape as Record<string, Record<string, unknown>>;
          shape.handle!.regex = "[";
        },
      },
      {
        name: "unknown kind-specific field",
        mutate: (columns) => {
          columns.score!.unexpected = true;
        },
      },
      {
        name: "stored optional nested value",
        mutate: (columns) => {
          const shape = columns.profile!.shape as Record<string, Record<string, unknown>>;
          shape.handle = { k: "optional", inner: { k: "string" } };
        },
      },
    ];

    for (const corruption of corruptions) {
      const { database } = fresh();
      const engine = new Engine(constrained, database);
      reconcile(engine);
      engine.close("clean");

      const db = new Database(database, { safeIntegers: true });
      const row = db.query("SELECT value FROM _ackerdb_meta WHERE key = 'schema'").get() as {
        value: string;
      };
      db.query(
        "INSERT INTO _ackerdb_migrations (number, name, identity, applied_at) VALUES (?, ?, ?, ?)",
      ).run(1, "existing evidence", "0".repeat(64), 1);
      const snapshot = JSON.parse(row.value) as {
        tables: { records: { columns: Record<string, Record<string, unknown>> } };
      };
      corruption.mutate(snapshot.tables.records.columns);
      db.query("UPDATE _ackerdb_meta SET value = ? WHERE key = 'schema'")
        .run(JSON.stringify(snapshot));
      db.close();

      const before = ownedState(database);
      expect(before.migrations, corruption.name).toHaveLength(1);
      let opened: Engine | undefined;
      expect(() => {
        try {
          opened = new Engine(constrained, database);
        } finally {
          opened?.close("clean");
        }
      }, corruption.name).toThrow(CorruptDatabaseError);
      expect(ownedState(database), corruption.name).toEqual(before);
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
      "UPDATE _ackerdb_tags SET tag = 0 WHERE type = 'RecordState' AND variant = 'ready'",
      "DELETE FROM _ackerdb_tags WHERE type = 'RecordState' AND variant = 'done'",
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
    db.query("UPDATE _ackerdb_state SET mutation_records = 1 WHERE singleton = 1").run();
    db.close();
    expect(() => new Engine(schema, database)).toThrow(CorruptDatabaseError);
  });

  test("stores scoped mutation receipts atomically and prunes only selected expired rows", () => {
    const { database } = fresh();
    const engine = new Engine(schema, database);
    reconcile(engine);
    expect(engine.writer.query("PRAGMA index_list('_ackerdb_mutations')").all()).toEqual([]);
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
      (database) => database.query("UPDATE _ackerdb_mutations SET request_id = 'request-1' WHERE commit_version = 2").run(),
      "duplicate scoped request",
    );
    corrupt(
      (database) => database.query("UPDATE _ackerdb_state SET commit_version = 1 WHERE singleton = 1").run(),
      "invalid commit order",
    );
    corrupt(
      (database) => database.query("UPDATE _ackerdb_mutations SET completed_at = 0 WHERE commit_version = 2").run(),
      "completion time is not monotonic",
    );
  });

  test("detects an unclean prior process without deleting WAL state", async () => {
    const { database } = fresh();
    const script = `
      import { v, defineSchema, defineTable, Engine, reconcile } from "@ackerdb/server";
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
    engine.writer.exec("DROP TABLE _ackerdb_state");

    let closeFailure: unknown;
    try {
      engine.close("clean");
    } catch (error) {
      closeFailure = error;
    }
    expect(closeFailure).toBeInstanceOf(AggregateError);
    expect((closeFailure as AggregateError).errors.map(String)).toEqual(expect.arrayContaining([
      expect.stringContaining("no such table: _ackerdb_state"),
      expect.stringContaining("secondary reader close failure"),
    ]));
    for (const connection of [engine.writer, engine.reader, additionalReader]) {
      expect(() => connection.query("SELECT 1").get()).toThrow("closed database");
    }
    expect(existsSync(coordinationDatabasePath(database))).toBe(true);
    const ownership = DatabaseOwnership.acquire(database);
    ownership.release();
  });

  test("scavenges pre-publish and post-publish bootstrap crash remnants", () => {
    const { database } = fresh();
    const prefix = `${database}.ackerdb-init-`;
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
    expect(() => new Engine(schema, database)).toThrow("database is already open");
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
      import { v, defineSchema, defineTable, Engine } from "@ackerdb/server";
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
  test("reports checkpoint progress and restores a verified continued database", async () => {
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
    await restoreVerifiedDatabase(artifact, restored, manifest, () => app);
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

  test("runs restore integration before canonical database publication", async () => {
    const source = fresh();
    const engine = new Engine(schema, source.database);
    reconcile(engine);
    const artifact = join(source.root, "backup.db");
    const manifest = engine.backup(artifact);
    engine.close("clean");
    const target = fresh().database;
    let rolledBack = false;

    await expect(restoreVerifiedDatabase(
      artifact,
      target,
      manifest,
      () => app,
      {
        prepare: () => {
          expect(existsSync(target)).toBe(false);
          throw new Error("File restore failed before publication");
        },
        rollback: () => {
          rolledBack = true;
        },
      },
    )).rejects.toThrow("File restore failed before publication");
    expect(rolledBack).toBe(true);
    expect(existsSync(target)).toBe(false);

    const racedTarget = fresh().database;
    const competitor = "canonical competitor";
    rolledBack = false;
    await expect(restoreVerifiedDatabase(
      artifact,
      racedTarget,
      manifest,
      () => app,
      {
        prepare: () => writeFileSync(racedTarget, competitor),
        rollback: () => {
          rolledBack = true;
        },
      },
    )).rejects.toThrow("changed before publication");
    expect(rolledBack).toBe(true);
    expect(readFileSync(racedTarget, "utf8")).toBe(competitor);
  });

  test("refuses an artifact whose manifest digest no longer matches", async () => {
    const source = fresh();
    const engine = new Engine(schema, source.database);
    reconcile(engine);
    const artifact = join(source.root, "backup.db");
    const manifest = engine.backup(artifact);
    engine.close("clean");
    const bytes = readFileSync(artifact);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
    writeFileSync(artifact, bytes);
    await expect(
      restoreVerifiedDatabase(artifact, fresh().database, manifest, () => app),
    ).rejects.toThrow(CorruptDatabaseError);
  });

  test("refuses interrupted restore evidence at startup and safely completes an exact retry", async () => {
    const source = fresh();
    const owner = new Engine(schema, source.database);
    reconcile(owner);
    owner.writer.query("INSERT INTO records (value) VALUES (?)").run("restored");
    const artifact = join(source.root, "backup.db");
    const manifest = owner.backup(artifact);
    owner.close("clean");

    const target = fresh().database;
    const interrupted = `${target}.ackerdb-restore-00000000-0000-4000-8000-000000000001`;
    writeFileSync(interrupted, "partial restore");
    expect(() => new Engine(schema, target)).toThrow("interrupted restore");
    expect(existsSync(target)).toBe(false);
    expect(readFileSync(interrupted, "utf8")).toBe("partial restore");

    const importedEntry = join(dirname(target), "created-by-app-import");
    await expect(restoreVerifiedDatabase(artifact, target, manifest, () => {
      writeFileSync(importedEntry, "preserve import evidence");
      return app;
    })).rejects.toThrow("unrelated entry");
    expect(readFileSync(importedEntry, "utf8")).toBe("preserve import evidence");
    expect(existsSync(target)).toBe(false);
    rmSync(importedEntry);

    let loaderEntered!: () => void;
    let releaseLoader!: () => void;
    const entered = new Promise<void>((resolve) => {
      loaderEntered = resolve;
    });
    const loaderGate = new Promise<void>((resolve) => {
      releaseLoader = resolve;
    });
    const restoring = restoreVerifiedDatabase(artifact, target, manifest, async () => {
      loaderEntered();
      await loaderGate;
      return app;
    });
    await entered;
    expect(() => new Engine(schema, target)).toThrow("database is already open");
    expect(existsSync(target)).toBe(false);
    releaseLoader();
    const status = await restoring;
    expect(status.commitVersion).toBe(manifest.commitVersion);
    expect(existsSync(interrupted)).toBe(false);
    expect(existsSync(target)).toBe(true);

    const postLinkEvidence = `${target}.ackerdb-restore-00000000-0000-4000-8000-000000000002`;
    linkSync(target, postLinkEvidence);
    const reopened = new Engine(schema, target);
    expect(reopened.writer.query("SELECT value FROM records").get()).toEqual({ value: "restored" });
    reopened.close("clean");
    expect(existsSync(postLinkEvidence)).toBe(false);
  });

  test("no-clobber publication preserves a canonical competitor byte-for-byte", () => {
    const source = fresh();
    const owner = new Engine(schema, source.database);
    reconcile(owner);
    const artifact = join(source.root, "backup.db");
    const manifest = owner.backup(artifact);
    owner.close("clean");

    const target = fresh().database;
    const restore = DatabaseRestoreTarget.acquire(target);
    try {
      restore.restore(artifact, manifest);
      const staged = restore.open(schema, { integrityCheck: "full" });
      staged.close("clean");
      const competitor = Buffer.from("canonical competitor");
      writeFileSync(target, competitor);
      expect(() => restore.publish()).toThrow("changed before publication");
      expect(readFileSync(target)).toEqual(competitor);
    } finally {
      restore.close();
    }
    expect(readFileSync(target, "utf8")).toBe("canonical competitor");
  });
});
