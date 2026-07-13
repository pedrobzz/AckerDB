import { describe, expect, test } from "bun:test";
import {
  captureTelemetryLink,
  Telemetry,
  type TelemetryExporter,
  type TelemetryRecord,
  type TelemetryScheduler,
  type TelemetrySpanInput,
} from "../src/telemetry.ts";

class ManualScheduler implements TelemetryScheduler {
  private nextId = 0;
  readonly intervals = new Map<number, () => void>();
  readonly timeouts = new Map<number, () => void>();

  setInterval(callback: () => void): number {
    const id = ++this.nextId;
    this.intervals.set(id, callback);
    return id;
  }

  clearInterval(handle: unknown): void {
    this.intervals.delete(handle as number);
  }

  setTimeout(callback: () => void): number {
    const id = ++this.nextId;
    this.timeouts.set(id, callback);
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timeouts.delete(handle as number);
  }

  fireNextTimeout(): void {
    const next = this.timeouts.entries().next().value as [number, () => void] | undefined;
    if (!next) throw new Error("No pending timeout");
    this.timeouts.delete(next[0]);
    next[1]();
  }
}

class FaultingScheduler extends ManualScheduler {
  throwOnSetInterval = false;
  throwOnClearInterval = false;
  throwOnSetTimeout = false;
  throwOnClearTimeout = false;

  override setInterval(callback: () => void): number {
    if (this.throwOnSetInterval) throw new Error("setInterval failed");
    return super.setInterval(callback);
  }

  override clearInterval(handle: unknown): void {
    super.clearInterval(handle);
    if (this.throwOnClearInterval) throw new Error("clearInterval failed");
  }

  override setTimeout(callback: () => void): number {
    if (this.throwOnSetTimeout) throw new Error("setTimeout failed");
    return super.setTimeout(callback);
  }

  override clearTimeout(handle: unknown): void {
    super.clearTimeout(handle);
    if (this.throwOnClearTimeout) throw new Error("clearTimeout failed");
  }
}

function exporterBatches(): {
  readonly batches: TelemetryRecord[][];
  readonly exporter: TelemetryExporter;
} {
  const batches: TelemetryRecord[][] = [];
  return {
    batches,
    exporter: {
      export(records) {
        batches.push([...records]);
      },
    },
  };
}

