import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TELEMETRY_JOURNAL_DEPENDENCY_KEY,
  TelemetryFlushInvalidation,
  TelemetryJournal,
  TelemetryStore,
  type ApplicationLogRecord,
} from "@ackerdb/server";

const directories = new Set<string>();

afterEach(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories.clear();
});

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function record(sequence: bigint): ApplicationLogRecord {
  return Object.freeze({
    kind: "log",
    processGeneration: "invalidation-test",
    sequence,
    timestamp: Date.now(),
    level: "info",
    source: "app",
    message: `log-${sequence}`,
    truncated: false,
    malformed: false,
    functionAddress: "tests.log",
    functionKind: "query",
  });
}

describe("TelemetryFlushInvalidation", () => {
  test("pokes the synthetic dependency key immediately after a quiet period", () => {
    const invalidation = new TelemetryFlushInvalidation({ intervalMs: 1_000 });
    const pokes: ReadonlySet<string>[] = [];
    invalidation.subscribe((keys) => pokes.push(keys));

    invalidation.notify();
    expect(pokes).toHaveLength(1);
    expect([...pokes[0]!]).toEqual([TELEMETRY_JOURNAL_DEPENDENCY_KEY]);
    invalidation.stop();
  });

  test("coalesces flushes inside the window into one trailing poke", async () => {
    const invalidation = new TelemetryFlushInvalidation({ intervalMs: 25 });
    let pokes = 0;
    invalidation.subscribe(() => pokes++);

    invalidation.notify();
    invalidation.notify();
    invalidation.notify();
    expect(pokes).toBe(1);
    await sleep(60);
    expect(pokes).toBe(2);
    await sleep(60);
    expect(pokes).toBe(2);
    invalidation.stop();
  });

  test("stop cancels the pending trailing poke", async () => {
    const invalidation = new TelemetryFlushInvalidation({ intervalMs: 25 });
    let pokes = 0;
    invalidation.subscribe(() => pokes++);

    invalidation.notify();
    invalidation.notify();
    invalidation.stop();
    await sleep(60);
    expect(pokes).toBe(1);
  });

  test("a throwing subscriber never poisons its peers", () => {
    const invalidation = new TelemetryFlushInvalidation({ intervalMs: 1_000 });
    let observed = 0;
    invalidation.subscribe(() => {
      throw new Error("subscriber failure");
    });
    invalidation.subscribe(() => observed++);

    invalidation.notify();
    expect(observed).toBe(1);
    invalidation.stop();
  });

  test("unsubscribing the last listener drops pending work", async () => {
    const invalidation = new TelemetryFlushInvalidation({ intervalMs: 25 });
    let pokes = 0;
    const unsubscribe = invalidation.subscribe(() => pokes++);

    invalidation.notify();
    invalidation.notify();
    unsubscribe();
    await sleep(60);
    expect(pokes).toBe(1);
  });

  test("rejects an invalid interval", () => {
    expect(() => new TelemetryFlushInvalidation({ intervalMs: 0 })).toThrow(RangeError);
  });

  test("journal persistence drives the poke", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ackerdb-telemetry-invalidation-"));
    directories.add(directory);
    const store = new TelemetryStore({ path: join(directory, "telemetry.db") });
    const journal = new TelemetryJournal({ store });
    const invalidation = new TelemetryFlushInvalidation({ intervalMs: 1_000 });
    journal.onPersist(() => invalidation.notify());
    const pokes: ReadonlySet<string>[] = [];
    invalidation.subscribe((keys) => pokes.push(keys));

    expect(journal.append(record(1n))).toBe(true);
    await journal.flush();
    expect(pokes).toHaveLength(1);
    expect(pokes[0]!.has(TELEMETRY_JOURNAL_DEPENDENCY_KEY)).toBe(true);
    invalidation.stop();
    await journal.drain();
    store.close();
  });
});
