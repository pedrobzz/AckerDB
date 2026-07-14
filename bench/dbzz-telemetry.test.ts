import { describe, expect, test } from "bun:test";
import {
  PRODUCTION_LIMITS,
  Telemetry,
  type TelemetryOperation,
  type TelemetryStage,
} from "@dbzz/server";
import type { DriverResult } from "./benchmark.ts";
import { expectedDbzzStartupMode } from "./dbzz-profile.ts";
import {
  assertDbzzTelemetryWorkload,
  createDbzzTelemetryReport,
  DbzzOutputCollector,
  parseDbzzTelemetryReport,
  type DbzzTelemetryReport,
  type DbzzTelemetryTerminalReport,
  type LocalTelemetryOutputSnapshot,
} from "./dbzz-telemetry.ts";

interface EnabledFixture {
  readonly terminal: DbzzTelemetryTerminalReport;
  readonly output: LocalTelemetryOutputSnapshot;
  readonly report: DbzzTelemetryReport;
}

async function enabledFixture(): Promise<EnabledFixture> {
  const collector = new DbzzOutputCollector();
  const encoder = new TextEncoder();
  const telemetry = new Telemetry({
    localSink: (line) => collector.writeStdout(encoder.encode(`${line}\n`)),
  });
  const spans: ReadonlyArray<readonly [TelemetryOperation, TelemetryStage]> = [
    ["query", "queue"],
    ["mutation", "queue"],
    ["procedure", "admission"],
    ["subscription", "queue"],
  ];
  for (const [operation, stage] of spans) {
    if (!telemetry.recordSpan({ operation, stage, outcome: "ok", durationMs: 101 })) {
      throw new Error(`fixture failed to retain ${operation}.${stage}`);
    }
  }
  if (!telemetry.recordEvent({
    name: "lifecycle",
    level: "info",
    operation: "lifecycle",
    lifecycleState: "ready",
  })) {
    throw new Error("fixture failed to retain its lifecycle event");
  }
  if (!telemetry.recordMetric({
    name: "runtime.operations",
    value: spans.length,
    unit: "count",
    labels: { resource: "operation" },
  })) {
    throw new Error("fixture failed to retain its runtime metric");
  }

  const startup = expectedDbzzStartupMode("enabled", "balanced");
  const beforeDrain = telemetry.snapshot();
  await telemetry.drain(Date.now() + 1_000);
  collector.finish();
  const terminal = createDbzzTelemetryReport(
    startup,
    beforeDrain,
    telemetry.snapshot(),
    telemetry.aggregateSnapshot(),
  );
  const output = collector.snapshot();
  return {
    terminal,
    output,
    report: parseDbzzTelemetryReport(JSON.stringify(terminal), startup, output),
  };
}

function disabledFixture(): {
  readonly terminal: DbzzTelemetryTerminalReport;
  readonly output: LocalTelemetryOutputSnapshot;
} {
  const telemetry = new Telemetry({ enabled: false });
  const collector = new DbzzOutputCollector();
  collector.finish();
  const startup = expectedDbzzStartupMode("disabled", "balanced");
  return {
    terminal: createDbzzTelemetryReport(
      startup,
      telemetry.snapshot(),
      telemetry.snapshot(),
      telemetry.aggregateSnapshot(),
    ),
    output: collector.snapshot(),
  };
}

function fakeWorkload(queryAttempts = 1): DriverResult {
  return {
    operations: [
      { operation: "query", trials: [{ attempted: queryAttempts }] },
      { operation: "mutation-uncontended", trials: [{ attempted: 1 }] },
      { operation: "procedure", trials: [{ attempted: 1 }] },
    ],
    subscriptions: [{ distinctQueryArguments: 1 }],
  } as unknown as DriverResult;
}

function setPath(root: unknown, path: readonly string[], value: unknown): void {
  let cursor = root as Record<string, unknown>;
  for (const key of path.slice(0, -1)) cursor = cursor[key] as Record<string, unknown>;
  cursor[path.at(-1)!] = value;
}