describe("Telemetry", () => {
  test("disabled mode constructs no timer/export path and returns one zero snapshot", async () => {
    let exporterCalls = 0;
    const telemetry = new Telemetry({
      enabled: false,
      exporter: { export: () => void exporterCalls++ },
      localSink: () => {
        throw new Error("disabled telemetry reached its sink");
      },
      scheduler: {
        setInterval: () => {
          throw new Error("disabled telemetry scheduled an interval");
        },
        clearInterval: () => {
          throw new Error("disabled telemetry cleared an interval");
        },
        setTimeout: () => {
          throw new Error("disabled telemetry scheduled a timeout");
        },
        clearTimeout: () => {
          throw new Error("disabled telemetry cleared a timeout");
        },
      },
    });

    expect(
      telemetry.recordSpan({
        operation: "query",
        stage: "handler",
        outcome: "ok",
        durationMs: 1,
      }),
    ).toBe(false);
    expect(
      telemetry.recordEvent({ name: "lifecycle", level: "info", lifecycleState: "ready" }),
    ).toBe(false);
    expect(telemetry.recordMetric({ name: "runtime.cpu", value: 1, unit: "ratio" })).toBe(false);
    await telemetry.flush();
    telemetry.stop();
    expect(exporterCalls).toBe(0);
    expect(telemetry.snapshot()).toBe(telemetry.snapshot());
    expect(telemetry.snapshot()).toEqual({
      enabled: false,
      queuedRecords: 0,
      queuedBytes: 0,
      oldestAgeMs: 0,
      metricSeries: 0,
      localSinkFailures: 0,
      dropped: {
        overflow: 0,
        expired: 0,
        oversized: 0,
        invalid: 0,
        exporter: 0,
        cardinality: 0,
      },
      exporter: {
        configured: false,
        inFlight: false,
        attempts: 0,
        failures: 0,
        timeouts: 0,
        exportedRecords: 0,
        failedRecords: 0,
      },
    });
  });

  test("contains throwing and non-finite clocks across every record path and snapshots", () => {
    let reads = 0;
    const telemetry = new Telemetry({
      localSink: false,
      now: () => {
        reads++;
        if (reads % 2 === 1) throw new Error("clock failed");
        return Number.NaN;
      },
    });

    expect(
      telemetry.recordSpan({
        operation: "query",
        stage: "handler",
        outcome: "ok",
        durationMs: 1,
      }),
    ).toBe(false);
    expect(
      telemetry.recordEvent({ name: "lifecycle", level: "info", lifecycleState: "ready" }),
    ).toBe(false);
    expect(
      telemetry.recordMetric({
        timestampMs: 0,
        name: "runtime.cpu",
        value: 1,
        unit: "ratio",
      }),
    ).toBe(false);
    expect(telemetry.snapshot()).toMatchObject({
      queuedRecords: 0,
      metricSeries: 0,
      dropped: { invalid: 4 },
    });
  });

  test("sanitizes before retention, exports schema-v1 records, and freezes deferred links", async () => {
    const scheduler = new ManualScheduler();
    const { batches, exporter } = exporterBatches();
    const localLines: string[] = [];
    const telemetry = new Telemetry({
      exporter,
      scheduler,
      localSink: (line) => localLines.push(line),
      now: () => 10,
      limits: { maxRecords: 10, maxBatchRecords: 10, maxBytes: 64 * 1024 },
    });
    const link = captureTelemetryLink({ traceId: "trace_origin", spanId: "span_origin" });
    expect(Object.isFrozen(link)).toBe(true);
    expect(() => captureTelemetryLink({ traceId: "unsafe trace", spanId: "span" })).toThrow(
      "safe traceId",
    );
    const canary = "DO_NOT_EXPORT_SECRET_8d6f";

    telemetry.recordSpan({
      context: {
        traceId: "trace_1",
        spanId: "span_1",
        requestId: "request_1",
        connectionId: "connection_1",
      },
      links: [link],
      operation: "query",
      stage: "storage",
      outcome: "ok",
      functionName: "todos.list",
      resource: "reader",
      durationMs: 101,
      sizeBytes: 42,
      rowCount: 3,
      args: { token: canary },
      result: canary,
      literalSql: `select '${canary}'`,
    } as TelemetrySpanInput & Record<string, unknown>);
    telemetry.recordEvent({
      name: "failure",
      level: "error",
      operation: "query",
      outcome: "internal",
      errorClass: "TypeError",
      message: canary,
      headers: { authorization: canary },
    } as never);
    telemetry.recordMetric({
      name: "runtime.operations",
      value: 1,
      unit: "count",
      labels: {
        operation: "query",
        functionName: "todos.list",
        resource: "reader",
        principalId: canary,
      },
    } as never);

    expect(telemetry.snapshot()).toMatchObject({ queuedRecords: 3, metricSeries: 1 });
    await telemetry.flush();
    telemetry.stop();
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(3);
    expect(batches[0]!.every((record) => record.schemaVersion === 1)).toBe(true);
    const span = batches[0]!.find((record) => record.kind === "span");
    expect(span?.kind).toBe("span");
    if (span?.kind === "span") {
      expect(Object.isFrozen(span)).toBe(true);
      expect(Object.isFrozen(span.links)).toBe(true);
      expect(span.links?.[0]).toEqual(link);
    }
    const exported = JSON.stringify(batches);
    expect(exported).not.toContain(canary);
    expect(exported).not.toContain("literalSql");
    expect(exported).not.toContain("principalId");
    expect(localLines.join("\n")).not.toContain(canary);
    expect(localLines).toHaveLength(2);
  });

  test("bounds metric cardinality and folds excess dimensions into one explicit series", async () => {
    const scheduler = new ManualScheduler();
    const { batches, exporter } = exporterBatches();
    const telemetry = new Telemetry({
      exporter,
      scheduler,
      localSink: false,
      now: () => 0,
      limits: {
        maxRecords: 10,
        maxBatchRecords: 10,
        maxMetricSeries: 3,
        maxBytes: 64 * 1024,
      },
    });
    for (const functionName of ["one", "two", "three", "four"]) {
      telemetry.recordMetric({
        name: "runtime.calls",
        value: 1,
        unit: "count",
        labels: { operation: "query", functionName },
      });
    }

    expect(telemetry.snapshot()).toMatchObject({
      queuedRecords: 4,
      metricSeries: 3,
      dropped: { cardinality: 2 },
    });
    await telemetry.flush();
    telemetry.stop();
    const overflow = batches.flat().filter(
      (record) => record.kind === "metric" && record.name === "telemetry.cardinality_overflow",
    );
    expect(overflow).toHaveLength(2);
    expect(overflow[0]).toMatchObject({
      unit: "count",
      labels: { resource: "telemetry", overflow: true },
    });
  });

  test("bounds retained records and bytes, then expires them deterministically", () => {
    let now = 0;
    const byCount = new Telemetry({
      localSink: false,
      now: () => now,
      limits: { maxRecords: 2, maxBatchRecords: 2, maxBytes: 64 * 1024, retentionMs: 50 },
    });
    for (const lifecycleState of ["starting", "ready", "draining"] as const) {
      byCount.recordEvent({ name: "lifecycle", level: "info", lifecycleState });
    }
    expect(byCount.snapshot()).toMatchObject({
      queuedRecords: 2,
      dropped: { overflow: 1 },
    });
    now = 50;
    expect(byCount.snapshot()).toMatchObject({
      queuedRecords: 0,
      queuedBytes: 0,
      dropped: { overflow: 1, expired: 2 },
    });

    now = 0;
    const byBytes = new Telemetry({
      localSink: false,
      now: () => now,
      limits: { maxRecords: 10, maxBatchRecords: 10, maxBytes: 160, retentionMs: 50 },
    });
    for (let index = 0; index < 3; index++) {
      byBytes.recordEvent({ name: "lifecycle", level: "info", lifecycleState: "ready" });
    }
    const bounded = byBytes.snapshot();
    expect(bounded.queuedBytes).toBeLessThanOrEqual(160);
    expect(bounded.queuedRecords).toBeLessThan(3);
    expect(bounded.dropped.overflow).toBeGreaterThan(0);

    const oversized = new Telemetry({
      localSink: false,
      now: () => 0,
      limits: { maxRecords: 2, maxBatchRecords: 2, maxBytes: 1 },
    });
    expect(
      oversized.recordEvent({ name: "lifecycle", level: "info", lifecycleState: "ready" }),
    ).toBe(false);
    expect(oversized.snapshot()).toMatchObject({
      queuedRecords: 0,
      dropped: { oversized: 1 },
    });
  });

  test("exports finite batches and reports local export health", async () => {
    const scheduler = new ManualScheduler();
    const { batches, exporter } = exporterBatches();
    const telemetry = new Telemetry({
      exporter,
      scheduler,
      localSink: false,
      now: () => 0,
      limits: { maxRecords: 5, maxBatchRecords: 2, maxBytes: 64 * 1024 },
    });
    for (let index = 0; index < 3; index++) {
      telemetry.recordMetric({ name: `runtime.sample_${index}`, value: index, unit: "gauge" });
    }

    expect(scheduler.intervals.size).toBe(1);
    await telemetry.flush();
    expect(batches.map((batch) => batch.length)).toEqual([2]);
    expect(telemetry.snapshot()).toMatchObject({ queuedRecords: 1 });
    await telemetry.flush();
    expect(batches.map((batch) => batch.length)).toEqual([2, 1]);
    expect(telemetry.snapshot()).toMatchObject({
      queuedRecords: 0,
      exporter: { attempts: 2, failures: 0, exportedRecords: 3, lastSuccessAtMs: 0 },
    });
    telemetry.stop();
    expect(scheduler.intervals.size).toBe(0);
  });

  test("exports retained records even when the clock later fails", async () => {
    const scheduler = new ManualScheduler();
    const { batches, exporter } = exporterBatches();
    let clockFailed = false;
    const telemetry = new Telemetry({
      exporter,
      scheduler,
      localSink: false,
      now: () => {
        if (clockFailed) throw new Error("clock failed");
        return 10;
      },
    });
    expect(
      telemetry.recordEvent({ name: "lifecycle", level: "info", lifecycleState: "ready" }),
    ).toBe(true);

    clockFailed = true;
    await expect(telemetry.flush()).resolves.toBeUndefined();

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
    expect(telemetry.snapshot()).toMatchObject({
      queuedRecords: 0,
      dropped: { invalid: 3 },
      exporter: {
        inFlight: false,
        attempts: 1,
        failures: 0,
        exportedRecords: 1,
        lastDurationMs: 0,
      },
    });
    telemetry.stop();
  });

  test("contains synchronous throws and rejected exporter promises without unbounded feedback", async () => {
    const scheduler = new ManualScheduler();
    let calls = 0;
    const telemetry = new Telemetry({
      exporter: {
        export() {
          calls++;
          if (calls === 1) throw new Error("synchronous exporter failure");
          return Promise.reject(new Error("asynchronous exporter failure"));
        },
      },
      scheduler,
      localSink: false,
      now: () => 10,
      limits: { maxRecords: 4, maxBatchRecords: 1, maxBytes: 64 * 1024 },
    });
    telemetry.recordEvent({ name: "lifecycle", level: "info", lifecycleState: "ready" });

    await expect(telemetry.flush()).resolves.toBeUndefined();
    await expect(telemetry.flush()).resolves.toBeUndefined();

    expect(calls).toBe(2);
    expect(telemetry.snapshot()).toMatchObject({
      queuedRecords: 1,
      dropped: { exporter: 2 },
      exporter: {
        inFlight: false,
        attempts: 2,
        failures: 2,
        timeouts: 0,
        exportedRecords: 0,
        failedRecords: 2,
        lastFailureAtMs: 10,
      },
    });
    telemetry.stop();
  });

  test("fails a stalled export safely when timeout scheduling throws", async () => {
    const scheduler = new FaultingScheduler();
    scheduler.throwOnSetTimeout = true;
    let rejectExport!: (reason?: unknown) => void;
    const telemetry = new Telemetry({
      exporter: {
        export: () =>
          new Promise<void>((_resolve, reject) => {
            rejectExport = reject;
          }),
      },
      scheduler,
      localSink: false,
      now: () => 25,
      limits: { maxRecords: 4, maxBatchRecords: 1, maxBytes: 64 * 1024 },
    });
    telemetry.recordEvent({ name: "lifecycle", level: "info", lifecycleState: "ready" });

    await expect(telemetry.flush()).resolves.toBeUndefined();
    rejectExport(new Error("late exporter rejection"));
    await Promise.resolve();

    expect(scheduler.timeouts.size).toBe(0);
    expect(telemetry.snapshot()).toMatchObject({
      queuedRecords: 1,
      dropped: { exporter: 1 },
      exporter: {
        inFlight: false,
        attempts: 1,
        failures: 1,
        timeouts: 0,
        failedRecords: 1,
      },
    });
    telemetry.stop();
  });

  test("contains scheduler setup, interval callback, cleanup, and stop failures", async () => {
    const scheduler = new FaultingScheduler();
    scheduler.throwOnClearTimeout = true;
    const { batches, exporter } = exporterBatches();
    const telemetry = new Telemetry({
      exporter,
      scheduler,
      localSink: false,
      now: () => 50,
      limits: { maxRecords: 4, maxBatchRecords: 1, maxBytes: 64 * 1024 },
    });
    telemetry.recordEvent({ name: "lifecycle", level: "info", lifecycleState: "ready" });
    const intervalCallback = scheduler.intervals.values().next().value;
    expect(intervalCallback).toBeFunction();

    expect(() => intervalCallback!()).not.toThrow();
    await expect(telemetry.flush()).resolves.toBeUndefined();
    expect(batches).toHaveLength(1);
    expect(telemetry.snapshot()).toMatchObject({
      queuedRecords: 1,
      exporter: { attempts: 1, failures: 1, exportedRecords: 1, failedRecords: 0 },
    });

    scheduler.throwOnClearInterval = true;
    expect(() => telemetry.stop()).not.toThrow();
    expect(() => telemetry.stop()).not.toThrow();
    expect(() => intervalCallback!()).not.toThrow();
    await Promise.resolve();
    expect(telemetry.snapshot()).toMatchObject({
      queuedRecords: 1,
      exporter: { attempts: 1, failures: 2, exportedRecords: 1 },
    });

    const setupScheduler = new FaultingScheduler();
    setupScheduler.throwOnSetInterval = true;
    let unscheduled: Telemetry | undefined;
    expect(() => {
      unscheduled = new Telemetry({
        exporter,
        scheduler: setupScheduler,
        localSink: false,
        now: () => {
          throw new Error("clock failed while observing scheduler failure");
        },
      });
    }).not.toThrow();
    expect(unscheduled!.snapshot()).toMatchObject({
      dropped: { invalid: 2 },
      exporter: { failures: 1 },
    });
    expect(() => unscheduled!.stop()).not.toThrow();
  });

  test("times out a stalled exporter, drops the failed batch, and remains fail-open", async () => {
    const scheduler = new ManualScheduler();
    const localLines: string[] = [];
    const telemetry = new Telemetry({
      exporter: { export: () => new Promise<void>(() => {}) },
      scheduler,
      localSink: (line) => localLines.push(line),
      now: () => 25,
      limits: {
        maxRecords: 4,
        maxBatchRecords: 2,
        maxBytes: 64 * 1024,
        exportTimeoutMs: 5,
      },
    });
    telemetry.recordEvent({ name: "lifecycle", level: "info", lifecycleState: "ready" });

    const flushing = telemetry.flush();
    expect(scheduler.timeouts.size).toBe(1);
    scheduler.fireNextTimeout();
    await flushing;

    expect(telemetry.snapshot()).toMatchObject({
      queuedRecords: 1,
      dropped: { exporter: 1 },
      exporter: {
        inFlight: false,
        attempts: 1,
        failures: 1,
        timeouts: 1,
        failedRecords: 1,
        lastFailureAtMs: 25,
      },
    });
    expect(localLines.some((line) => line.includes('"name":"exporter_degraded"'))).toBe(true);
    expect(scheduler.timeouts.size).toBe(0);
    telemetry.stop();
  });

  test("local sink receives lifecycle, slow, and failed records but not fast successes", () => {
    const lines: string[] = [];
    const telemetry = new Telemetry({
      localSink: (line) => lines.push(line),
      now: () => 0,
      limits: { slowOperationMs: 100 },
    });
    telemetry.recordSpan({
      operation: "query",
      stage: "handler",
      outcome: "ok",
      durationMs: 99,
    });
    telemetry.recordSpan({
      operation: "query",
      stage: "handler",
      outcome: "ok",
      durationMs: 100,
    });
    telemetry.recordSpan({
      operation: "mutation",
      stage: "commit",
      outcome: "internal",
      durationMs: 1,
    });
    telemetry.recordEvent({ name: "lifecycle", level: "info", lifecycleState: "ready" });

    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('"durationMs":100');
    expect(lines[1]).toContain('"outcome":"internal"');
    expect(lines[2]).toContain('"name":"lifecycle"');
  });
});
