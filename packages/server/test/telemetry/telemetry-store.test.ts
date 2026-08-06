import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_TELEMETRY_RETENTION,
  TelemetryStore,
  type TelemetryExpirableSet,
  type TelemetryRetentionClass,
} from "@ackerdb/server";

const DAY_MS = 86_400_000;
const NOW = 1_700_000_000_000;

const directories = new Set<string>();

afterEach(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories.clear();
});

function storePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "ackerdb-telemetry-store-"));
  directories.add(directory);
  return join(directory, "data.db.telemetry");
}

interface RegisteredTable {
  readonly insert: (timestampMs: number) => void;
  readonly count: () => number;
}

function registerTable(
  store: TelemetryStore,
  name: string,
  retention: TelemetryRetentionClass,
): RegisteredTable {
  const table = name.replaceAll("-", "_");
  let database!: Database;
  store.register({
    name,
    initialize: (handle) => {
      database = handle;
      handle.exec(`
        CREATE TABLE IF NOT EXISTS ${table} (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp REAL NOT NULL
        )
      `);
      handle.exec(`CREATE INDEX IF NOT EXISTS ${table}_timestamp ON ${table} (timestamp)`);
      const expire: TelemetryExpirableSet = {
        retention,
        deleteExpired: (cutoffMs, limit) => database.query(`
          DELETE FROM ${table}
          WHERE id IN (
            SELECT id FROM ${table} WHERE timestamp < ? ORDER BY timestamp LIMIT ?
          )
          RETURNING id
        `).all(cutoffMs, limit).length,
      };
      return [expire];
    },
  });
  return Object.freeze({
    insert: (timestampMs: number) => {
      database.query(`INSERT INTO ${table} (timestamp) VALUES (?)`).run(timestampMs);
    },
    count: () => Number((database.query(
      `SELECT COUNT(*) AS rows FROM ${table}`,
    ).get() as { readonly rows: bigint }).rows),
  });
}

describe("TelemetryStore", () => {
  test("expires registered rows by the current per-class clock", () => {
    const store = new TelemetryStore({ path: storePath(), now: () => NOW });
    const spans = registerTable(store, "spans-test", "spans");
    spans.insert(NOW - 8 * DAY_MS);
    spans.insert(NOW - 8 * DAY_MS);
    spans.insert(NOW - DAY_MS);

    expect(store.maintain()).toBe(2);
    expect(spans.count()).toBe(1);
    expect(store.snapshot()).toMatchObject({
      retention: DEFAULT_TELEMETRY_RETENTION,
      expiredRecords: { spans: 2, debug: 0 },
    });
    store.close();
  });

  test("applies a shorter clock retroactively to already-stored rows", () => {
    const path = storePath();
    const first = new TelemetryStore({ path, now: () => NOW });
    const firstSpans = registerTable(first, "spans-test", "spans");
    firstSpans.insert(NOW - 5 * DAY_MS);
    expect(first.maintain()).toBe(0);
    expect(firstSpans.count()).toBe(1);
    first.close();

    const shortened = new TelemetryStore({
      path,
      now: () => NOW,
      retention: { spans: DAY_MS },
    });
    const spans = registerTable(shortened, "spans-test", "spans");
    expect(shortened.maintain()).toBe(1);
    expect(spans.count()).toBe(0);
    shortened.close();
  });

  test("bounds one maintenance pass and resumes on the next", () => {
    const store = new TelemetryStore({
      path: ":memory:",
      now: () => NOW,
      maxExpiredRowsPerPass: 2,
    });
    const spans = registerTable(store, "spans-test", "spans");
    for (let row = 0; row < 5; row++) spans.insert(NOW - 8 * DAY_MS);

    expect(store.maintain()).toBe(2);
    expect(spans.count()).toBe(3);
    expect(store.maintain()).toBe(2);
    expect(store.maintain()).toBe(1);
    expect(store.maintain()).toBe(0);
    expect(store.snapshot().expiredRecords.spans).toBe(5);
    store.close();
  });

  test("round-robins the bounded budget across classes over successive passes", () => {
    const store = new TelemetryStore({
      path: ":memory:",
      now: () => NOW,
      maxExpiredRowsPerPass: 2,
    });
    const spans = registerTable(store, "spans-test", "spans");
    const analytics = registerTable(store, "analytics-test", "analytics");
    for (let row = 0; row < 3; row++) {
      spans.insert(NOW - 8 * DAY_MS);
      analytics.insert(NOW - 91 * DAY_MS);
    }

    expect(store.maintain()).toBe(2);
    expect(store.maintain()).toBe(2);
    expect(store.snapshot().expiredRecords).toMatchObject({ spans: 2, analytics: 2 });
    expect(store.maintain()).toBe(2);
    expect(store.maintain()).toBe(0);
    expect(spans.count()).toBe(0);
    expect(analytics.count()).toBe(0);
    store.close();
  });

  test("rejects invalid retention configuration and budgets", () => {
    expect(() => new TelemetryStore({ path: ":memory:", retention: { debug: 0 } }))
      .toThrow(RangeError);
    expect(() => new TelemetryStore({ path: ":memory:", retention: { info: -DAY_MS } }))
      .toThrow(RangeError);
    expect(() => new TelemetryStore({ path: ":memory:", retention: { spans: 1.5 } }))
      .toThrow(RangeError);
    expect(() => new TelemetryStore({ path: ":memory:", maxExpiredRowsPerPass: 0 }))
      .toThrow(RangeError);
  });

  test("rejects a duplicate kind registration", () => {
    const store = new TelemetryStore({ path: ":memory:", now: () => NOW });
    registerTable(store, "spans-test", "spans");
    expect(() => registerTable(store, "spans-test", "spans")).toThrow(TypeError);
    store.close();
  });
});
