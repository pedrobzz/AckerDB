import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TelemetryJournal,
  TelemetryJournalExporters,
  TelemetryStore,
  type Identity,
  type TelemetryJournalRecord,
  type TelemetrySignalExporter,
  type TelemetryStoreOptions,
} from "@ackerdb/server";

/** Fresh by every clock: a suite about cursors must not race retention. */
const NOW = Date.now();

const directories = new Set<string>();
const stores = new Map<TelemetryJournal, TelemetryStore>();

afterEach(() => {
  for (const store of stores.values()) {
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

function journal(
  limits?: ConstructorParameters<typeof TelemetryJournal>[0]["limits"],
  storeOptions?: Omit<TelemetryStoreOptions, "path">,
): TelemetryJournal {
  const directory = mkdtempSync(join(tmpdir(), "ackerdb-telemetry-exporters-"));
  directories.add(directory);
  const store = new TelemetryStore({
    path: join(directory, "data.db.telemetry"),
    ...storeOptions,
  });
  const created = new TelemetryJournal({ store, ...(limits === undefined ? {} : { limits }) });
  stores.set(created, store);
  return created;
}

function log(sequence: bigint, message: string): TelemetryJournalRecord {
  return Object.freeze({
    kind: "log",
    processGeneration: "export-test",
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

function analytics(
  sequence: bigint,
  event: string,
  identity?: Identity,
): TelemetryJournalRecord {
  return Object.freeze({
    kind: "analytics",
    processGeneration: "export-test",
    sequence,
    timestamp: NOW + Number(sequence),
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
    const storage = journal();
    const identity = 42n as Identity;
    storage.append(log(1n, "first log"));
    storage.append(analytics(2n, "anonymous event"));
    storage.append(analytics(3n, "identified event", identity));
    storage.append(log(4n, "second log"));
    await storage.flush();

    let sentryAvailable = false;
    const sentryBatches: string[][] = [];
    const mixpanelBatches: string[][] = [];
    const warnings: string[] = [];
    const exporters = new TelemetryJournalExporters({
      journal: storage,
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
    await storage.drain();
  });

  test("a stalled provider cannot block another provider or shutdown", async () => {
    const storage = journal();
    storage.append(log(1n, "ready"));
    await storage.flush();
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
      journal: storage,
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
    await storage.drain();
  });

  test("a delayed abort rejection cannot access the journal after shutdown", async () => {
    const storage = journal();
    storage.append(log(1n, "shutdown race"));
    await storage.flush();
    const exporters = new TelemetryJournalExporters({
      journal: storage,
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
    await storage.drain();
    await flushing;
    await Bun.sleep(10);
    expect(storage.snapshot().state).toBe("stopped");
  });

  test("contains background journal read failure without an unhandled rejection", async () => {
    const storage = journal();
    storage.append(log(1n, "corrupt me"));
    await storage.flush();
    const corruption = new Database(storage.store.path);
    corruption.query(
      "UPDATE _ackerdb_telemetry_journal SET payload = ? WHERE id = 1",
    ).run("not a wire value");
    corruption.close();
    const warnings: string[] = [];
    const exporters = new TelemetryJournalExporters({
      journal: storage,
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
    // A payload that cannot be decoded is one record's problem: the shared
    // connection answered its probe, so the journal keeps serving.
    expect(storage.snapshot().state).toBe("ready");
    expect(storage.store.snapshot()).toMatchObject({ state: "ready", containedFailures: 1 });
    expect(warnings).toHaveLength(1);
    await exporters.drain();
    await storage.drain();
  });

  test("advances an offline provider over observable journal eviction", async () => {
    // Two of the four records expire on the info clock before the provider
    // recovers; the consumer must cross that gap as eviction, not as delivery.
    let clock = NOW + 4;
    const storage = journal(undefined, { retention: { info: 2 }, now: () => clock });
    let available = false;
    const delivered: string[] = [];
    const exporters = new TelemetryJournalExporters({
      journal: storage,
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

    storage.append(log(1n, "evicted-1"));
    storage.append(log(2n, "evicted-2"));
    await storage.flush();
    await exporters.flush();
    clock = NOW + 6;
    storage.append(log(5n, "retained-3"));
    storage.append(log(6n, "retained-4"));
    await storage.flush();

    available = true;
    await exporters.flush();
    expect(delivered).toEqual(["retained-3", "retained-4"]);
    expect(exporters.snapshot().recovering).toMatchObject({
      evictedRecords: 2,
      exportedRecords: 2,
    });
    await exporters.drain();
    await storage.drain();
  });
});
