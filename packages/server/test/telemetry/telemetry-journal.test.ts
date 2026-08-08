import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TelemetryJournal,
  TelemetryStore,
  type ApplicationLogRecord,
  type TelemetryStoreOptions,
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

function storePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "ackerdb-telemetry-journal-"));
  directories.add(directory);
  return join(directory, "data.db.telemetry");
}

function store(options: Omit<TelemetryStoreOptions, "path"> & { path?: string } = {}): TelemetryStore {
  const created = new TelemetryStore({ path: options.path ?? storePath(), ...options });
  stores.add(created);
  return created;
}

/** Fresh by every clock: a suite about queues must not race retention. */
const NOW = Date.now();

function record(sequence: bigint, message = `log-${sequence}`): ApplicationLogRecord {
  return Object.freeze({
    kind: "log",
    processGeneration: "journal-test-generation",
    sequence,
    timestamp: NOW + Number(sequence),
    level: "info",
    source: "app",
    message,
    truncated: false,
    malformed: false,
    functionAddress: "tests.log",
    functionKind: "query",
  });
}

describe("TelemetryJournal", () => {
  test("recovers the records the sidecar still holds", async () => {
    const path = storePath();
    const first = new TelemetryJournal({ store: store({ path }) });
    for (let sequence = 1n; sequence <= 5n; sequence++) {
      expect(first.append(record(sequence))).toBe(true);
    }
    await first.drain();
    for (const created of stores) created.close();
    stores.clear();

    const recovered = new TelemetryJournal({ store: store({ path }) });
    expect(recovered.readBatch(0n, 10).map((entry) => entry.sequence))
      .toEqual([1n, 2n, 3n, 4n, 5n]);
    expect(recovered.snapshot()).toMatchObject({ state: "ready", storedRecords: 5 });
  });

  test("drops oversized and saturated records with bounded accounting", async () => {
    const journal = new TelemetryJournal({
      store: store(),
      limits: {
        maxRecordBytes: 256,
        maxQueuedRecords: 1,
        maxQueuedBytes: 256,
      },
    });

    expect(journal.append(record(1n, "x".repeat(1_024)))).toBe(false);
    expect(journal.append(record(2n))).toBe(true);
    expect(journal.append(record(3n))).toBe(false);
    expect(journal.snapshot()).toMatchObject({
      queuedRecords: 1,
      droppedRecords: 2,
      oversizedRecords: 1,
      saturatedRecords: 1,
    });
    await journal.drain();
  });

  test("a rejected row is an accounted drop, never a stopped journal", async () => {
    const shared = store();
    const journal = new TelemetryJournal({ store: shared });

    expect(journal.append(record(1n))).toBe(true);
    await journal.flush();
    expect(journal.append(record(1n, "duplicate"))).toBe(true);
    await journal.flush();

    expect(journal.snapshot()).toMatchObject({
      state: "ready",
      droppedRecords: 1,
      storedRecords: 1,
    });
    expect(shared.snapshot()).toMatchObject({ state: "ready", containedFailures: 1 });
    expect(journal.readBatch(0n, 10)).toHaveLength(1);
    expect(journal.append(record(2n))).toBe(true);
  });

  test("an unusable shared connection stops the journal and the store together", async () => {
    const shared = store();
    const journal = new TelemetryJournal({ store: shared });
    const observed: unknown[] = [];
    shared.onFailure((error) => observed.push(error));

    shared.database.close(false);
    expect(journal.append(record(1n))).toBe(true);
    await expect(journal.flush()).rejects.toBeDefined();

    expect(journal.snapshot()).toMatchObject({ state: "failed" });
    expect(shared.snapshot()).toMatchObject({ state: "failed" });
    expect(observed).toHaveLength(1);
    expect(journal.append(record(2n))).toBe(false);
  });

  test("counts every in-flight batch lost across concurrent flush failures", async () => {
    const shared = store();
    const journal = new TelemetryJournal({
      store: shared,
      limits: { maxBatchRecords: 1 },
    });
    expect(journal.append(record(1n))).toBe(true);
    await journal.flush();

    expect(journal.append(record(1n, "first duplicate"))).toBe(true);
    expect(journal.append(record(1n, "second duplicate"))).toBe(true);
    const flushes = await Promise.allSettled([journal.flush(), journal.flush()]);
    expect(flushes.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);

    expect(journal.snapshot()).toMatchObject({
      state: "ready",
      droppedRecords: 2,
      storedRecords: 1,
    });
    expect(shared.snapshot()).toMatchObject({ containedFailures: 2 });
  });

  test("expires each level on its own clock, retroactively", async () => {
    const now = 1_000 * 86_400_000;
    const shared = store({
      retention: { debug: 86_400_000, info: 30 * 86_400_000 },
      now: () => now,
    });
    const journal = new TelemetryJournal({ store: shared });
    const aged = (sequence: bigint, level: "debug" | "info", ageDays: number) => Object.freeze({
      ...record(sequence),
      level,
      timestamp: now - ageDays * 86_400_000,
    }) as ApplicationLogRecord;

    expect(journal.append(aged(1n, "debug", 5))).toBe(true);
    expect(journal.append(aged(2n, "info", 5))).toBe(true);
    expect(journal.append(aged(3n, "debug", 0))).toBe(true);
    await journal.flush();
    // The pass runs inside the batch that provoked it, so the five-day-old
    // debug row is already gone when the batch commits.
    expect(journal.readBatch(0n, 10).map((entry) => entry.sequence)).toEqual([2n, 3n]);
    expect(shared.snapshot().expiredRecords.debug).toBe(1);
  });

  test("maintains the analytics day rollup by increment", async () => {
    const shared = store();
    const journal = new TelemetryJournal({ store: shared });
    const day = Math.floor(NOW / 86_400_000) * 86_400_000;
    for (let sequence = 1n; sequence <= 3n; sequence++) {
      expect(journal.append(Object.freeze({
        kind: "analytics",
        processGeneration: "journal-test-generation",
        sequence,
        timestamp: NOW + Number(sequence),
        event: "checkout",
        truncated: false,
        malformed: false,
        functionAddress: "tests.track",
        functionKind: "mutation",
      }))).toBe(true);
    }
    await journal.flush();

    expect(shared.database.query(
      "SELECT day, event, count FROM _ackerdb_telemetry_analytics_rollup",
    ).all()).toEqual([{ day: BigInt(day), event: "checkout", count: 3n }]);
  });
});