describe("dbzz benchmark telemetry report", () => {
  test("proves the real default local sink, absent exporter, aggregate matrix, and terminal drain", async () => {
    const { report } = await enabledFixture();

    expect(report.runtime.beforeDrain.exporter.configured).toBe(false);
    expect(report.runtime.afterDrain.exporter).toEqual({
      configured: false,
      inFlight: false,
      attempts: 0,
      failures: 0,
      timeouts: 0,
      exportedRecords: 0,
      failedRecords: 0,
    });
    expect(report.localOutput.byKind).toEqual({ span: 4, event: 1, metric: 0 });
    expect(report.runtime.afterDrain.localSink.deliveredRecords).toBe(5);
    expect(report.runtime.afterDrain.queuedRecords).toBe(0);
    expect(report.runtime.afterDrain.traceRetention).toMatchObject({
      activeTraces: 0,
      completedDecisions: 0,
      stagedRecords: 0,
      stagedBytes: 0,
    });
    expect(report.drainAccounting).toEqual({
      retainedBeforeDrain: 6,
      drainDropDelta: 6,
      overflowDropDelta: 0,
      expiredDropDelta: 0,
      drainTimeAdditionsOrRemovals: 0,
    });
    expect(report.aggregates.operations.query.stages.queue.count).toBe(1);
    expect(report.aggregates.operations.mutation.stages.queue.count).toBe(1);
    expect(report.aggregates.operations.procedure.stages.admission.count).toBe(1);
    expect(report.aggregates.operations.subscription.stages.queue.count).toBe(1);
  });

  test("keeps child output streaming and bounded while preserving control lines and fixed counters", () => {
    const collector = new DbzzOutputCollector();
    const encoder = new TextEncoder();
    const startup = `@@dbzz-startup ${JSON.stringify(expectedDbzzStartupMode("enabled", "balanced"))}\n`;
    const event = JSON.stringify({
      schemaVersion: 1,
      kind: "event",
      timestampMs: 1,
      name: "lifecycle",
      level: "info",
      operation: "lifecycle",
    });
    collector.writeStdout(encoder.encode(startup.slice(0, 23)));
    collector.writeStdout(encoder.encode(`${startup.slice(23)}[dbz] ready on http://127.0.0.1:3311\n`));
    collector.writeStdout(encoder.encode(event.slice(0, 19)));
    collector.writeStdout(encoder.encode(`${event.slice(19)}\n`));
    collector.writeStdout(encoder.encode("x".repeat(PRODUCTION_LIMITS.telemetry.maxBytes + 1)));
    collector.writeStdout(encoder.encode(`\n${"d".repeat(100_000)}\n`));
    collector.writeStderr(encoder.encode("last stderr line\n"));
    collector.finish();

    const output = collector.output();
    const snapshot = collector.snapshot();
    expect(output).toContain("@@dbzz-startup ");
    expect(output).toContain("ready on http://127.0.0.1:3311");
    expect(output).toContain("last stderr line");
    expect(snapshot.records).toBe(1);
    expect(snapshot.byKind.event).toBe(1);
    expect(snapshot.oversizedLines).toBe(1);
    expect(snapshot.peakPendingChars).toBeLessThanOrEqual(PRODUCTION_LIMITS.telemetry.maxBytes);
    expect(snapshot.diagnosticTailChars).toBeLessThanOrEqual(64 * 1024);
  });

  test("rejects cross-wired operation and stage aggregate cells", async () => {
    const fixture = await enabledFixture();
    const crossWired = structuredClone(fixture.terminal);
    (crossWired.aggregates.operations.query.stages.queue as { count: number }).count = 0;
    (crossWired.aggregates.operations.procedure.stages.queue as { count: number }).count = 1;

    expect(() =>
      parseDbzzTelemetryReport(
        JSON.stringify(crossWired),
        expectedDbzzStartupMode("enabled", "balanced"),
        fixture.output,
      )
    ).toThrow("query.queue");
  });

  test("checks operation totals and applicable stages against the executed workload", async () => {
    const { report } = await enabledFixture();
    expect(() => assertDbzzTelemetryWorkload(report, fakeWorkload())).not.toThrow();
    expect(() => assertDbzzTelemetryWorkload(report, fakeWorkload(2))).toThrow(
      "query.queue count 1 is below benchmark workload lower bound 2",
    );
  });

  test("requires every disabled telemetry snapshot and aggregate field to remain inert", () => {
    const fixture = disabledFixture();
    const startup = expectedDbzzStartupMode("disabled", "balanced");
    const report = parseDbzzTelemetryReport(JSON.stringify(fixture.terminal), startup, fixture.output);
    expect(report).toMatchObject({
      runtime: {
        beforeDrain: { enabled: false, queuedRecords: 0, metricSeries: 0 },
        afterDrain: { enabled: false, queuedRecords: 0, metricSeries: 0 },
      },
      aggregates: { maxSeries: 0, spans: 0 },
    });
    expect(() => assertDbzzTelemetryWorkload(report, fakeWorkload(1_000_000))).not.toThrow();

    const activityPaths = [
      ["runtime", "beforeDrain", "queuedRecords"],
      ["runtime", "beforeDrain", "metricSeries"],
      ["runtime", "beforeDrain", "localSink", "configured"],
      ["runtime", "beforeDrain", "localSink", "inFlight"],
      ["runtime", "beforeDrain", "localSink", "deliveredRecords"],
      ["runtime", "beforeDrain", "localSink", "dropped", "drain"],
      ["runtime", "beforeDrain", "exporter", "configured"],
      ["runtime", "beforeDrain", "exporter", "inFlight"],
      ["runtime", "beforeDrain", "exporter", "attempts"],
      ["runtime", "beforeDrain", "dropped", "drain"],
      ["runtime", "beforeDrain", "traceRetention", "maxTraces"],
      ["runtime", "beforeDrain", "traceRetention", "activeTraces"],
      ["runtime", "beforeDrain", "traceRetention", "dropped", "invalid"],
      ["aggregates", "maxSeries"],
      ["aggregates", "spans"],
    ] as const;
    for (const path of activityPaths) {
      const active = structuredClone(fixture.terminal);
      setPath(active, path, path.at(-1) === "configured" || path.at(-1) === "inFlight" ? true : 1);
      expect(() => parseDbzzTelemetryReport(JSON.stringify(active), startup, fixture.output)).toThrow(
        "must remain",
      );
    }
  });
});
