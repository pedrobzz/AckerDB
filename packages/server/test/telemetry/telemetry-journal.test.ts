import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { encode } from "@ackerdb/core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TelemetryJournal,
  TelemetryStore,
  type ApplicationLogLevel,
  type ApplicationLogRecord,
  type TelemetryJournalLimits,
  type TelemetryJournalRecord,
  type TelemetryRetentionTtls,
} from "@ackerdb/server";

const DAY_MS = 86_400_000;
const NOW = 1_700_000_000_000;

const directories = new Set<string>();

afterEach(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories.clear();
});

function journalPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "ackerdb-telemetry-journal-"));
  directories.add(directory);
  return join(directory, "telemetry.db");
}

function createJournal(options: {
  readonly path?: string;
  readonly limits?: Partial<TelemetryJournalLimits>;
  readonly retention?: Partial<TelemetryRetentionTtls>;
  readonly now?: () => number;
} = {}): TelemetryJournal {
  const store = new TelemetryStore({
    path: options.path ?? journalPath(),
    now: options.now ?? (() => 0),
    retention: options.retention,
  });
  return new TelemetryJournal({ store, limits: options.limits });
}

function record(sequence: bigint, message = `log-${sequence}`): ApplicationLogRecord {
  return Object.freeze({
    kind: "log",
    processGeneration: "journal-test-generation",
    sequence,
    timestamp: Number(sequence),
    level: "info",
    source: "app",
    message,
    truncated: false,
    malformed: false,
    functionAddress: "tests.log",
    functionKind: "query",
  });
}

function timestamped(
  sequence: bigint,
  level: ApplicationLogLevel,
  timestamp: number,
): ApplicationLogRecord {
  return Object.freeze({ ...record(sequence, `${level}-${sequence}`), level, timestamp });
}

function analytics(sequence: bigint, timestamp: number): TelemetryJournalRecord {
  return Object.freeze({
    kind: "analytics",
    processGeneration: "journal-test-generation",
    sequence,
    timestamp,
    event: `event-${sequence}`,
    truncated: false,
    malformed: false,
    functionAddress: "tests.track",
    functionKind: "mutation",
  });
}

