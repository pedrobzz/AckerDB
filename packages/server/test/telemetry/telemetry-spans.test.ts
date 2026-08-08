import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TELEMETRY_SCHEMA_VERSION,
  TelemetrySpanStore,
  TelemetryStore,
  type TelemetrySpanRecord,
} from "@ackerdb/server";

const directories = new Set<string>();
const stores = new Set<TelemetryStore>();
const NOW = Date.now();

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

function store(options: { readonly retention?: Record<string, number>; readonly now?: () => number } = {}): TelemetryStore {
  const directory = mkdtempSync(join(tmpdir(), "ackerdb-telemetry-spans-"));
  directories.add(directory);
  const created = new TelemetryStore({ path: join(directory, "data.db.telemetry"), ...options });
  stores.add(created);
  return created;
}

function span(overrides: Partial<TelemetrySpanRecord> = {}): TelemetrySpanRecord {
  return Object.freeze({
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    kind: "span",
    timestampMs: NOW,
    operation: "query",
    stage: "handler",
    outcome: "ok",
    durationMs: 1,
    ...overrides,
  }) as TelemetrySpanRecord;
}

describe("TelemetrySpanStore", () => {
  test("persists every span, sampled by nothing", async () => {
    const shared = store();
    const spans = new TelemetrySpanStore({ store: shared });
    for (let index = 0; index < 40; index++) {
      expect(spans.append(span({ durationMs: index }))).toBe(true);
    }
    await spans.flush();

    expect(spans.snapshot()).toMatchObject({
      state: "ready",
      persistedSpans: 40,
      storedSpans: 40,
      droppedRecords: 0,
    });
    expect(shared.database.query("SELECT COUNT(*) AS n FROM _ackerdb_telemetry_spans").get())
      .toEqual({ n: 40n });
  });

  test("maintains the trace summary and the hourly rollup by increment", async () => {
    const shared = store();
    const spans = new TelemetrySpanStore({ store: shared });
    spans.append(span({ traceId: "trace-a", spanId: "root", durationMs: 12 }));
    spans.append(span({ traceId: "trace-a", spanId: "child", parentSpanId: "root", outcome: "internal", durationMs: 4 }));
    spans.append(span({ traceId: "trace-a", spanId: "other", parentSpanId: "root", durationMs: 2 }));
    await spans.flush();

    expect(shared.database.query(`
      SELECT trace_id AS traceId, span_count AS spans, error_count AS errors, duration_ms AS durationMs
      FROM _ackerdb_telemetry_traces
    `).get()).toEqual({ traceId: "trace-a", spans: 3n, errors: 1n, durationMs: 12 });
    expect(shared.database.query(`
      SELECT outcome, count, total_ms AS totalMs, min_ms AS minMs, max_ms AS maxMs
      FROM _ackerdb_telemetry_span_rollup ORDER BY outcome
    `).all()).toEqual([
      { outcome: "internal", count: 1n, totalMs: 4, minMs: 4, maxMs: 4 },
      { outcome: "ok", count: 2n, totalMs: 14, minMs: 2, maxMs: 12 },
    ]);
  });

  test("drops on a saturated queue rather than growing without bound", () => {
    const spans = new TelemetrySpanStore({
      store: store(),
      limits: { maxQueuedRecords: 2 },
    });
    expect(spans.append(span())).toBe(true);
    expect(spans.append(span())).toBe(true);
    expect(spans.append(span())).toBe(false);
    expect(spans.snapshot()).toMatchObject({ queuedRecords: 2, droppedRecords: 1 });
  });

  test("expires spans and traces on the spans clock, rollups on their own", async () => {
    const now = NOW;
    // The rollup clock has to outlast the bucket it buckets into: an hourly
    // bucket is stamped at the top of its hour, so a clock shorter than an hour
    // would expire the bucket a span just landed in.
    const shared = store({ retention: { spans: 1_000, rollups: 7_200_000 }, now: () => now });
    const spans = new TelemetrySpanStore({ store: shared });
    spans.append(span({ timestampMs: now - 5_000, traceId: "old" }));
    await spans.flush();
    spans.append(span({ timestampMs: now, traceId: "new" }));
    await spans.flush();

    expect(shared.database.query("SELECT COUNT(*) AS n FROM _ackerdb_telemetry_spans").get())
      .toEqual({ n: 1n });
    expect(shared.database.query("SELECT trace_id AS traceId FROM _ackerdb_telemetry_traces").all())
      .toEqual([{ traceId: "new" }]);
    // The rollup outlives the raw spans it was built from.
    expect(shared.database.query(
      "SELECT SUM(count) AS calls FROM _ackerdb_telemetry_span_rollup",
    ).get()).toEqual({ calls: 2n });
  });

  test("drops the unpersisted tail at a cooperative drain deadline", async () => {
    const spans = new TelemetrySpanStore({ store: store() });
    for (let index = 0; index < 8; index++) spans.append(span());
    await expect(spans.drain(performance.now() - 1)).rejects.toThrow(/at the shutdown deadline/);
    expect(spans.snapshot()).toMatchObject({ state: "stopped", queuedRecords: 0, droppedRecords: 8 });
  });

  test("an unusable shared connection stops the span store", async () => {
    const shared = store();
    const spans = new TelemetrySpanStore({ store: shared });
    shared.database.close(false);
    expect(spans.append(span())).toBe(true);
    await expect(spans.flush()).rejects.toBeDefined();
    expect(spans.snapshot()).toMatchObject({ state: "failed" });
    expect(shared.snapshot()).toMatchObject({ state: "failed" });
  });
});
