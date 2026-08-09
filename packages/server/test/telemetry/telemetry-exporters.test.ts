import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TelemetryInlineWriter,
  TelemetryJournalExporters,
  type Identity,
  type TelemetryJournalRecord,
  type TelemetrySignalExporter,
} from "@ackerdb/server";

const directories = new Set<string>();
const writers = new Set<TelemetryInlineWriter>();

afterEach(async () => {
  for (const writer of writers) await writer.seal(undefined, 0).catch(() => {});
  writers.clear();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories.clear();
});

function sidecar(limits?: { readonly maxStoredBytes?: number }): TelemetryInlineWriter {
  const directory = mkdtempSync(join(tmpdir(), "ackerdb-telemetry-exporters-"));
  directories.add(directory);
  const writer = new TelemetryInlineWriter({
    path: join(directory, "telemetry.db"),
    generation: "export-test-generation",
    // One record per commit, so a test that appends and then reads never has to
    // reason about the ring's batching.
    queue: { commitBatch: 1 },
    ...limits,
  });
  writers.add(writer);
  return writer;
}

function log(sequence: bigint, message: string): TelemetryJournalRecord {
  return Object.freeze({
    kind: "log",
    processGeneration: "export-test",
    sequence,
    timestamp: Date.now(),
    level: "info",
    source: "app",
    message,
    truncated: false,
    malformed: false,
    functionAddress: "tests.log",
    functionKind: "query",
  });
}

function analytics(
  sequence: bigint,
  event: string,
  identity?: Identity,
): TelemetryJournalRecord {
  return Object.freeze({
    kind: "analytics",
    processGeneration: "export-test",
    sequence,
    timestamp: Date.now(),
    event,
    ...(identity === undefined ? {} : { identity }),
    truncated: false,
    malformed: false,
    functionAddress: "tests.track",
    functionKind: "mutation",
    commitId: "7",
  });
}

