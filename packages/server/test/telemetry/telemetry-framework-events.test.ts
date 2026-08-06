import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Telemetry,
  TelemetryJournal,
  TelemetryStore,
  type TelemetryEventRecord,
} from "@ackerdb/server";
import { ApplicationSignals } from "../../src/telemetry/application-signals/application-signals.ts";

const NOW = 1_700_000_000_000;

const directories = new Set<string>();

afterEach(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories.clear();
});

function createJournal(): TelemetryJournal {
  const directory = mkdtempSync(join(tmpdir(), "ackerdb-telemetry-framework-"));
  directories.add(directory);
  const store = new TelemetryStore({
    path: join(directory, "telemetry.db"),
    now: () => NOW,
  });
  return new TelemetryJournal({ store });
}

describe("framework event durability", () => {
  test("recordEvent forwards the sanitized record to the durable sink", () => {
    const events: TelemetryEventRecord[] = [];
    const telemetry = new Telemetry({
      now: () => NOW,
      localSink: false,
      durableSink: { event: (record) => events.push(record) },
    });

    expect(telemetry.recordEvent({
      name: "failure",
      level: "error",
      operation: "mutation",
      outcome: "internal",
      functionName: "items.fail",
      errorClass: "TypeError",
    })).toBe(true);
    expect(telemetry.recordEvent({
      name: "not-an-event" as never,
      level: "error",
    })).toBe(false);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "event",
      name: "failure",
      level: "error",
      operation: "mutation",
      outcome: "internal",
      function: "items.fail",
      errorClass: "TypeError",
    });
    telemetry.stop();
  });

  test("a throwing durable sink never poisons event recording", () => {
    const telemetry = new Telemetry({
      now: () => NOW,
      localSink: false,
      durableSink: {
        event: () => {
          throw new Error("sink failure");
        },
      },
    });
    expect(telemetry.recordEvent({ name: "overload", level: "warn" })).toBe(true);
    telemetry.stop();
  });

  test("framework events land as source-framework journal rows on their level clock", async () => {
    const journal = createJournal();
    const signals = new ApplicationSignals(journal, () => NOW, () => Object.freeze({
      functionAddress: "unknown",
      functionKind: "unknown",
    }));

    signals.framework(Object.freeze({
      schemaVersion: 1,
      kind: "event",
      timestampMs: NOW - 1_000,
      name: "failure",
      level: "error",
      traceId: "trace-9",
      spanId: "span-9",
      requestId: "request-9",
      operation: "mutation",
      stage: "handler",
      outcome: "internal",
      function: "items.fail",
      errorClass: "TypeError",
    } satisfies TelemetryEventRecord));
    await journal.flush();

    const entries = journal.readBatch(0n, 10);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "log",
      level: "error",
      source: "framework",
      message: "failure",
      functionAddress: "items.fail",
      functionKind: "framework",
      traceId: "trace-9",
      spanId: "span-9",
      requestId: "request-9",
      metadata: {
        operation: "mutation",
        stage: "handler",
        outcome: "internal",
        errorClass: "TypeError",
      },
    });
    const row = journal.store.database.query(`
      SELECT kind, level, source, function_address AS functionAddress, trace_id AS traceId
      FROM _ackerdb_telemetry_journal
    `).get();
    expect(row).toEqual({
      kind: "log",
      level: "error",
      source: "framework",
      functionAddress: "items.fail",
      traceId: "trace-9",
    });
    await journal.drain();
    journal.store.close();
  });

  test("expired framework rows leave on the level clock they carry", async () => {
    const journal = createJournal();
    const signals = new ApplicationSignals(journal, () => NOW, () => Object.freeze({
      functionAddress: "unknown",
      functionKind: "unknown",
    }));
    const DAY_MS = 86_400_000;

    signals.framework(Object.freeze({
      schemaVersion: 1,
      kind: "event",
      timestampMs: NOW - 15 * DAY_MS,
      name: "lifecycle",
      level: "info",
      lifecycleState: "ready",
    } satisfies TelemetryEventRecord));
    signals.framework(Object.freeze({
      schemaVersion: 1,
      kind: "event",
      timestampMs: NOW - 15 * DAY_MS,
      name: "failure",
      level: "error",
      outcome: "internal",
    } satisfies TelemetryEventRecord));
    await journal.flush();

    const entries = journal.readBatch(0n, 10);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ message: "failure", level: "error" });
    expect(journal.store.snapshot().expiredRecords.info).toBe(1);
    await journal.drain();
    journal.store.close();
  });
});