describe("TelemetryJournal", () => {
  test("recovers retained records and evicts the oldest first", async () => {
    const path = journalPath();
    const limits = { maxStoredRecords: 3, maxStoredBytes: 64 * 1_024 };
    const first = createJournal({ path, limits });
    for (let sequence = 1n; sequence <= 5n; sequence++) {
      expect(first.append(record(sequence))).toBe(true);
    }
    await first.drain();
    first.store.close();

    const recovered = createJournal({ path, limits });
    expect(recovered.readBatch(0n, 10).map((entry) => entry.sequence)).toEqual([3n, 4n, 5n]);
    expect(recovered.snapshot()).toMatchObject({
      state: "ready",
      storedRecords: 3,
      evictedRecords: 2,
    });
    await recovered.drain();
    recovered.store.close();
  });

  test("drops oversized and saturated records with bounded accounting", async () => {
    const journal = createJournal({
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
    journal.store.close();
  });

  test("contains persistence failures and reports the journal unhealthy", async () => {
    const journal = createJournal();
    const observed: unknown[] = [];
    journal.onFailure((error) => observed.push(error));

    expect(journal.append(record(1n))).toBe(true);
    expect(journal.append(record(1n, "duplicate"))).toBe(true);
    await expect(journal.flush()).rejects.toBeDefined();

    expect(journal.snapshot()).toMatchObject({ state: "failed", storedRecords: 0, storedBytes: 0 });
    expect(journal.readBatch(0n, 10)).toEqual([]);
    expect(observed).toHaveLength(1);
    expect(journal.append(record(2n))).toBe(false);
  });

  test("counts every in-flight batch lost across concurrent flush failures", async () => {
    const journal = createJournal({ limits: { maxBatchRecords: 1 } });
    expect(journal.append(record(1n))).toBe(true);
    await journal.flush();

    expect(journal.append(record(1n, "first duplicate"))).toBe(true);
    expect(journal.append(record(1n, "second duplicate"))).toBe(true);
    const flushes = await Promise.allSettled([journal.flush(), journal.flush()]);
    expect(flushes.map((result) => result.status)).toEqual(["rejected", "rejected"]);

    expect(journal.snapshot()).toMatchObject({
      state: "failed",
      droppedRecords: 2,
      storedRecords: 1,
    });
  });

  test("expires stored rows per level and kind on flush with the current clocks", async () => {
    const journal = createJournal({ now: () => NOW });
    expect(journal.append(timestamped(1n, "debug", NOW - 4 * DAY_MS))).toBe(true);
    expect(journal.append(timestamped(2n, "info", NOW - 15 * DAY_MS))).toBe(true);
    expect(journal.append(timestamped(3n, "error", NOW - 15 * DAY_MS))).toBe(true);
    expect(journal.append(analytics(4n, NOW - 15 * DAY_MS))).toBe(true);
    expect(journal.append(timestamped(5n, "debug", NOW - DAY_MS))).toBe(true);
    await journal.flush();

    expect(journal.readBatch(0n, 10).map((entry) => entry.sequence)).toEqual([3n, 4n, 5n]);
    expect(journal.snapshot()).toMatchObject({ storedRecords: 3 });
    expect(journal.store.snapshot().expiredRecords).toMatchObject({
      debug: 1,
      info: 1,
      warn: 0,
      error: 0,
      analytics: 0,
    });
    await journal.drain();
    journal.store.close();
  });

  test("applies a shortened clock to already-stored rows at the next open", async () => {
    const path = journalPath();
    const first = createJournal({ path, now: () => NOW });
    expect(first.append(timestamped(1n, "debug", NOW - 2 * DAY_MS))).toBe(true);
    expect(first.append(timestamped(2n, "error", NOW - 2 * DAY_MS))).toBe(true);
    await first.drain();
    expect(first.snapshot().storedRecords).toBe(2);
    first.store.close();

    const shortened = createJournal({
      path,
      now: () => NOW,
      retention: { debug: DAY_MS },
    });
    expect(shortened.readBatch(0n, 10).map((entry) => entry.sequence)).toEqual([2n]);
    expect(shortened.snapshot()).toMatchObject({ storedRecords: 1 });
    expect(shortened.store.snapshot().expiredRecords.debug).toBe(1);
    await shortened.drain();
    shortened.store.close();
  });

  test("recreates a pre-read-model journal, dropping rows while ids stay monotone", async () => {
    const path = journalPath();
    const legacy = new Database(path, { create: true, safeIntegers: true, strict: true });
    legacy.exec(`
      CREATE TABLE _ackerdb_telemetry_journal (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        process_generation TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        timestamp REAL NOT NULL,
        kind TEXT NOT NULL,
        level TEXT,
        payload_bytes INTEGER NOT NULL,
        payload TEXT NOT NULL,
        UNIQUE(process_generation, sequence)
      )
    `);
    const insert = legacy.query(`
      INSERT INTO _ackerdb_telemetry_journal (
        process_generation, sequence, timestamp, kind, level, payload_bytes, payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const first = encode(timestamped(1n, "info", NOW - DAY_MS));
    const second = encode(timestamped(2n, "info", NOW - DAY_MS));
    insert.run("legacy", 1, NOW - DAY_MS, "log", "info", Buffer.byteLength(first), first);
    insert.run("legacy", 2, NOW - DAY_MS, "log", "info", Buffer.byteLength(second), second);
    // A pre-upgrade exporter that had delivered id 1 but not id 2.
    legacy.exec(`
      CREATE TABLE _ackerdb_telemetry_consumers (
        name TEXT PRIMARY KEY,
        cursor INTEGER NOT NULL,
        exported_records INTEGER NOT NULL,
        skipped_unsupported INTEGER NOT NULL,
        skipped_identity INTEGER NOT NULL,
        evicted_records INTEGER NOT NULL,
        failures INTEGER NOT NULL,
        timed_out INTEGER NOT NULL
      )
    `);
    legacy.query(`
      INSERT INTO _ackerdb_telemetry_consumers VALUES ('exporter', 1, 1, 0, 0, 0, 0, 0)
    `).run();
    legacy.close(false);

    const journal = createJournal({ path, now: () => NOW });
    expect(journal.readBatch(0n, 10)).toEqual([]);
    expect(journal.snapshot()).toMatchObject({ storedRecords: 0, evictedRecords: 2 });
    expect(journal.append(timestamped(3n, "info", NOW - DAY_MS))).toBe(true);
    await journal.flush();
    const entries = journal.readBatch(0n, 10);
    expect(entries.map((entry) => entry.sequence)).toEqual([3n]);
    expect(entries[0]!.id).toBe(3n);

    // The stored cursor observes the upgrade drop as eviction, never id
    // reuse: id 2 (dropped, undelivered) counts; id 1 (delivered) does not.
    const batch = journal.consumerBatch("exporter", 10);
    expect(batch.records.map((entry) => entry.id)).toEqual([3n]);
    expect(batch.consumer.evictedRecords).toBe(1);
    // Advancing over the delivered interval adds nothing on top: the
    // upgrade-drop and cursor-interval mechanisms are one accounting model.
    expect(journal.advanceConsumer("exporter", 3n, { exportedRecords: 1 })).toMatchObject({
      evictedRecords: 1,
      exportedRecords: 2,
    });

    await journal.drain();
    journal.store.close();
  });

  test("persists promoted read-model columns for logs and analytics", async () => {
    const journal = createJournal({ now: () => NOW });
    expect(journal.append(Object.freeze({
      ...timestamped(1n, "info", NOW - DAY_MS),
      source: "framework" as const,
      traceId: "trace-1",
      spanId: "span-1",
      requestId: "request-1",
    }))).toBe(true);
    expect(journal.append(Object.freeze({
      ...analytics(2n, NOW - DAY_MS),
      identity: 7n as never,
      traceId: "trace-2",
    }))).toBe(true);
    await journal.flush();

    const rows = journal.store.database.query(`
      SELECT kind, level, source, function_address AS functionAddress,
             trace_id AS traceId, span_id AS spanId, request_id AS requestId,
             event, identity
      FROM _ackerdb_telemetry_journal
      ORDER BY id
    `).all();
    expect(rows).toEqual([
      {
        kind: "log",
        level: "info",
        source: "framework",
        functionAddress: "tests.log",
        traceId: "trace-1",
        spanId: "span-1",
        requestId: "request-1",
        event: null,
        identity: null,
      },
      {
        kind: "analytics",
        level: null,
        source: null,
        functionAddress: "tests.track",
        traceId: "trace-2",
        spanId: null,
        requestId: null,
        event: "event-2",
        identity: 7n,
      },
    ]);
    await journal.drain();
    journal.store.close();
  });

  test("a deadline-bounded drain drops the queued tail and quiesces", async () => {
    const journal = createJournal();
    for (let sequence = 1n; sequence <= 3n; sequence++) {
      expect(journal.append(record(sequence))).toBe(true);
    }
    // The deadline already passed: cooperative overrun — the unpersisted
    // tail is dropped, the store quiesces, and the loss is the error.
    await expect(journal.drain(performance.now() - 1)).rejects.toMatchObject({
      code: "deadline_exceeded",
    });
    expect(journal.snapshot()).toMatchObject({
      state: "stopped",
      queuedRecords: 0,
      storedRecords: 0,
      droppedRecords: 3,
    });
    // Quiescent: late appends are clean drops, the store is untouched.
    expect(journal.append(record(9n))).toBe(false);
    expect(journal.readBatch(0n, 10)).toEqual([]);
    journal.store.close();
  });

  test("a failed terminal append restores accounting to the durable truth", async () => {
    const journal = createJournal();
    expect(journal.append(record(1n))).toBe(true);
    await journal.drain();
    const before = journal.snapshot();
    // The state table dies between the terminal INSERT and its accounting
    // update: the transaction rolls back, and the snapshot must describe
    // the durable truth, not the row that never landed.
    journal.store.database.exec("DROP TABLE _ackerdb_telemetry_state");
    expect(() => journal.appendFinal(record(2n))).toThrow();
    expect(journal.snapshot()).toMatchObject({
      state: "failed",
      storedRecords: before.storedRecords,
      storedBytes: before.storedBytes,
      droppedRecords: 1,
    });
    const rows = journal.store.database.query(
      "SELECT COUNT(*) AS rows FROM _ackerdb_telemetry_journal",
    ).get();
    expect(rows).toEqual({ rows: 1n });
    journal.store.close();
  });

  test("counts retention holes a consumer crosses as evicted", async () => {
    const journal = createJournal({ now: () => NOW, retention: { debug: DAY_MS } });
    // Interleave rows the per-class clock expires among retained ones, so the
    // holes sit BETWEEN retained ids — not before MIN(id).
    expect(journal.append(timestamped(1n, "info", NOW))).toBe(true);
    expect(journal.append(timestamped(2n, "debug", NOW - 2 * DAY_MS))).toBe(true);
    expect(journal.append(timestamped(3n, "info", NOW))).toBe(true);
    expect(journal.append(timestamped(4n, "debug", NOW - 2 * DAY_MS))).toBe(true);
    expect(journal.append(timestamped(5n, "info", NOW))).toBe(true);
    await journal.flush();
    expect(journal.store.snapshot().expiredRecords.debug).toBe(2);

    const batch = journal.consumerBatch("exporter", 10);
    expect(batch.records.map((entry) => entry.id)).toEqual([1n, 3n, 5n]);
    expect(batch.consumer.evictedRecords).toBe(0);
    // Advancing across ids 2 and 4 without exporting or skipping them is
    // retention loss, and the exporter's accounting must say so.
    const advanced = journal.advanceConsumer("exporter", 5n, { exportedRecords: 3 });
    expect(advanced.evictedRecords).toBe(2);
    expect(advanced.exportedRecords).toBe(3);

    // A trailing hole before the next retained id is crossed the same way.
    expect(journal.append(timestamped(6n, "debug", NOW - 2 * DAY_MS))).toBe(true);
    expect(journal.append(timestamped(7n, "info", NOW))).toBe(true);
    await journal.flush();
    const next = journal.consumerBatch("exporter", 10);
    expect(next.records.map((entry) => entry.id)).toEqual([7n]);
    expect(journal.advanceConsumer("exporter", 7n, { exportedRecords: 1 })).toMatchObject({
      evictedRecords: 3,
      exportedRecords: 4,
    });

    await journal.drain();
    journal.store.close();
  });
});