describe("TelemetryJournalExporters", () => {
  test("routes capabilities and advances failing providers independently in order", async () => {
    const storage = sidecar();
    const identity = 42n as Identity;
    storage.accept("log", log(1n, "first log"));
    storage.accept("analytics", analytics(2n, "anonymous event"));
    storage.accept("analytics", analytics(3n, "identified event", identity));
    storage.accept("log", log(4n, "second log"));

    let sentryAvailable = false;
    const sentryBatches: string[][] = [];
    const mixpanelBatches: string[][] = [];
    const warnings: string[] = [];
    const exporters = new TelemetryJournalExporters({
      port: storage.exports,
      exporters: [
        {
          name: "sentry",
          signals: ["log"],
          export: (records) => {
            if (!sentryAvailable) throw new Error("sentry unavailable");
            sentryBatches.push(records.map((record) => record.kind === "log" ? record.message : "wrong"));
          },
        },
        {
          name: "mixpanel",
          signals: ["analytics"],
          requiresAnalyticsIdentity: true,
          export: (records) => {
            mixpanelBatches.push(records.map((record) =>
              record.kind === "analytics" ? record.event : "wrong"));
          },
        },
      ],
      warn: (message) => warnings.push(message),
      limits: { timeoutMs: 25, retryMinMs: 1, retryMaxMs: 4 },
    });

    await exporters.flush();
    expect(mixpanelBatches).toEqual([["identified event"]]);
    expect(sentryBatches).toEqual([]);
    expect(exporters.snapshot()).toMatchObject({
      sentry: { failures: 1, exportedRecords: 0 },
      mixpanel: {
        failures: 0,
        exportedRecords: 1,
        skippedIdentity: 1,
        skippedUnsupported: 2,
      },
    });
    expect(warnings).toHaveLength(1);

    sentryAvailable = true;
    await Bun.sleep(5);
    await exporters.flush();
    expect(sentryBatches).toEqual([["first log", "second log"]]);
    expect(exporters.snapshot().sentry).toMatchObject({
      failures: 1,
      exportedRecords: 2,
      skippedUnsupported: 2,
    });

    await exporters.drain();
  });

  test("a stalled provider cannot block another provider or shutdown", async () => {
    const storage = sidecar();
    storage.accept("log", log(1n, "ready"));
    let aborted = false;
    const delivered: string[] = [];
    const stalled: TelemetrySignalExporter = {
      name: "stalled",
      signals: ["log"],
      export: (_records, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(signal.reason);
        }, { once: true });
      }),
    };
    const exporters = new TelemetryJournalExporters({
      port: storage.exports,
      exporters: [
        stalled,
        {
          name: "healthy",
          signals: ["log"],
          export: (records) => {
            delivered.push(...records.map((record) => record.kind === "log" ? record.message : "wrong"));
          },
        },
      ],
      warn: () => {},
      limits: { timeoutMs: 5 },
    });

    await exporters.flush();
    expect(delivered).toEqual(["ready"]);
    await Bun.sleep(0);
    expect(aborted).toBe(true);
    expect(exporters.snapshot().stalled).toMatchObject({ timedOut: 1, inFlight: false });
    await exporters.drain();
  });

  test("a delayed abort rejection cannot reach the sidecar after it is sealed", async () => {
    const storage = sidecar();
    storage.accept("log", log(1n, "shutdown race"));
    const exporters = new TelemetryJournalExporters({
      port: storage.exports,
      exporters: [{
        name: "delayed-abort",
        signals: ["log"],
        export: (_records, { signal }) => new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            setTimeout(() => reject(signal.reason), 5);
          }, { once: true });
        }),
      }],
      warn: () => {},
      limits: { timeoutMs: 1_000 },
    });

    const flushing = exporters.flush();
    await Bun.sleep(0);
    await exporters.drain();
    await storage.seal(undefined, 0);
    await flushing;
    await Bun.sleep(10);
    // The seal closed the connection; a late rejection must not have reached it.
    expect(storage.snapshot().failed).toBe(false);
  });

  test("contains a background read failure without an unhandled rejection", async () => {
    const storage = sidecar();
    storage.accept("log", log(1n, "corrupt me"));
    // Commit it, then corrupt the stored payload behind the store's back.
    await storage.exports.batch("primer", 1);
    const corruption = new Database(storage.stores.store.path);
    corruption.query(
      "UPDATE _ackerdb_telemetry_journal SET payload = ? WHERE id = 1",
    ).run("not a wire value");
    corruption.close();
    const warnings: string[] = [];
    const exporters = new TelemetryJournalExporters({
      port: storage.exports,
      exporters: [{
        name: "reader",
        signals: ["log"],
        export: () => {
          throw new Error("corrupt records must not reach a provider");
        },
      }],
      warn: (message) => warnings.push(message),
    });

    await Bun.sleep(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("stopped after local journal failure");
    await exporters.drain();
  });

  test("advances an offline provider over observable journal eviction", async () => {
    const storage = sidecar();
    let available = false;
    const delivered: string[] = [];
    const exporters = new TelemetryJournalExporters({
      port: storage.exports,
      exporters: [{
        name: "recovering",
        signals: ["log"],
        export: (records) => {
          if (!available) throw new Error("offline");
          delivered.push(...records.map((record) => record.kind === "log" ? record.message : "wrong"));
        },
      }],
      warn: () => {},
      limits: { retryMinMs: 10_000, retryMaxMs: 10_000 },
    });

    storage.accept("log", log(1n, "evicted-1"));
    storage.accept("log", log(2n, "evicted-2"));
    await exporters.flush();
    storage.accept("log", log(3n, "retained-3"));
    storage.accept("log", log(4n, "retained-4"));
    await storage.exports.batch("primer", 1);
    // Eviction is indistinguishable from any other reason a row is gone, which
    // is the point: the consumer must account the gap rather than stall on it.
    const evicting = new Database(storage.stores.store.path);
    evicting.query("DELETE FROM _ackerdb_telemetry_journal WHERE id <= 2").run();
    evicting.close();

    available = true;
    await exporters.flush();
    expect(delivered).toEqual(["retained-3", "retained-4"]);
    expect(exporters.snapshot().recovering).toMatchObject({
      evictedRecords: 2,
      exportedRecords: 2,
    });
    await exporters.drain();
  });
});
