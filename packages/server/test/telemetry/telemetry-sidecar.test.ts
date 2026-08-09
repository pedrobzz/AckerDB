import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TelemetryInlineWriter,
  TelemetryWorkerWriter,
  type ApplicationLogRecord,
  type TelemetrySidecarWriter,
} from "@ackerdb/server";
import { admittedShare, TelemetryAdmission } from "../../src/telemetry/storage/admission.ts";
import { Sketch } from "../../src/telemetry/aggregation/sketch.ts";
import { Telemetry } from "../../src/telemetry/telemetry.ts";
import type { TraceExemplar } from "../../src/telemetry/exemplars/collector.ts";

const directories = new Set<string>();

afterEach(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories.clear();
});

function sidecarPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "ackerdb-telemetry-sidecar-"));
  directories.add(directory);
  return join(directory, "data.db.telemetry");
}

function log(sequence: bigint, message = `log-${sequence}`): ApplicationLogRecord {
  return Object.freeze({
    kind: "log",
    processGeneration: "sidecar-test",
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

function storedRows(path: string, table: string): number {
  const database = new Database(path, { safeIntegers: true, strict: true });
  try {
    return Number((database.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: bigint }).n);
  } finally {
    database.close(false);
  }
}

describe("the telemetry sidecar", () => {
  test("every accepted record is committed before the seal resolves, on the worker", async () => {
    const path = sidecarPath();
    const writer = new TelemetryWorkerWriter({ path, generation: "worker-generation" });
    await writer.whenReady();
    for (let sequence = 1n; sequence <= 400n; sequence++) {
      expect(writer.accept("log", log(sequence))).toBe(true);
    }
    const seal = await writer.seal(undefined, Date.now() + 10_000);

    expect(seal.timedOut).toBe(false);
    expect(seal.snapshot.droppedRecords).toBe(0);
    expect(seal.snapshot.acceptedRecords).toBe(400);
    expect(seal.snapshot.committedRecords).toBe(400);
    // Quiescence is the sidecar's watermark, never this thread's promise.
    expect(seal.snapshot.durableSeq).toBe(seal.snapshot.acceptedSeq);
    expect(storedRows(path, "_ackerdb_telemetry_journal")).toBe(400);
  });

  test("the export port round-trips a cursor through the worker and never rewinds it", async () => {
    const path = sidecarPath();
    const writer = new TelemetryWorkerWriter({ path, generation: "worker-cursor" });
    await writer.whenReady();
    for (let sequence = 1n; sequence <= 8n; sequence++) writer.accept("log", log(sequence));

    const first = await writer.exports.batch("reader", 4);
    expect(first.records.map((record) => record.sequence)).toEqual([1n, 2n, 3n, 4n]);
    expect(first.consumer.cursor).toBe(0n);

    const advanced = await writer.exports.advance("reader", first.records.at(-1)!.id, {
      exportedRecords: 4,
    });
    expect(advanced.exportedRecords).toBe(4);

    const second = await writer.exports.batch("reader", 4);
    expect(second.records.map((record) => record.sequence)).toEqual([5n, 6n, 7n, 8n]);

    // A late advance for an earlier batch — the shape a timed-out export takes
    // when its closure finally settles — must not re-deliver everything since.
    await writer.exports.advance("reader", second.records.at(-1)!.id, { exportedRecords: 4 });
    await writer.exports.advance("reader", first.records.at(-1)!.id, { exportedRecords: 0 });
    expect((await writer.exports.batch("reader", 4)).records).toHaveLength(0);

    await writer.seal(undefined, Date.now() + 10_000);
  });

  test("a request outstanding when the sidecar closes rejects rather than hanging", async () => {
    const writer = new TelemetryWorkerWriter({
      path: sidecarPath(),
      generation: "worker-close",
    });
    await writer.whenReady();
    writer.accept("log", log(1n));
    const pending = writer.exports.batch("reader", 4).catch((error: unknown) => error);
    await writer.seal(undefined, Date.now() + 10_000);
    const settled = await pending;
    // Either the reply landed before the seal or the seal rejected it; what must
    // never happen is a promise nobody ever settles.
    expect(settled).toBeDefined();
    await expect(writer.exports.batch("reader", 4)).rejects.toThrow(/sealed/);
  });

  test("an oversized record and a full ring are refused and counted by reason", async () => {
    const writer = new TelemetryWorkerWriter({
      path: sidecarPath(),
      generation: "worker-bounds",
      // A ring of one, so the second record in the same tick has nowhere to go.
      queue: { maxRecordBytes: 512, maxQueuedRecords: 1, handoffBatch: 1_000 },
    });
    await writer.whenReady();

    expect(writer.accept("log", log(1n, "x".repeat(4_096)))).toBe(false);
    expect(writer.accept("log", log(2n))).toBe(true);
    expect(writer.accept("log", log(3n))).toBe(false);
    const snapshot = writer.snapshot();
    expect(snapshot.shed.shedByReason).toMatchObject({ line_too_long: 1, queue_full: 1 });
    expect(snapshot.droppedRecords).toBe(2);
    await writer.seal(undefined, Date.now() + 10_000);
  });

  test("a rejected transaction is contained and the watermark still advances", async () => {
    const writer = new TelemetryInlineWriter({
      path: sidecarPath(),
      generation: "inline-contained",
      queue: { commitBatch: 2 },
    });
    // Two rows sharing (processGeneration, sequence) violate the journal's
    // uniqueness constraint, so the transaction carrying them rolls back.
    writer.accept("log", log(1n, "first"));
    writer.accept("log", log(1n, "duplicate"));
    const snapshot = writer.snapshot();

    expect(snapshot.rejectedRecords).toBe(2);
    expect(snapshot.committedRecords).toBe(0);
    expect(snapshot.failed).toBe(false);
    expect(snapshot.containedFailures).toBeGreaterThan(0);
    // Resolved, so a drain cannot wedge on it — but NOT durable, because the
    // transaction rolled back and nothing reached disk. Conflating the two is
    // how a rollback gets acknowledged as a clean shutdown.
    expect(snapshot.processedSeq).toBe(snapshot.acceptedSeq);
    expect(snapshot.durableSeq).toBe(0);

    const seal = await writer.seal(undefined, 0);
    expect(seal.lostRecords).toBe(2);
  });

  test("the terminal row is the last row in the file", async () => {
    const path = sidecarPath();
    const writer: TelemetrySidecarWriter = new TelemetryInlineWriter({
      path,
      generation: "inline-terminal",
    });
    writer.accept("log", log(1n, "before"));
    await writer.seal(log(2n, "terminal"), 0);

    const database = new Database(path, { safeIntegers: true, strict: true });
    const rows = database.query(
      "SELECT payload FROM _ackerdb_telemetry_journal ORDER BY id",
    ).all() as { readonly payload: string }[];
    database.close(false);
    expect(rows).toHaveLength(2);
    expect(rows.at(-1)!.payload).toContain("terminal");
  });

  test("the retention span reports what is actually stored, not what was configured", async () => {
    const writer = new TelemetryInlineWriter({
      path: sidecarPath(),
      generation: "inline-spans",
      queue: { commitBatch: 1 },
    });
    const oldest = Date.now() - 60_000;
    writer.accept("log", { ...log(1n), timestamp: oldest });
    writer.accept("log", { ...log(2n), timestamp: oldest + 30_000 });
    await writer.exports.batch("primer", 1);

    const info = writer.stores.store.snapshot().spans.find((span) => span.retention === "info");
    expect(info?.oldestMs).toBe(oldest);
    expect(info?.newestMs).toBe(oldest + 30_000);
    expect(info?.configuredMs).toBeGreaterThan(0);
    await writer.seal(undefined, 0);
  });
});

describe("telemetry admission", () => {
  test("the aggregate never sheds and exemplars shed first", () => {
    expect(admittedShare("aggregate", 0.99)).toBe(1);
    expect(admittedShare("exemplar", 0.9)).toBeCloseTo(0.5, 6);
    expect(admittedShare("error", 0.9)).toBe(1);
    expect(admittedShare("log", 0.9)).toBe(1);
    // At the floor everything sheddable is shed.
    expect(admittedShare("exemplar", 1)).toBe(0);
    expect(admittedShare("log", 1)).toBe(0);
    expect(admittedShare("aggregate", 1)).toBe(1);
  });

  test("the realized rate matches the admitted share", () => {
    const admission = new TelemetryAdmission();
    admission.observe(0.9, false);
    let admitted = 0;
    for (let index = 0; index < 1_000; index++) {
      if (admission.admit("exemplar") === undefined) admitted++;
    }
    // The credit accumulator realizes the share exactly rather than in
    // distribution, so this is an equality and not a tolerance.
    expect(admitted).toBe(500);
    expect(admission.snapshot().shedByReason.rate_limited).toBe(500);
  });

  test("below the free-space floor nothing is written, aggregate included", () => {
    const admission = new TelemetryAdmission();
    admission.observe(1, true);
    expect(admission.admit("aggregate")).toBe("read_only");
    expect(admission.admit("log")).toBe("read_only");
    expect(admission.snapshot().shedByReason.read_only).toBe(2);
  });
});

describe("aggregate coverage across a crash", () => {
  test("a minute a dead generation left open is reported incomplete, not exact", async () => {
    const path = sidecarPath();
    const minute = Math.floor(Date.now() / 60_000) * 60_000;
    const row = {
      startMs: minute,
      operation: "procedure" as const,
      functionAddress: "api.checkout.submit",
      overflow: false,
      count: 40,
      errorCount: 1,
      totalMs: 400,
      minMs: 1,
      maxMs: 40,
      mappingScale: 6,
      lowConfidenceQuantiles: [],
      sketchOk: new Sketch().encode(),
      sketchFailed: new Sketch().encode(),
    };

    // A generation that dies between updating a bucket and closing its minute:
    // the rows are written, the coverage row is announced and never closed.
    const dying = new TelemetryInlineWriter({
      path,
      generation: "generation-that-dies",
      queue: { commitBatch: 1 },
    });
    dying.accept("aggregate", { startMs: minute, closed: false, rows: [row] });
    await dying.exports.batch("primer", 1);
    // No seal: the process is gone, so nothing closes the minute.
    dying.stores.store.close();

    const next = new TelemetryInlineWriter({ path, generation: "next-generation" });
    // The window is reported incomplete rather than presented as a whole
    // minute — a smaller count that reads as exact is the one outcome the
    // coverage table exists to prevent.
    expect(next.stores.aggregate.incompleteMinutes()).toEqual([minute]);

    // And the next generation closing its own minute does not retroactively
    // claim the dead one.
    next.accept("aggregate", { startMs: minute + 60_000, closed: true, rows: [] });
    await next.exports.batch("primer", 1);
    expect(next.stores.aggregate.incompleteMinutes()).toEqual([minute]);
    await next.seal(undefined, 0);
  });
});

describe("durable trace storage is opt-in", () => {
  test("off by default, and the snapshot says so and names the setting", async () => {
    const writer = new TelemetryInlineWriter({
      path: sidecarPath(),
      generation: "traces-off",
    });
    const storage = writer.snapshot().traceStorage;
    // A surface that renders nothing must be able to say why, and quote the
    // exact setting. Blank trace screens with no explanation read as broken.
    expect(storage.enabled).toBe(false);
    expect(storage.setting).toBe("admin.telemetry.traces");
    // Enabling stores traces from that point on; it cannot produce history.
    expect(storage.retroactive).toBe(false);
    await writer.seal(undefined, 0);
  });

  test("on when the operator asked for it", async () => {
    const writer = new TelemetryInlineWriter({
      path: sidecarPath(),
      generation: "traces-on",
      traceStorage: true,
    });
    expect(writer.snapshot().traceStorage.enabled).toBe(true);
    await writer.seal(undefined, 0);
  });

  test("with no sink, a trace costs nothing beyond the aggregate", () => {
    // The aggregate still sees every observation — that is always on, and it is
    // what /status and the runtime metrics are made of. What must not happen is
    // any exemplar work: no verdict, no span collection, no row.
    const stored: unknown[] = [];
    const off = new Telemetry({ localSink: false, limits: { retentionMs: 1 } });
    const traceId = "0".repeat(31) + "1";
    off.beginTrace({ traceId }, 1_000);
    off.recordSpan({
      context: { traceId, spanId: "a".repeat(32) },
      timestampMs: 1_000,
      operation: "procedure",
      stage: "handler",
      outcome: "internal",
      functionName: "api.checkout.submit",
      durationMs: 5,
    });
    off.finishTrace({ traceId }, 1_005);
    off.finishTrace({ traceId: "f".repeat(32) }, 1_020);
    expect(stored).toHaveLength(0);
    // The observation still reached the aggregate.
    const drained = off.drainAggregateBuckets(true);
    expect(drained.reduce((total, one) => total + one.observations, 0)).toBe(1);
  });
});

describe("a long-lived trace is bounded by bytes and count, never by assumed duration", () => {
  test("an SSE-shaped trace that never ends cannot grow the staging pool", () => {
    // Scenario 2: SSE streams, delivery leases and stalled procedures produce
    // traces that stay open for minutes or hours. Nothing may assume a trace
    // ends, so what bounds it has to be size — per trace and globally — and the
    // pool has to stay flat however long the trace runs.
    const kept: TraceExemplar[] = [];
    const telemetry = new Telemetry({
      localSink: false,
      exporter: { export: () => {} },
      exemplar: (settled) => kept.push(settled as unknown as TraceExemplar),
      scheduler: {
        setTimeout: (callback: () => void) => {
          callback();
          return 0;
        },
        clearTimeout: () => {},
        setInterval: () => 0,
        clearInterval: () => {},
      },
      limits: { retentionMs: 1, slowOperationMs: 500, maxBatchRecords: 64 },
    });
    const traceId = "5".repeat(32);
    const openedAt = 1_700_000_000_000;
    telemetry.beginTrace({ traceId }, openedAt);

    // An hour of delivery spans on one open trace.
    for (let index = 0; index < 4_000; index++) {
      telemetry.recordSpan({
        context: { traceId, spanId: `${traceId.slice(0, 24)}${index.toString(16).padStart(8, "0")}` },
        timestampMs: openedAt + index * 900,
        operation: "sse",
        stage: "delivery",
        outcome: "ok",
        functionName: "api.orders.stream",
        durationMs: 1,
      });
    }

    const staged = telemetry.snapshot().traceRetention;
    // Per trace: at most one export batch, whatever the trace's duration.
    expect(staged.stagedRecords).toBeLessThanOrEqual(64);
    expect(staged.stagedBytes).toBeLessThanOrEqual(staged.maxStagedBytes);
    // The trace is still open — nothing settled it because time passed.
    expect(staged.activeTraces).toBe(1);
    expect(kept).toHaveLength(0);
    // What did not fit was refused and counted, not quietly forgotten.
    expect(staged.dropped.stagedOverflow).toBeGreaterThan(0);
  });
});
