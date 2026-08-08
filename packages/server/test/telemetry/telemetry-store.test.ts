import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_TELEMETRY_RETENTION,
  TELEMETRY_STORE_SCHEMA_VERSION,
  TelemetryStore,
  resolveTelemetryRetention,
} from "@ackerdb/server";

const directories = new Set<string>();
const stores = new Set<TelemetryStore>();

afterEach(() => {
  for (const store of stores) {
    try {
      store.close();
    } catch {
      // A suite that already closed its store owns that outcome.
    }
  }
  stores.clear();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories.clear();
});

function sidecarPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "ackerdb-telemetry-store-"));
  directories.add(directory);
  return join(directory, "data.db.telemetry");
}

function open(options: ConstructorParameters<typeof TelemetryStore>[0]): TelemetryStore {
  const created = new TelemetryStore(options);
  stores.add(created);
  return created;
}

/**
 * One synthetic kind with a timestamp index, so a suite about the store's own
 * budget and clocks does not depend on what any real kind happens to write.
 */
function rows(store: TelemetryStore, table: string, retention: "debug" | "error") {
  store.register({
    name: table,
    initialize: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS ${table} (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp REAL NOT NULL,
          payload TEXT NOT NULL
        )
      `);
      database.exec(`CREATE INDEX IF NOT EXISTS ${table}_ts ON ${table} (timestamp)`);
      return [Object.freeze({
        retention,
        deleteExpired: (cutoffMs: number, limit: number) => database.query(`
          DELETE FROM ${table}
          WHERE id IN (SELECT id FROM ${table} WHERE timestamp < ? ORDER BY timestamp LIMIT ?)
          RETURNING id
        `).all(cutoffMs, limit).length,
      })];
    },
  });
  const insert = store.database.query(`INSERT INTO ${table} (timestamp, payload) VALUES (?, ?)`);
  return {
    write: (count: number, timestamp: number, bytes = 4_000) => {
      store.database.transaction(() => {
        for (let index = 0; index < count; index++) insert.run(timestamp, "x".repeat(bytes));
      })();
    },
    count: () => Number(
      (store.database.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: bigint }).n,
    ),
  };
}

describe("telemetry retention registry", () => {
  test("derives its classes from one defaults object", () => {
    expect(resolveTelemetryRetention()).toEqual(DEFAULT_TELEMETRY_RETENTION);
    expect(resolveTelemetryRetention({ debug: 1_000 }).debug).toBe(1_000);
    expect(resolveTelemetryRetention({ debug: 1_000 }).error)
      .toBe(DEFAULT_TELEMETRY_RETENTION.error);
  });

  test("refuses a clock it does not have and a duration that is not one", () => {
    expect(() => resolveTelemetryRetention({ sessions: 1_000 }))
      .toThrow(/unknown telemetry retention class "sessions"/);
    expect(() => resolveTelemetryRetention({ debug: 0 }))
      .toThrow(/telemetry retention debug must be a positive integer/);
  });
});

describe("TelemetryStore", () => {
  test("refuses a duplicate kind and a set with no clock", () => {
    const store = open({ path: sidecarPath() });
    store.register({ name: "twice", initialize: () => [] });
    expect(() => store.register({ name: "twice", initialize: () => [] }))
      .toThrow(/telemetry kind "twice" is already registered/);
    expect(() => store.register({
      name: "unclocked",
      initialize: () => [{ retention: "sessions" as never, deleteExpired: () => 0 }],
    })).toThrow(/expires on unknown retention class "sessions"/);
  });

  test("expires by the current clocks and bounds one pass", () => {
    const now = 1_000 * 86_400_000;
    const store = open({
      path: sidecarPath(),
      retention: { debug: 86_400_000 },
      limits: { maxExpiredRowsPerPass: 4 },
      now: () => now,
    });
    const table = rows(store, "probe_rows", "debug");
    table.write(10, now - 5 * 86_400_000);
    table.write(2, now);

    expect(store.maintain()).toBe(4);
    expect(table.count()).toBe(8);
    expect(store.maintain()).toBe(4);
    expect(store.maintain()).toBe(2);
    // The two fresh rows outlive every pass: retention is a clock, not a cap.
    expect(store.maintain()).toBe(0);
    expect(table.count()).toBe(2);
    expect(store.snapshot().expiredRecords.debug).toBe(10);
  });

  test("holds the byte budget by evicting the shortest clock first", () => {
    const path = sidecarPath();
    const now = 1_000 * 86_400_000;
    const store = open({
      path,
      limits: { maxStoredBytes: 1_024 * 1_024 },
      now: () => now,
    });
    const short = rows(store, "probe_short", "debug");
    const long = rows(store, "probe_long", "error");
    // Fresh by both clocks, so nothing expires: only the disk guard can act.
    long.write(300, now);
    short.write(300, now);
    store.maintain();
    expect(store.snapshot().storedBytes).toBeGreaterThan(1_024 * 1_024);

    for (let pass = 0; pass < 12; pass++) {
      store.maintain();
      if (!store.snapshot().overBudget) break;
    }

    const snapshot = store.snapshot();
    expect(snapshot.overBudget).toBe(false);
    expect(snapshot.storedBytes).toBeLessThanOrEqual(1_024 * 1_024);
    // The shortest clock pays first.
    expect(snapshot.evictedRecords.debug).toBeGreaterThan(0);
    expect(short.count()).toBeLessThan(long.count());
    // And the pages actually left the file: checkpointing writes the logical
    // size the budget measured out to the filesystem.
    store.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    expect(statSync(path).size).toBeLessThanOrEqual(1_024 * 1_024);
  });

  test("discards a sidecar whose stored shape is not the current one", () => {
    const path = sidecarPath();
    const stale = new Database(path, { create: true, safeIntegers: true, strict: true });
    stale.exec("CREATE TABLE _ackerdb_telemetry_journal (id INTEGER PRIMARY KEY)");
    stale.query("INSERT INTO _ackerdb_telemetry_journal (id) VALUES (1)").run();
    stale.exec(`PRAGMA user_version = ${TELEMETRY_STORE_SCHEMA_VERSION + 1}`);
    stale.close(false);

    const store = open({ path });
    // Only the store's own health row survives a discard; every kind's table is
    // recreated by that kind when it registers.
    expect(store.database.query(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).all()).toEqual([{ name: "_ackerdb_telemetry_health" }]);
    expect(store.database.query("SELECT * FROM pragma_user_version() AS v").get())
      .toEqual({ user_version: BigInt(TELEMETRY_STORE_SCHEMA_VERSION) });
  });

  test("keeps a sidecar this version already wrote", () => {
    const path = sidecarPath();
    const first = open({ path });
    rows(first, "probe_rows", "debug").write(3, Date.now());
    first.close();
    stores.clear();

    const second = open({ path });
    expect(second.database.query("SELECT COUNT(*) AS n FROM probe_rows").get())
      .toEqual({ n: 3n });
  });

  test("probes the write boundary, not merely a readable connection", () => {
    const store = open({ path: sidecarPath() });
    const before = store.database.query(
      "SELECT probes FROM _ackerdb_telemetry_health WHERE singleton = 1",
    ).get() as { readonly probes: bigint };
    expect(store.observeFailure(new Error("one row"))).toBe(true);
    // A full disk answers reads perfectly well, so the probe has to commit.
    expect(store.database.query(
      "SELECT probes FROM _ackerdb_telemetry_health WHERE singleton = 1",
    ).get()).toEqual({ probes: before.probes + 1n });
  });

  test("contains a failure the connection survives and fails on one it does not", () => {
    const store = open({ path: sidecarPath() });
    const observed: unknown[] = [];
    store.onFailure((error) => observed.push(error));

    expect(store.observeFailure(new Error("one row"))).toBe(true);
    expect(store.snapshot()).toMatchObject({ state: "ready", containedFailures: 1 });
    expect(observed).toHaveLength(0);

    store.database.close(false);
    expect(store.observeFailure(new Error("gone"))).toBe(false);
    expect(store.snapshot()).toMatchObject({ state: "failed", containedFailures: 1 });
    expect(observed).toHaveLength(1);
    // Every later report is refused without re-notifying: one failure, one event.
    expect(store.observeFailure(new Error("still gone"))).toBe(false);
    expect(observed).toHaveLength(1);
  });

  test("counts one throw observed by two frames as one contained failure", () => {
    const store = open({ path: sidecarPath() });
    const error = new Error("one throw, two frames");
    expect(store.observeFailure(error)).toBe(true);
    expect(store.observeFailure(error)).toBe(true);
    expect(store.snapshot().containedFailures).toBe(1);
  });
});
