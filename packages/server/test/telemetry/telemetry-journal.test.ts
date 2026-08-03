import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TelemetryJournal,
  type ApplicationLogRecord,
} from "@ackerdb/server";

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

function record(sequence: bigint, message = `log-${sequence}`): ApplicationLogRecord {
  return Object.freeze({
    kind: "log",
    processGeneration: "journal-test-generation",
    sequence,
    timestamp: Number(sequence),
    level: "info",
    message,
    truncated: false,
    malformed: false,
    functionAddress: "tests.log",
    functionKind: "query",
  });
}

describe("TelemetryJournal", () => {
  test("recovers retained records and evicts the oldest first", async () => {
    const path = journalPath();
    const first = new TelemetryJournal({
      path,
      limits: {
        maxStoredRecords: 3,
        maxStoredBytes: 64 * 1_024,
      },
    });
    for (let sequence = 1n; sequence <= 5n; sequence++) {
      expect(first.append(record(sequence))).toBe(true);
    }
    await first.drain();

    const recovered = new TelemetryJournal({
      path,
      limits: {
        maxStoredRecords: 3,
        maxStoredBytes: 64 * 1_024,
      },
    });
    expect(recovered.readBatch(0n, 10).map((entry) => entry.sequence)).toEqual([3n, 4n, 5n]);
    expect(recovered.snapshot()).toMatchObject({
      state: "ready",
      storedRecords: 3,
      evictedRecords: 2,
    });
    await recovered.drain();
  });

  test("drops oversized and saturated records with bounded accounting", async () => {
    const journal = new TelemetryJournal({
      path: journalPath(),
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

  test("contains persistence failures and reports the journal unhealthy", async () => {
    const journal = new TelemetryJournal({ path: journalPath() });
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
    const journal = new TelemetryJournal({
      path: journalPath(),
      limits: { maxBatchRecords: 1 },
    });
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
});
