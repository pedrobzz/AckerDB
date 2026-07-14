import { describe, expect, test } from "bun:test";
import {
  captureTelemetryLink,
  deriveTelemetryTraceContext,
  prepareTelemetryTraceContext,
  RECORD_PREPARED_SPAN,
  Telemetry,
  type PreparedTelemetryTraceContext,
  type TelemetryExporter,
  type TelemetryRecord,
  type TelemetryScheduler,
  type TelemetrySpanInput,
} from "../src/telemetry.ts";

class ManualScheduler implements TelemetryScheduler {
  private nextId = 0;
  readonly intervals = new Map<number, () => void>();
  readonly timeouts = new Map<number, { readonly callback: () => void; readonly delayMs: number }>();

  setInterval(callback: () => void): number {
    const id = ++this.nextId;
    this.intervals.set(id, callback);
    return id;
  }

  clearInterval(handle: unknown): void {
    this.intervals.delete(handle as number);
  }

  setTimeout(callback: () => void, delayMs: number): number {
    const id = ++this.nextId;
    this.timeouts.set(id, { callback, delayMs });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timeouts.delete(handle as number);
  }

  fireNextTimeout(delayMs?: number): void {
    const next = [...this.timeouts].find(([, timeout]) =>
      delayMs === undefined ? true : timeout.delayMs === delayMs,
    );
    if (!next) throw new Error(`No pending ${delayMs ?? ""}ms timeout`);
    this.timeouts.delete(next[0]);
    next[1].callback();
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

  override setTimeout(callback: () => void, delayMs: number): number {
    if (this.throwOnSetTimeout) throw new Error("setTimeout failed");
    return super.setTimeout(callback, delayMs);
  }

  override clearTimeout(handle: unknown): void {
    super.clearTimeout(handle);
    if (this.throwOnClearTimeout) throw new Error("clearTimeout failed");
  }
}

async function settleAsyncWork(): Promise<void> {
  for (let turn = 0; turn < 6; turn++) await Promise.resolve();
}

async function deliverNextLocalLine(scheduler: ManualScheduler): Promise<void> {
  scheduler.fireNextTimeout(0);
  await settleAsyncWork();
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
    expect(telemetry.beginTrace({ traceId: "disabled" })).toBe(false);
    expect(telemetry.finishTrace({ traceId: "disabled" })).toBe(false);
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
      traceRetention: {
        maxTraces: 0,
        maxStagedRecords: 0,
        maxStagedBytes: 0,
        decisionRetentionMs: 0,
        activeTraces: 0,
        completedDecisions: 0,
        stagedRecords: 0,
        stagedBytes: 0,
        promotedTraces: 0,
        discardedTraces: 0,
        discardedRecords: 0,
        dropped: {
          activeOverflow: 0,
          stagedOverflow: 0,
          decisionOverflow: 0,
          expiredDecisions: 0,
          drain: 0,
          invalid: 0,
        },
      },
      localSink: {
        configured: false,
        inFlight: false,
        pendingRecords: 0,
        pendingBytes: 0,
        oldestAgeMs: 0,
        deliveredRecords: 0,
        failures: 0,
        timeouts: 0,
        dropped: { overflow: 0, expired: 0, failure: 0, drain: 0 },
      },
      dropped: {
        overflow: 0,
        expired: 0,
        oversized: 0,
        invalid: 0,
        exporter: 0,
        cardinality: 0,
        drain: 0,
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
    expect(telemetry.aggregateSnapshot()).toBe(telemetry.aggregateSnapshot());
    expect(telemetry.aggregateSnapshot()).toEqual({
      maxSeries: 0,
      overflowedRecords: 0,
      series: [],
    });
    await expect(telemetry.drain(0)).resolves.toBeUndefined();
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
      localSink: (line) => {
        localLines.push(line);
      },
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
      statement: "todos.collect",
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

    expect(localLines).toHaveLength(0);
    expect(telemetry.snapshot()).toMatchObject({
      queuedRecords: 3,
      metricSeries: 1,
      localSink: { pendingRecords: 2 },
    });
    await deliverNextLocalLine(scheduler);
    await deliverNextLocalLine(scheduler);
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
      expect(span.statement).toBe("todos.collect");
    }
    const exported = JSON.stringify(batches);
    expect(exported).not.toContain(canary);
    expect(exported).not.toContain("literalSql");
    expect(exported).not.toContain("principalId");
    expect(localLines.join("\n")).not.toContain(canary);
    expect(localLines).toHaveLength(2);
  });

  test("keeps prepared and public span retention byte-for-byte equivalent", async () => {
    const publicExport = exporterBatches();
    const preparedExport = exporterBatches();
    const options = {
      localSink: false as const,
      now: () => 10,
      limits: { slowOperationMs: 100, batchIntervalMs: 60_000 },
    };
    const publicTelemetry = new Telemetry({ ...options, exporter: publicExport.exporter });
    const preparedTelemetry = new Telemetry({ ...options, exporter: preparedExport.exporter });
    const unsafeLabel = "private label must not survive";
    const root = {
      traceId: "trace_prepared_parity",
      spanId: "span_prepared_root",
      requestId: "unsafe request identifier",
      connectionId: "connection_prepared_parity",
    };
    const child = {
      ...root,
      spanId: "span_prepared_child",
      parentSpanId: root.spanId,
    };
    const preparedRoot = prepareTelemetryTraceContext(root);
    const preparedChild = prepareTelemetryTraceContext(child);

    expect(publicTelemetry.beginTrace(root, 0)).toBe(true);
    expect(preparedTelemetry.beginTrace(preparedRoot, 0)).toBe(true);
    const fastSpan = {
      timestampMs: 1,
      operation: "query" as const,
      stage: "admission" as const,
      outcome: "ok" as const,
      functionName: unsafeLabel,
      statement: unsafeLabel,
      resource: "operation" as const,
      durationMs: 5,
      sizeBytes: 42,
    };
    const failedSpan = {
      timestampMs: 2,
      operation: "query" as const,
      stage: "handler" as const,
      outcome: "internal" as const,
      functionName: unsafeLabel,
      statement: unsafeLabel,
      resource: "operation" as const,
      durationMs: 7,
      resultCount: 1,
    };
    expect(publicTelemetry.recordSpan({ ...fastSpan, context: root })).toBe(true);
    expect(preparedTelemetry[RECORD_PREPARED_SPAN]({
      ...fastSpan,
      context: preparedRoot,
    })).toBe(true);
    expect(publicTelemetry.recordSpan({ ...failedSpan, context: child })).toBe(true);
    expect(preparedTelemetry[RECORD_PREPARED_SPAN]({
      ...failedSpan,
      context: preparedChild,
    })).toBe(true);
    expect(publicTelemetry.finishTrace(root, 3)).toBe(true);
    expect(preparedTelemetry.finishTrace(preparedRoot, 3)).toBe(true);

    await publicTelemetry.flush();
    await preparedTelemetry.flush();
    publicTelemetry.stop();
    preparedTelemetry.stop();

    expect(preparedTelemetry.aggregateSnapshot()).toEqual(publicTelemetry.aggregateSnapshot());
    expect(preparedTelemetry.snapshot()).toEqual(publicTelemetry.snapshot());
    const publicJson = JSON.stringify(publicExport.batches);
    expect(JSON.stringify(preparedExport.batches)).toBe(publicJson);
    expect(publicJson).not.toContain(unsafeLabel);
    expect(publicJson).not.toContain("unsafe request identifier");
  });

  test("rejects forged prepared contexts and sanitizes derived identifiers once", () => {
    const telemetry = new Telemetry({ localSink: false, now: () => 0 });
    expect(() => prepareTelemetryTraceContext({ traceId: "unsafe trace", spanId: "span" }))
      .toThrow("safe traceId and spanId");
    const parent = prepareTelemetryTraceContext({
      traceId: "trace_prepared_authentic",
      spanId: "span_prepared_authentic",
      connectionId: "connection_prepared_authentic",
    });
    const child = deriveTelemetryTraceContext(parent, {
      requestId: "request_prepared_authentic",
      connectionId: "unsafe derived connection",
    });
    expect(Object.isFrozen(parent)).toBe(true);
    expect(Object.isFrozen(child)).toBe(true);
    expect(child).toMatchObject({
      traceId: parent.traceId,
      parentSpanId: parent.spanId,
      requestId: "request_prepared_authentic",
    });
    expect(child.connectionId).toBeUndefined();

    const forged = Object.freeze({ ...parent }) as PreparedTelemetryTraceContext;
    expect(() => deriveTelemetryTraceContext(forged)).toThrow("authentic prepared parent");
    expect(telemetry[RECORD_PREPARED_SPAN]({
      context: forged,
      operation: "query",
      stage: "handler",
      outcome: "ok",
      durationMs: 1,
    })).toBe(false);
    expect(telemetry.snapshot().dropped.invalid).toBe(1);
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
      localSink: (line) => {
        localLines.push(line);
      },
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
    expect([...scheduler.timeouts.values()].filter(({ delayMs }) => delayMs === 5)).toHaveLength(1);
    scheduler.fireNextTimeout(5);
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
    await deliverNextLocalLine(scheduler);
    await deliverNextLocalLine(scheduler);
    expect(localLines.some((line) => line.includes('"name":"exporter_degraded"'))).toBe(true);
    expect(scheduler.timeouts.size).toBe(0);
    telemetry.stop();
  });

  test("defers local output, bounds its queue, and contains sink stalls and throws", async () => {
    const scheduler = new ManualScheduler();
    const delivered: string[] = [];
    let calls = 0;
    const telemetry = new Telemetry({
      scheduler,
      now: () => 0,
      localSink: (line) => {
        calls++;
        if (calls === 1) return new Promise<void>(() => {});
        if (calls === 2) throw new Error("local sink failed");
        delivered.push(line);
      },
      limits: {
        maxRecords: 2,
        maxBatchRecords: 2,
        maxBytes: 64 * 1024,
        exportTimeoutMs: 5,
      },
    });

    telemetry.recordEvent({ name: "lifecycle", level: "info", lifecycleState: "starting" });
    expect(calls).toBe(0);
    expect(telemetry.snapshot()).toMatchObject({ localSink: { pendingRecords: 1 } });
    await deliverNextLocalLine(scheduler);
    expect(calls).toBe(1);
    expect(telemetry.snapshot()).toMatchObject({ localSink: { inFlight: true } });

    for (const lifecycleState of ["ready", "draining", "stopped"] as const) {
      telemetry.recordEvent({ name: "lifecycle", level: "info", lifecycleState });
    }
    expect(telemetry.snapshot()).toMatchObject({
      localSink: { pendingRecords: 2, dropped: { overflow: 1 } },
    });

    scheduler.fireNextTimeout(5);
    await settleAsyncWork();
    await deliverNextLocalLine(scheduler);
    await deliverNextLocalLine(scheduler);

    expect(calls).toBe(3);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain('"lifecycleState":"stopped"');
    expect(telemetry.snapshot()).toMatchObject({
      localSink: {
        inFlight: false,
        pendingRecords: 0,
        deliveredRecords: 1,
        failures: 2,
        timeouts: 1,
        dropped: { overflow: 1, failure: 2 },
      },
    });
    telemetry.stop();
  });

  test("exposes bounded privacy-safe operation aggregates without an exporter", () => {
    const telemetry = new Telemetry({
      localSink: false,
      now: () => 0,
      limits: { maxMetricSeries: 3, maxRecords: 10, maxBatchRecords: 10 },
    });
    const canary = "SECRET_request_42";
    const record = (input: TelemetrySpanInput): void => {
      telemetry.recordSpan(input);
    };

    record({
      context: { traceId: canary, spanId: "span_1", requestId: canary },
      operation: "query",
      stage: "handler",
      outcome: "ok",
      functionName: "todos.list",
      resource: "reader",
      durationMs: 4,
      sizeBytes: 10,
      rowCount: 1,
      resultCount: 1,
      args: { token: canary },
    } as TelemetrySpanInput & Record<string, unknown>);
    record({
      operation: "query",
      stage: "handler",
      outcome: "ok",
      functionName: "todos.list",
      resource: "reader",
      durationMs: 6,
      sizeBytes: 20,
      rowCount: 2,
      resultCount: 2,
    });
    record({
      operation: "mutation",
      stage: "commit",
      outcome: "ok",
      functionName: "todos.create",
      resource: "writer",
      durationMs: 8,
      dependencyCount: 3,
    });
    record({
      operation: "procedure",
      stage: "handler",
      outcome: "internal",
      functionName: "todos.import",
      durationMs: 12,
    });
    record({
      operation: "subscription",
      stage: "evaluation",
      outcome: "ok",
      functionName: "todos.watch",
      durationMs: 2,
    });

    const snapshot = telemetry.aggregateSnapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot).toMatchObject({ maxSeries: 3, overflowedRecords: 2 });
    expect(snapshot.series).toHaveLength(3);
    expect(snapshot.series.every(Object.isFrozen)).toBe(true);
    expect(snapshot.series).toContainEqual({
      operation: "query",
      stage: "handler",
      outcome: "ok",
      function: "todos.list",
      resource: "reader",
      overflow: undefined,
      count: 2,
      durationMs: 10,
      sizeBytes: 30,
      rowCount: 3,
      resultCount: 3,
      dependencyCount: undefined,
    });
    expect(snapshot.series).toContainEqual({
      operation: undefined,
      stage: undefined,
      outcome: undefined,
      function: undefined,
      resource: undefined,
      overflow: true,
      count: 2,
      durationMs: 14,
      sizeBytes: undefined,
      rowCount: undefined,
      resultCount: undefined,
      dependencyCount: undefined,
    });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(canary);
    expect(serialized).not.toContain("traceId");
    expect(serialized).not.toContain("requestId");
    expect(serialized).not.toContain("args");
  });

  test("separates function leaves and every fixed aggregate label", () => {
    const telemetry = new Telemetry({ localSink: false, now: () => 0 });
    for (const [operation, stage, outcome, functionName, resource, durationMs] of [
      ["query", "handler", "ok", "todos.one", "reader", 1],
      ["query", "handler", "ok", "todos.two", "reader", 2],
      ["mutation", "handler", "ok", "todos.one", "reader", 4],
      ["query", "commit", "ok", "todos.one", "reader", 8],
      ["query", "handler", "internal", "todos.one", "reader", 16],
      ["query", "handler", "ok", "todos.one", "writer", 32],
      ["query", "handler", "ok", "todos.one", "reader", 64],
    ] as const) {
      expect(telemetry.recordSpan({
        operation,
        stage,
        outcome,
        functionName,
        resource,
        durationMs,
      })).toBe(true);
    }

    expect(telemetry.aggregateSnapshot().series.map((series) => [
      series.operation,
      series.stage,
      series.outcome,
      series.function,
      series.resource,
      series.count,
      series.durationMs,
    ])).toEqual([
      ["query", "handler", "ok", "todos.one", "reader", 2, 65],
      ["query", "handler", "ok", "todos.two", "reader", 1, 2],
      ["mutation", "handler", "ok", "todos.one", "reader", 1, 4],
      ["query", "commit", "ok", "todos.one", "reader", 1, 8],
      ["query", "handler", "internal", "todos.one", "reader", 1, 16],
      ["query", "handler", "ok", "todos.one", "writer", 1, 32],
    ]);
  });

  test("shares the aggregate series limit across function leaves and fixed label codes", () => {
    const telemetry = new Telemetry({
      localSink: false,
      now: () => 0,
      limits: { maxMetricSeries: 3 },
    });
    for (const [operation, stage, functionName, durationMs] of [
      ["query", "handler", "todos.one", 1],
      ["query", "handler", "todos.two", 2],
      ["query", "handler", "todos.three", 4],
      ["mutation", "commit", "todos.one", 8],
      ["query", "handler", "todos.one", 16],
    ] as const) {
      expect(telemetry.recordSpan({
        operation,
        stage,
        outcome: "ok",
        functionName,
        durationMs,
      })).toBe(true);
    }

    expect(telemetry.aggregateSnapshot()).toEqual({
      maxSeries: 3,
      overflowedRecords: 2,
      series: [
        {
          operation: "query",
          stage: "handler",
          outcome: "ok",
          function: "todos.one",
          resource: undefined,
          overflow: undefined,
          count: 2,
          durationMs: 17,
          sizeBytes: undefined,
          rowCount: undefined,
          resultCount: undefined,
          dependencyCount: undefined,
        },
        {
          operation: "query",
          stage: "handler",
          outcome: "ok",
          function: "todos.two",
          resource: undefined,
          overflow: undefined,
          count: 1,
          durationMs: 2,
          sizeBytes: undefined,
          rowCount: undefined,
          resultCount: undefined,
          dependencyCount: undefined,
        },
        {
          operation: undefined,
          stage: undefined,
          outcome: undefined,
          function: undefined,
          resource: undefined,
          overflow: true,
          count: 2,
          durationMs: 12,
          sizeBytes: undefined,
          rowCount: undefined,
          resultCount: undefined,
          dependencyCount: undefined,
        },
      ],
    });
  });

  test("drains every captured exporter batch before one absolute deadline", async () => {
    const scheduler = new ManualScheduler();
    const { batches, exporter } = exporterBatches();
    const telemetry = new Telemetry({
      exporter,
      scheduler,
      localSink: false,
      now: () => 0,
      limits: { maxRecords: 5, maxBatchRecords: 2, maxBytes: 64 * 1024 },
    });
    for (let index = 0; index < 5; index++) {
      telemetry.recordMetric({ name: `runtime.drain_${index}`, value: index, unit: "gauge" });
    }

    await expect(telemetry.drain(100)).resolves.toBeUndefined();

    expect(batches.map((batch) => batch.length)).toEqual([2, 2, 1]);
    expect(scheduler.intervals.size).toBe(0);
    expect(scheduler.timeouts.size).toBe(0);
    expect(telemetry.snapshot()).toMatchObject({
      queuedRecords: 0,
      dropped: { drain: 0 },
      exporter: { attempts: 3, failures: 0, exportedRecords: 5, failedRecords: 0 },
    });
  });

  test("ends drain at the absolute deadline and explicitly drops every remainder", async () => {
    const scheduler = new ManualScheduler();
    let now = 0;
    let calls = 0;
    const telemetry = new Telemetry({
      exporter: {
        export: () => {
          calls++;
          return new Promise<void>(() => {});
        },
      },
      scheduler,
      localSink: false,
      now: () => now,
      limits: {
        maxRecords: 5,
        maxBatchRecords: 2,
        maxBytes: 64 * 1024,
        exportTimeoutMs: 100,
      },
    });
    for (let index = 0; index < 5; index++) {
      telemetry.recordMetric({ name: `runtime.deadline_${index}`, value: index, unit: "gauge" });
    }

    const draining = telemetry.drain(10);
    expect(calls).toBe(1);
    expect([...scheduler.timeouts.values()].map(({ delayMs }) => delayMs).sort()).toEqual([10, 100]);
    now = 10;
    scheduler.fireNextTimeout(10);
    await expect(draining).resolves.toBeUndefined();

    expect(calls).toBe(1);
    expect(scheduler.timeouts.size).toBe(0);
    expect(telemetry.snapshot()).toMatchObject({
      queuedRecords: 0,
      dropped: { exporter: 0, drain: 5 },
      exporter: { attempts: 1, failures: 1, timeouts: 1, failedRecords: 2 },
    });
  });

  test("does not multiply an exporter that times out before the drain deadline", async () => {
    const scheduler = new ManualScheduler();
    let calls = 0;
    const telemetry = new Telemetry({
      exporter: {
        export: () => {
          calls++;
          return new Promise<void>(() => {});
        },
      },
      scheduler,
      localSink: false,
      now: () => 0,
      limits: {
        maxRecords: 5,
        maxBatchRecords: 2,
        maxBytes: 64 * 1024,
        exportTimeoutMs: 5,
      },
    });
    for (let index = 0; index < 5; index++) {
      telemetry.recordMetric({ name: `runtime.stalled_${index}`, value: index, unit: "gauge" });
    }

    const draining = telemetry.drain(100);
    expect(calls).toBe(1);
    scheduler.fireNextTimeout(5);
    await expect(draining).resolves.toBeUndefined();

    expect(calls).toBe(1);
    expect(scheduler.timeouts.size).toBe(0);
    expect(telemetry.snapshot()).toMatchObject({
      queuedRecords: 0,
      dropped: { exporter: 2, drain: 3 },
      exporter: { attempts: 1, failures: 1, timeouts: 1, failedRecords: 2 },
    });
  });

  test("fails a drain closed when absolute-deadline scheduling is unavailable", async () => {
    const scheduler = new FaultingScheduler();
    scheduler.throwOnSetTimeout = true;
    let exporterCalls = 0;
    const telemetry = new Telemetry({
      exporter: { export: () => void exporterCalls++ },
      scheduler,
      localSink: false,
      now: () => 0,
    });
    telemetry.recordEvent({ name: "lifecycle", level: "info", lifecycleState: "ready" });

    await expect(telemetry.drain(10)).resolves.toBeUndefined();

    expect(exporterCalls).toBe(0);
    expect(telemetry.snapshot()).toMatchObject({
      queuedRecords: 0,
      dropped: { exporter: 0, drain: 1 },
      exporter: { attempts: 0, failedRecords: 0 },
    });
  });

  test("retains lifecycle, slow, and failed records but only aggregates fast successes", async () => {
    const scheduler = new ManualScheduler();
    const lines: string[] = [];
    const { batches, exporter } = exporterBatches();
    const telemetry = new Telemetry({
      exporter,
      scheduler,
      localSink: (line) => {
        lines.push(line);
      },
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

    expect(lines).toHaveLength(0);
    expect(telemetry.snapshot()).toMatchObject({
      queuedRecords: 3,
      localSink: { pendingRecords: 3 },
    });
    expect(telemetry.aggregateSnapshot().series.find((series) =>
      series.operation === "query" &&
      series.stage === "handler" &&
      series.outcome === "ok"
    )).toMatchObject({ count: 2, durationMs: 199 });
    await telemetry.flush();
    expect(batches.flat().filter((record) => record.kind === "span").map((record) =>
      record.durationMs
    )).toEqual([100, 1]);
    await deliverNextLocalLine(scheduler);
    await deliverNextLocalLine(scheduler);
    await deliverNextLocalLine(scheduler);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('"durationMs":100');
    expect(lines[1]).toContain('"outcome":"internal"');
    expect(lines[2]).toContain('"name":"lifecycle"');
    expect(telemetry.snapshot()).toMatchObject({
      localSink: { pendingRecords: 0, deliveredRecords: 3, failures: 0 },
    });
    telemetry.stop();
  });

  test("keeps a fast completed trace aggregate-only until its bounded decision expires", async () => {
    const scheduler = new ManualScheduler();
    const { batches, exporter } = exporterBatches();
    let now = 0;
    const telemetry = new Telemetry({
      exporter,
      scheduler,
      localSink: false,
      now: () => now,
      limits: { slowOperationMs: 100, retentionMs: 100 },
    });
    expect(telemetry.beginTrace({ traceId: "trace_fast" })).toBe(true);
    for (const [spanId, durationMs] of [["span_fast_1", 10], ["span_fast_2", 20]] as const) {
      expect(telemetry.recordSpan({
        context: { traceId: "trace_fast", spanId },
        operation: "query",
        stage: "handler",
        outcome: "ok",
        durationMs,
      })).toBe(true);
    }
    now = 40;
    expect(telemetry.finishTrace({ traceId: "trace_fast" })).toBe(true);

    expect(telemetry.snapshot()).toMatchObject({
      queuedRecords: 0,
      traceRetention: {
        activeTraces: 0,
        completedDecisions: 1,
        stagedRecords: 2,
        promotedTraces: 0,
        discardedTraces: 0,
      },
    });
    expect(telemetry.aggregateSnapshot().series).toContainEqual({
      operation: "query",
      stage: "handler",
      outcome: "ok",
      count: 2,
      durationMs: 30,
    });
    await telemetry.flush();
    expect(batches).toEqual([]);

    now = 140;
    expect(telemetry.snapshot()).toMatchObject({
      traceRetention: {
        completedDecisions: 0,
        stagedRecords: 0,
        discardedTraces: 1,
        discardedRecords: 2,
        dropped: { expiredDecisions: 1 },
      },
    });
    telemetry.stop();
  });

  test("accounts staged span bytes exactly without pre-serializing fast traces", async () => {
    const maximalId = (letter: string): string => letter + "a".repeat(127);
    const inputs: TelemetrySpanInput[] = [
      {
        timestampMs: -0,
        context: { traceId: "trace_minimal", spanId: "span_minimal" },
        operation: "query",
        stage: "handler",
        outcome: "ok",
        durationMs: Number.MIN_VALUE,
      },
      {
        timestampMs: Number.MAX_VALUE,
        context: {
          traceId: maximalId("T"),
          spanId: maximalId("S"),
          parentSpanId: maximalId("P"),
          requestId: maximalId("R"),
          connectionId: maximalId("C"),
          mutationId: maximalId("M"),
          commitId: maximalId("K"),
          subscriptionId: maximalId("U"),
        },
        links: Array.from({ length: 33 }, (_, index) => ({
          traceId: maximalId(index % 2 === 0 ? "L" : "N"),
          spanId: maximalId(index % 2 === 0 ? "I" : "J"),
        })),
        operation: "subscription",
        stage: "publication",
        outcome: "ok",
        functionName: maximalId("F"),
        statement: maximalId("Q"),
        resource: "subscription",
        durationMs: Number.MAX_SAFE_INTEGER - 1,
        sizeBytes: Number.MAX_SAFE_INTEGER,
        rowCount: Number.MAX_SAFE_INTEGER,
        resultCount: Number.MAX_SAFE_INTEGER,
        replayed: false,
        dependencyCount: Number.MAX_SAFE_INTEGER,
        postCommit: true,
      },
    ];

    const exactSizes: number[] = [];
    for (const [index, input] of inputs.entries()) {
      const scheduler = new ManualScheduler();
      const { batches, exporter } = exporterBatches();
      const telemetry = new Telemetry({
        exporter,
        scheduler,
        localSink: false,
        now: () => 0,
        limits: { maxBytes: 64 * 1024, slowOperationMs: Number.MAX_SAFE_INTEGER },
      });
      const traceId = input.context!.traceId;
      expect(telemetry.beginTrace({ traceId })).toBe(true);
      expect(telemetry.recordSpan(input)).toBe(true);
      const stagedBytes = telemetry.snapshot().traceRetention.stagedBytes;
      telemetry.recordEvent({
        context: { traceId, spanId: `promote_${index}` },
        name: "failure",
        level: "error",
        operation: input.operation,
        outcome: "internal",
      });
      await telemetry.flush();
      const span = batches.flat().find((record) =>
        record.kind === "span" && record.spanId === input.context!.spanId
      );
      expect(span).toBeDefined();
      const encodedBytes = new TextEncoder().encode(JSON.stringify(span)).byteLength;
      expect(stagedBytes).toBe(encodedBytes);
      exactSizes.push(encodedBytes);
      telemetry.stop();
    }

    const coercible = Object.freeze({
      toString: () => "apparently_safe",
      toJSON: () => "x".repeat(4_096),
    }) as unknown as string;
    const scheduler = new ManualScheduler();
    const { batches, exporter } = exporterBatches();
    const telemetry = new Telemetry({
      exporter,
      scheduler,
      localSink: false,
      now: () => 0,
      limits: { maxBytes: 64 * 1024, slowOperationMs: 100 },
    });
    expect(telemetry.beginTrace({ traceId: coercible })).toBe(false);
    expect(telemetry.beginTrace({ traceId: "trace_coercion" })).toBe(true);
    telemetry.recordSpan({
      context: {
        traceId: "trace_coercion",
        spanId: coercible,
        requestId: coercible,
      },
      links: [{ traceId: coercible, spanId: coercible }],
      operation: "query",
      stage: "handler",
      outcome: "ok",
      functionName: coercible,
      statement: coercible,
      durationMs: 1,
    });
    const coercionBytes = telemetry.snapshot().traceRetention.stagedBytes;
    telemetry.recordEvent({
      context: { traceId: "trace_coercion", spanId: "promote_coercion" },
      name: "failure",
      level: "error",
      operation: "query",
      outcome: "internal",
      errorClass: coercible,
    });
    await telemetry.flush();
    const coercionSpan = batches.flat().find((record) =>
      record.kind === "span" && record.traceId === "trace_coercion"
    );
    if (coercionSpan?.kind !== "span") throw new Error("coercion span was not exported");
    expect(coercionSpan.spanId).toBeUndefined();
    expect(coercionSpan.requestId).toBeUndefined();
    expect(coercionSpan.links).toBeUndefined();
    expect(coercionSpan.function).toBeUndefined();
    expect(coercionSpan.statement).toBeUndefined();
    expect(coercionBytes).toBe(
      new TextEncoder().encode(JSON.stringify(coercionSpan)).byteLength,
    );
    const coercionEvent = batches.flat().find((record) =>
      record.kind === "event" && record.traceId === "trace_coercion"
    );
    if (coercionEvent?.kind !== "event") throw new Error("coercion event was not exported");
    expect(coercionEvent.errorClass).toBeUndefined();
    telemetry.stop();

    const input = inputs[0]!;
    for (const [maxBytes, accepted] of [
      [exactSizes[0]!, true],
      [exactSizes[0]! - 1, false],
    ] as const) {
      const telemetry = new Telemetry({
        localSink: false,
        now: () => 0,
        limits: { maxBytes, slowOperationMs: Number.MAX_SAFE_INTEGER },
      });
      telemetry.beginTrace({ traceId: input.context!.traceId });
      telemetry.recordSpan(input);
      expect(telemetry.snapshot().traceRetention).toMatchObject(accepted
        ? { stagedRecords: 1, stagedBytes: maxBytes, dropped: { stagedOverflow: 0 } }
        : { stagedRecords: 0, stagedBytes: 0, dropped: { stagedOverflow: 1 } });
      telemetry.stop();
    }
  });

  test("promotes complete cumulative and wall-clock slow traces", async () => {
    const scheduler = new ManualScheduler();
    const { batches, exporter } = exporterBatches();
    let now = 0;
    const telemetry = new Telemetry({
      exporter,
      scheduler,
      localSink: false,
      now: () => now,
      limits: { slowOperationMs: 100 },
    });
    expect(telemetry.beginTrace({ traceId: "trace_cumulative" })).toBe(true);
    for (const [spanId, stage, durationMs] of [
      ["span_cumulative_1", "admission", 40],
      ["span_cumulative_2", "handler", 40],
      ["span_cumulative_3", "encoding", 20],
    ] as const) {
      telemetry.recordSpan({
        context: { traceId: "trace_cumulative", spanId },
        operation: "query",
        stage,
        outcome: "ok",
        durationMs,
      });
    }
    expect(telemetry.finishTrace({ traceId: "trace_cumulative" })).toBe(true);

    expect(telemetry.beginTrace({ traceId: "trace_wall" })).toBe(true);
    for (const [spanId, stage] of [
      ["span_wall_1", "admission"],
      ["span_wall_2", "handler"],
    ] as const) {
      telemetry.recordSpan({
        context: { traceId: "trace_wall", spanId },
        operation: "mutation",
        stage,
        outcome: "ok",
        durationMs: 10,
      });
    }
    now = 100;
    expect(telemetry.finishTrace({ traceId: "trace_wall" })).toBe(true);
    expect(telemetry.snapshot()).toMatchObject({
      queuedRecords: 5,
      traceRetention: { stagedRecords: 0, promotedTraces: 2 },
    });

    await telemetry.flush();
    const spans = batches.flat().filter((record) => record.kind === "span");
    expect(spans.filter((span) => span.traceId === "trace_cumulative")).toHaveLength(3);
    expect(spans.filter((span) => span.traceId === "trace_wall")).toHaveLength(2);
    telemetry.stop();
  });

  test("failed spans and events promote every prior fast stage in their trace", async () => {
    const scheduler = new ManualScheduler();
    const { batches, exporter } = exporterBatches();
    const telemetry = new Telemetry({
      exporter,
      scheduler,
      localSink: false,
      now: () => 0,
      limits: { slowOperationMs: 100 },
    });
    expect(telemetry.beginTrace({ traceId: "trace_failed_span" })).toBe(true);
    telemetry.recordSpan({
      context: { traceId: "trace_failed_span", spanId: "span_before_failure" },
      operation: "mutation",
      stage: "handler",
      outcome: "ok",
      durationMs: 10,
    });
    telemetry.recordSpan({
      context: { traceId: "trace_failed_span", spanId: "span_failure" },
      operation: "mutation",
      stage: "commit",
      outcome: "internal",
      durationMs: 1,
    });
    telemetry.finishTrace({ traceId: "trace_failed_span" });

    expect(telemetry.beginTrace({ traceId: "trace_failed_event" })).toBe(true);
    telemetry.recordSpan({
      context: { traceId: "trace_failed_event", spanId: "span_before_event" },
      operation: "procedure",
      stage: "handler",
      outcome: "ok",
      durationMs: 10,
    });
    telemetry.recordEvent({
      context: { traceId: "trace_failed_event", spanId: "event_failure" },
      name: "failure",
      level: "error",
      operation: "procedure",
      outcome: "internal",
    });
    telemetry.finishTrace({ traceId: "trace_failed_event" });

    await telemetry.flush();
    const records = batches.flat().filter((record) => record.kind !== "metric");
    expect(records.map((record) => [record.traceId, record.kind, record.kind === "span"
      ? record.stage
      : record.name])).toEqual([
      ["trace_failed_span", "span", "handler"],
      ["trace_failed_span", "span", "commit"],
      ["trace_failed_event", "span", "handler"],
      ["trace_failed_event", "event", "failure"],
    ]);
    telemetry.stop();
  });

  test("applies a completed decision to delayed delivery and can promote it later", async () => {
    const scheduler = new ManualScheduler();
    const { batches, exporter } = exporterBatches();
    let now = 0;
    const telemetry = new Telemetry({
      exporter,
      scheduler,
      localSink: false,
      now: () => now,
      limits: { slowOperationMs: 100, retentionMs: 1_000 },
    });
    telemetry.beginTrace({ traceId: "trace_delivery" });
    telemetry.recordSpan({
      context: { traceId: "trace_delivery", spanId: "span_admission" },
      operation: "query",
      stage: "admission",
      outcome: "ok",
      durationMs: 10,
    });
    now = 20;
    telemetry.finishTrace({ traceId: "trace_delivery" });
    telemetry.recordSpan({
      context: { traceId: "trace_delivery", spanId: "span_delivery_ok" },
      operation: "query",
      stage: "delivery",
      outcome: "ok",
      durationMs: 1,
    });
    expect(telemetry.snapshot()).toMatchObject({
      queuedRecords: 0,
      traceRetention: { completedDecisions: 1, stagedRecords: 2 },
    });

    telemetry.recordSpan({
      context: { traceId: "trace_delivery", spanId: "span_delivery_failed" },
      operation: "query",
      stage: "delivery",
      outcome: "slow_consumer",
      durationMs: 1,
    });
    telemetry.recordSpan({
      context: { traceId: "trace_delivery", spanId: "span_delivery_after_promotion" },
      operation: "query",
      stage: "delivery",
      outcome: "ok",
      durationMs: 1,
    });
    expect(telemetry.snapshot()).toMatchObject({
      queuedRecords: 4,
      traceRetention: { stagedRecords: 0, promotedTraces: 1 },
    });
    await telemetry.flush();
    expect(batches.flat().filter((record) => record.kind === "span").map((record) =>
      record.spanId
    )).toEqual([
      "span_admission",
      "span_delivery_ok",
      "span_delivery_failed",
      "span_delivery_after_promotion",
    ]);
    telemetry.stop();
  });

  test("bounds trace state and staging, then cleans completed decisions", () => {
    let now = 0;
    const telemetry = new Telemetry({
      localSink: false,
      now: () => now,
      limits: {
        maxRecords: 2,
        maxBatchRecords: 2,
        maxBytes: 64 * 1024,
        retentionMs: 10,
        slowOperationMs: 1_000,
      },
    });
    expect(telemetry.beginTrace({ traceId: "trace_bound_1" })).toBe(true);
    expect(telemetry.beginTrace({ traceId: "trace_bound_2" })).toBe(true);
    expect(telemetry.beginTrace({ traceId: "trace_bound_3" })).toBe(false);
    for (const [traceId, spanId] of [
      ["trace_bound_1", "span_bound_1"],
      ["trace_bound_2", "span_bound_2"],
      ["trace_bound_1", "span_bound_overflow"],
    ] as const) {
      telemetry.recordSpan({
        context: { traceId, spanId },
        operation: "query",
        stage: "handler",
        outcome: "ok",
        durationMs: 1,
      });
    }
    expect(telemetry.snapshot()).toMatchObject({
      traceRetention: {
        maxTraces: 2,
        maxStagedRecords: 2,
        activeTraces: 2,
        stagedRecords: 2,
        dropped: { activeOverflow: 1, stagedOverflow: 1 },
      },
    });

    now = 1;
    telemetry.finishTrace({ traceId: "trace_bound_1" });
    expect(telemetry.beginTrace({ traceId: "trace_bound_3" })).toBe(true);
    telemetry.finishTrace({ traceId: "trace_bound_2" });
    telemetry.finishTrace({ traceId: "trace_bound_3" });
    expect(telemetry.snapshot()).toMatchObject({
      traceRetention: {
        activeTraces: 0,
        completedDecisions: 2,
        stagedRecords: 1,
        discardedTraces: 1,
        discardedRecords: 1,
        dropped: { decisionOverflow: 1 },
      },
    });

    now = 11;
    expect(telemetry.snapshot()).toMatchObject({
      traceRetention: {
        activeTraces: 0,
        completedDecisions: 0,
        stagedRecords: 0,
        stagedBytes: 0,
        discardedTraces: 3,
        discardedRecords: 2,
        dropped: { expiredDecisions: 2 },
      },
    });

    const byBytes = new Telemetry({
      localSink: false,
      now: () => 0,
      limits: { maxRecords: 2, maxBatchRecords: 2, maxBytes: 1 },
    });
    byBytes.beginTrace({ traceId: "trace_bytes" });
    byBytes.recordSpan({
      context: { traceId: "trace_bytes", spanId: "span_bytes" },
      operation: "query",
      stage: "handler",
      outcome: "ok",
      durationMs: 1,
    });
    expect(byBytes.snapshot()).toMatchObject({
      traceRetention: {
        stagedRecords: 0,
        stagedBytes: 0,
        dropped: { stagedOverflow: 1 },
      },
    });
  });

  test("invalid finish clocks discard active staging and release the trace slot", () => {
    for (const failure of ["non_finite", "throw"] as const) {
      let reads = 0;
      const telemetry = new Telemetry({
        localSink: false,
        now: () => {
          reads++;
          if (reads !== 3) return reads - 1;
          if (failure === "throw") throw new Error("clock failed");
          return Number.NaN;
        },
        limits: { maxRecords: 1, maxBatchRecords: 1, slowOperationMs: 100 },
      });
      const traceId = `trace_bad_finish_${failure}`;
      expect(telemetry.beginTrace({ traceId })).toBe(true);
      telemetry.recordSpan({
        context: { traceId, spanId: `span_bad_finish_${failure}` },
        operation: "query",
        stage: "handler",
        outcome: "ok",
        durationMs: 1,
      });
      expect(telemetry.finishTrace({ traceId })).toBe(false);
      expect(telemetry.snapshot()).toMatchObject({
        dropped: { invalid: 1 },
        traceRetention: {
          activeTraces: 0,
          completedDecisions: 0,
          stagedRecords: 0,
          stagedBytes: 0,
          discardedTraces: 1,
          discardedRecords: 1,
          dropped: { invalid: 1 },
        },
      });
      expect(telemetry.beginTrace({ traceId: `trace_after_${failure}` })).toBe(true);
    }
  });

  test("terminal drain discards every active and completed trace decision", async () => {
    const scheduler = new ManualScheduler();
    const telemetry = new Telemetry({
      scheduler,
      localSink: false,
      now: () => 0,
      limits: { slowOperationMs: 100 },
    });
    for (const traceId of ["trace_drain_active", "trace_drain_completed"]) {
      telemetry.beginTrace({ traceId });
      telemetry.recordSpan({
        context: { traceId, spanId: `${traceId}_span` },
        operation: "query",
        stage: "handler",
        outcome: "ok",
        durationMs: 1,
      });
    }
    telemetry.finishTrace({ traceId: "trace_drain_completed" });
    expect(telemetry.snapshot()).toMatchObject({
      traceRetention: { activeTraces: 1, completedDecisions: 1, stagedRecords: 2 },
    });

    await telemetry.drain(10);
    expect(scheduler.timeouts.size).toBe(0);
    expect(telemetry.snapshot()).toMatchObject({
      traceRetention: {
        activeTraces: 0,
        completedDecisions: 0,
        stagedRecords: 0,
        stagedBytes: 0,
        discardedTraces: 2,
        discardedRecords: 2,
        dropped: { drain: 2 },
      },
    });
  });

  test("threshold zero retains immediately without allocating trace state", () => {
    const telemetry = new Telemetry({
      localSink: false,
      now: () => 0,
      limits: { slowOperationMs: 0 },
    });
    expect(telemetry.beginTrace({ traceId: "trace_all" })).toBe(true);
    for (const spanId of ["span_all_1", "span_all_2"]) {
      telemetry.recordSpan({
        context: { traceId: "trace_all", spanId },
        operation: "query",
        stage: "handler",
        outcome: "ok",
        durationMs: 0,
      });
    }
    expect(telemetry.finishTrace({ traceId: "trace_all" })).toBe(true);
    expect(telemetry.snapshot()).toMatchObject({
      queuedRecords: 2,
      traceRetention: {
        activeTraces: 0,
        completedDecisions: 0,
        stagedRecords: 0,
        promotedTraces: 0,
      },
    });
  });
});
