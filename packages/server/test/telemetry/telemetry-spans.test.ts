import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Telemetry,
  TelemetrySpanStore,
  TelemetryStore,
  type TelemetrySpanRecord,
} from "@ackerdb/server";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const NOW = 1_700_000_000_000;

const directories = new Set<string>();

afterEach(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories.clear();
});

function createStore(retention?: { spans?: number }): TelemetryStore {
  const directory = mkdtempSync(join(tmpdir(), "ackerdb-telemetry-spans-"));
  directories.add(directory);
  return new TelemetryStore({
    path: join(directory, "telemetry.db"),
    now: () => NOW,
    retention,
  });
}

function span(input: Partial<TelemetrySpanRecord> = {}): TelemetrySpanRecord {
  return Object.freeze({
    schemaVersion: 1,
    kind: "span",
    timestampMs: NOW - 1_000,
    traceId: "trace-1",
    spanId: "span-1",
    operation: "mutation",
    stage: "handler",
    outcome: "ok",
    function: "items.create",
    durationMs: 12,
    ...input,
  }) as TelemetrySpanRecord;
}

describe("TelemetrySpanStore", () => {
  test("persists every span durably with promoted columns and payload remainder", async () => {
    const store = createStore();
    const spans = new TelemetrySpanStore({ store });

    expect(spans.append(span({
      statement: "items.insert",
      rowCount: 3,
      requestId: "request-1",
    }))).toBe(true);
    expect(spans.append(span({
      spanId: "span-2",
      parentSpanId: "span-1",
      stage: "statement",
      outcome: "internal",
      durationMs: 4,
    }))).toBe(true);
    await spans.flush();

    const rows = store.database.query(`
      SELECT trace_id AS traceId, span_id AS spanId, parent_span_id AS parentSpanId,
             function_address AS functionAddress, operation, stage, outcome,
             duration_ms AS durationMs, payload
      FROM _ackerdb_telemetry_spans
      ORDER BY id
    `).all() as {
      readonly traceId: string;
      readonly spanId: string;
      readonly parentSpanId: string | null;
      readonly functionAddress: string;
      readonly operation: string;
      readonly stage: string;
      readonly outcome: string;
      readonly durationMs: number;
      readonly payload: string;
    }[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      traceId: "trace-1",
      spanId: "span-1",
      parentSpanId: null,
      functionAddress: "items.create",
      operation: "mutation",
      stage: "handler",
      outcome: "ok",
      durationMs: 12,
    });
    expect(JSON.parse(rows[0]!.payload)).toEqual({
      statement: "items.insert",
      rowCount: 3,
      requestId: "request-1",
    });
    expect(rows[1]).toMatchObject({ stage: "statement", outcome: "internal" });
    expect(spans.snapshot()).toMatchObject({
      state: "ready",
      persistedSpans: 2,
      storedSpans: 2,
      droppedRecords: 0,
    });
    await spans.drain();
    store.close();
  });

  test("write-maintains the trace summary from root and child spans", async () => {
    const store = createStore();
    const spans = new TelemetrySpanStore({ store });

    expect(spans.append(span({
      spanId: "span-2",
      parentSpanId: "span-1",
      stage: "statement",
      outcome: "internal",
      timestampMs: NOW - 3_000,
      durationMs: 5,
    }))).toBe(true);
    expect(spans.append(span({
      timestampMs: NOW - 2_000,
      durationMs: 90,
    }))).toBe(true);
    expect(spans.append(span({
      traceId: "trace-2",
      spanId: "span-9",
      function: "items.list",
      operation: "query",
      timestampMs: NOW - 1_000,
      durationMs: 7,
    }))).toBe(true);
    await spans.flush();

    const traces = store.database.query(`
      SELECT trace_id AS traceId, root_function AS rootFunction, operation,
             started_at AS startedAt, duration_ms AS durationMs,
             span_count AS spanCount, error_count AS errorCount
      FROM _ackerdb_telemetry_traces
      ORDER BY trace_id
    `).all();
    expect(traces).toEqual([
      {
        traceId: "trace-1",
        rootFunction: "items.create",
        operation: "mutation",
        startedAt: NOW - 3_000,
        durationMs: 90,
        spanCount: 2n,
        errorCount: 1n,
      },
      {
        traceId: "trace-2",
        rootFunction: "items.list",
        operation: "query",
        startedAt: NOW - 1_000,
        durationMs: 7,
        spanCount: 1n,
        errorCount: 0n,
      },
    ]);
    await spans.drain();
    store.close();
  });

  test("upserts the hourly rollup from handler-stage spans only", async () => {
    const store = createStore();
    const spans = new TelemetrySpanStore({ store });
    const hour = Math.floor((NOW - 1_000) / HOUR_MS) * HOUR_MS;

    expect(spans.append(span({ durationMs: 10 }))).toBe(true);
    expect(spans.append(span({ spanId: "span-2", durationMs: 30 }))).toBe(true);
    expect(spans.append(span({
      spanId: "span-3",
      stage: "statement",
      durationMs: 500,
    }))).toBe(true);
    expect(spans.append(span({
      spanId: "span-4",
      outcome: "internal",
      durationMs: 20,
    }))).toBe(true);
    await spans.flush();
    expect(spans.append(span({ spanId: "span-5", durationMs: 50 }))).toBe(true);
    await spans.flush();

    const rollups = store.database.query(`
      SELECT hour, operation, function_address AS functionAddress, outcome,
             count, total_ms AS totalMs, min_ms AS minMs, max_ms AS maxMs
      FROM _ackerdb_telemetry_span_rollup
      ORDER BY outcome
    `).all();
    expect(rollups).toEqual([
      {
        hour: BigInt(hour),
        operation: "mutation",
        functionAddress: "items.create",
        outcome: "internal",
        count: 1n,
        totalMs: 20,
        minMs: 20,
        maxMs: 20,
      },
      {
        hour: BigInt(hour),
        operation: "mutation",
        functionAddress: "items.create",
        outcome: "ok",
        count: 3n,
        totalMs: 90,
        minMs: 10,
        maxMs: 50,
      },
    ]);
    await spans.drain();
    store.close();
  });

  test("expires spans and trace summaries on the spans clock, rollups on the rollup clock", async () => {
    const store = createStore();
    const spans = new TelemetrySpanStore({ store });

    expect(spans.append(span({
      traceId: "trace-old",
      timestampMs: NOW - 8 * DAY_MS,
    }))).toBe(true);
    expect(spans.append(span({
      traceId: "trace-new",
      spanId: "span-2",
      timestampMs: NOW - DAY_MS,
    }))).toBe(true);
    await spans.flush();
    // Bounded write-path maintenance visits sets round-robin across passes.
    for (let pass = 0; pass < 4; pass++) store.maintain();

    const spanCount = store.database.query(
      "SELECT COUNT(*) AS rows, MIN(trace_id) AS trace FROM _ackerdb_telemetry_spans",
    ).get() as { readonly rows: bigint; readonly trace: string };
    expect(spanCount).toEqual({ rows: 1n, trace: "trace-new" });
    const traceCount = store.database.query(
      "SELECT COUNT(*) AS rows, MIN(trace_id) AS trace FROM _ackerdb_telemetry_traces",
    ).get() as { readonly rows: bigint; readonly trace: string };
    expect(traceCount).toEqual({ rows: 1n, trace: "trace-new" });
    // Rollups survive raw-span expiry: both hours stay on the 1y clock.
    const rollupCount = store.database.query(
      "SELECT COUNT(*) AS rows FROM _ackerdb_telemetry_span_rollup",
    ).get() as { readonly rows: bigint };
    expect(rollupCount.rows).toBe(2n);
    expect(spans.snapshot().storedSpans).toBe(1);
    await spans.drain();
    store.close();
  });

  test("bounds the queue and evicts oldest stored spans beyond the hard cap", async () => {
    const store = createStore();
    const spans = new TelemetrySpanStore({
      store,
      limits: { maxQueuedRecords: 3, maxStoredRecords: 3 },
    });

    expect(spans.append(span())).toBe(true);
    expect(spans.append(span({ spanId: "span-2" }))).toBe(true);
    expect(spans.append(span({ spanId: "span-3" }))).toBe(true);
    expect(spans.append(span({ spanId: "span-overflow" }))).toBe(false);
    await spans.flush();
    for (let index = 4; index <= 6; index++) {
      expect(spans.append(span({ spanId: `span-${index}` }))).toBe(true);
    }
    await spans.flush();

    expect(spans.snapshot()).toMatchObject({
      storedSpans: 3,
      droppedRecords: 1,
      evictedRecords: 3,
    });
    const rows = store.database.query(
      "SELECT span_id AS spanId FROM _ackerdb_telemetry_spans ORDER BY id",
    ).all();
    expect(rows).toEqual([{ spanId: "span-4" }, { spanId: "span-5" }, { spanId: "span-6" }]);
    await spans.drain();
    store.close();
  });

  test("recovers the stored count and refuses appends after stopping", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ackerdb-telemetry-spans-"));
    directories.add(directory);
    const path = join(directory, "telemetry.db");
    const first = new TelemetryStore({ path, now: () => NOW });
    const firstSpans = new TelemetrySpanStore({ store: first });
    expect(firstSpans.append(span())).toBe(true);
    await firstSpans.drain();
    expect(firstSpans.append(span({ spanId: "span-2" }))).toBe(false);
    first.close();

    const second = new TelemetryStore({ path, now: () => NOW });
    const secondSpans = new TelemetrySpanStore({ store: second });
    expect(secondSpans.snapshot()).toMatchObject({ state: "ready", storedSpans: 1 });
    await secondSpans.drain();
    second.close();
  });

  test("the telemetry durable sink persists spans from every recording path", async () => {
    const store = createStore();
    const spans = new TelemetrySpanStore({ store });
    const telemetry = new Telemetry({
      now: () => NOW,
      localSink: false,
      durableSink: { span: (record) => void spans.append(record) },
    });

    // Sampled-out fast path: an ok span with no retained trace still lands.
    expect(telemetry.recordSpan({
      operation: "query",
      stage: "handler",
      outcome: "ok",
      functionName: "items.list",
      durationMs: 1,
      context: {
        traceId: "0193a0e2-1111-7000-8000-000000000001",
        spanId: "0193a0e2-2222-7000-8000-000000000001",
      },
    })).toBe(true);
    // Retained path: an error span is promoted and also lands durably.
    expect(telemetry.recordSpan({
      operation: "mutation",
      stage: "handler",
      outcome: "internal",
      functionName: "items.fail",
      durationMs: 2,
      context: {
        traceId: "0193a0e2-1111-7000-8000-000000000002",
        spanId: "0193a0e2-2222-7000-8000-000000000002",
      },
    })).toBe(true);
    await spans.flush();

    const rows = store.database.query(`
      SELECT function_address AS functionAddress, outcome
      FROM _ackerdb_telemetry_spans
      ORDER BY id
    `).all();
    expect(rows).toEqual([
      { functionAddress: "items.list", outcome: "ok" },
      { functionAddress: "items.fail", outcome: "internal" },
    ]);
    telemetry.stop();
    await spans.drain();
    store.close();
  });
});
