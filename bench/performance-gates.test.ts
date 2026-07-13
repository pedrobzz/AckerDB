import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  assertPerformanceAcceptance,
  extractComparableMetrics,
  FROZEN_BASELINE_PATH,
  FROZEN_BASELINE_SHA256,
  PERFORMANCE_EXCLUSIONS,
  type BenchmarkRecordLike,
} from "./performance-gates.ts";

const baselineJson = readFileSync(new URL(`../${FROZEN_BASELINE_PATH}`, import.meta.url), "utf8");
const baseline = JSON.parse(baselineJson) as BenchmarkRecordLike;
const copy = () => {
  const record = structuredClone(baseline);
  record.schemaVersion = 4;
  return record;
};

function operation(record: BenchmarkRecordLike, system: "dbzz" | "convex", name = "query", profile = "latency") {
  return record.systems[system]!.workload.operations.find(
    (item) => item.operation === name && item.profile.name === profile,
  )!;
}

function connection(record: BenchmarkRecordLike, system: "dbzz" | "convex", target = 1) {
  return record.systems[system]!.workload.connections.find((item) => item.targetConnections === target)!;
}

function subscription(record: BenchmarkRecordLike, system: "dbzz" | "convex", pattern: "shared" | "partitioned") {
  return record.systems[system]!.workload.subscriptions.find((item) => item.pattern === pattern)!;
}

describe("complete benchmark metric extraction", () => {
  test("covers every frozen operation, connection, fixed-rate, capacity, and server-resource path exactly once", () => {
    const metrics = extractComparableMetrics(baseline.systems.dbzz!);
    expect(metrics).toHaveLength(351);
    expect(new Set(metrics.map((metric) => metric.path)).size).toBe(351);
    for (const path of [
      "operations/query/latency/throughputPerSec",
      "operations/procedure/saturation/latency/p99Ms",
      "operations/mutation-contended/concurrent/resources/server/cpuCoresMedian",
      "connections/1/readiness/connectionsPerSec",
      "connections/1000/readiness/latency/p99Ms",
      "connections/500/work/latency/p95Ms",
      "connections/100/resources/server/work/rssMb/peak",
      "subscriptions/shared/fixed-rate/setupConnectionsPerSec",
      "subscriptions/partitioned/fixed-rate/updateAckLatency/p50Ms",
      "subscriptions/shared/fixed-rate/deliveryLatency/p95Ms",
      "subscriptions/partitioned/fixed-rate/timeToAll/p99Ms",
      "subscriptions/shared/capacity/50/updateThroughputPerSec",
      "subscriptions/partitioned/capacity/500/updateAckLatency/p95Ms",
      "subscriptions/shared/capacity/8/deliveryLatency/p99Ms",
      "subscriptions/partitioned/capacity/128/timeToAll/p50Ms",
      "subscriptions/shared/capacity/32/resources/server/work/rssMb/p50",
    ]) {
      expect(metrics.some((metric) => metric.path === path), path).toBe(true);
    }
    expect(metrics.find((metric) => metric.path === "resources/startup-idle/rssMb/p50")?.convexRssFloor).toBe(false);
    expect(
      metrics.find((metric) => metric.path === "operations/query/latency/resources/server/rssMb/p50Median")
        ?.convexRssFloor,
    ).toBe(true);
  });

  test("rejects omitted, duplicate, and semantically miswired metric sources", () => {
    const omittedWindow = copy();
    delete omittedWindow.systems.dbzz!.resources.server.phases["operation:query:latency:trial-0"];
    expect(() => extractComparableMetrics(omittedWindow.systems.dbzz!)).toThrow(
      "missing server resource window operation:query:latency:trial-0",
    );

    const omittedCase = copy();
    omittedCase.systems.dbzz!.workload.operations.pop();
    expect(() => assertPerformanceAcceptance(omittedCase, baselineJson)).toThrow("comparable metric count");

    const duplicate = copy();
    duplicate.systems.dbzz!.workload.operations.push(structuredClone(duplicate.systems.dbzz!.workload.operations[0]!));
    expect(() => extractComparableMetrics(duplicate.systems.dbzz!)).toThrow("duplicate comparable metric path");

    const miswired = copy();
    operation(miswired, "dbzz").trials[0]!.phaseId = "operation:query:latency:trial-1";
    expect(() => extractComparableMetrics(miswired.systems.dbzz!)).toThrow(
      "miswired phase operation:query:latency:trial-1; expected operation:query:latency:trial-0",
    );
  });
});

describe("frozen performance acceptance", () => {
  test("the immutable baseline passes its own complete wins and margin floors", () => {
    const evidence = assertPerformanceAcceptance(copy(), baselineJson);
    expect(evidence).toMatchObject({
      schemaVersion: 1,
      passed: true,
      baseline: {
        path: FROZEN_BASELINE_PATH,
        schemaVersion: 3,
        gitCommit: "74d8554",
      },
      metricCounts: {
        baselinePerSystem: { dbzz: 351, convex: 351, spacetimedb: 351 },
        afterPerSystem: { dbzz: 351, convex: 351, spacetimedb: 351 },
        frozenDbzzSpacetimeWins: 273,
        convexFloorChecks: 126,
      },
      partitionedFixedRate: {
        offeredUpdatesPerSec: 100,
        offeredUpdates: 500,
        completedUpdates: 500,
        expectedDeliveries: 500,
        observedDeliveries: 500,
        passed: true,
      },
    });
    expect(evidence.baseline.sha256).toBe(FROZEN_BASELINE_SHA256);
    expect(evidence.baseline.configSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(evidence.frozenDbzzSpacetimeWins).toHaveLength(273);
    expect(evidence.convexFloors).toHaveLength(126);
    expect(evidence.exclusions).toEqual(PERFORMANCE_EXCLUSIONS);
  });

  test("rejects any mutation of the immutable baseline source", () => {
    const tampered = baselineJson.replace('"dirty": true', '"dirty": false');
    expect(tampered).not.toBe(baselineJson);
    expect(() => assertPerformanceAcceptance(copy(), tampered)).toThrow(
      "frozen benchmark baseline digest",
    );
  });

  test("fails if any prior strict DBZZ-over-SpacetimeDB path is no longer a strict win", () => {
    const after = copy();
    after.systems.dbzz!.startupIdle.window.rssMb.p50 = after.systems.spacetimedb!.startupIdle.window.rssMb.p50;
    expect(() => assertPerformanceAcceptance(after, baselineJson)).toThrow(
      "frozen DBZZ-over-SpacetimeDB win lost at resources/startup-idle/rssMb/p50",
    );
  });

  test("rejects every frozen Convex floor group adversarially", () => {
    const cases: { name: string; mutate(record: BenchmarkRecordLike): void }[] = [
      {
        name: "operation throughput",
        mutate(record) {
          operation(record, "convex").medianThroughputPerSec = operation(record, "dbzz").medianThroughputPerSec / 4.9;
        },
      },
      {
        name: "operation p95",
        mutate(record) {
          operation(record, "convex").medianLatencyP95Ms = operation(record, "dbzz").medianLatencyP95Ms * 1.9;
        },
      },
      {
        name: "connection work throughput",
        mutate(record) {
          connection(record, "convex").work.throughputPerSec = connection(record, "dbzz").work.throughputPerSec / 4.9;
        },
      },
      {
        name: "connection work p95",
        mutate(record) {
          connection(record, "convex").work.latency.p95Ms = connection(record, "dbzz").work.latency.p95Ms * 1.9;
        },
      },
      {
        name: "shared fixed-rate throughput",
        mutate(record) {
          subscription(record, "convex", "shared").deliveryThroughputPerSec =
            subscription(record, "dbzz", "shared").deliveryThroughputPerSec / 1.2;
        },
      },
      {
        name: "fixed-rate delivery p95",
        mutate(record) {
          subscription(record, "convex", "shared").deliveryLatency.p95Ms =
            subscription(record, "dbzz", "shared").deliveryLatency.p95Ms * 1.9;
        },
      },
      {
        name: "capacity delivery p95",
        mutate(record) {
          const dbzz = subscription(record, "dbzz", "shared").capacity[0]!;
          subscription(record, "convex", "shared").capacity[0]!.deliveryLatency.p95Ms = dbzz.deliveryLatency.p95Ms * 1.9;
        },
      },
      {
        name: "loaded server RSS",
        mutate(record) {
          const dbzz = record.systems.dbzz!.resources.server.phases["operation:query:latency:trial-1"]!.rssMb;
          for (let trial = 0; trial < 3; trial++) {
            const rss = record.systems.convex!.resources.server.phases[`operation:query:latency:trial-${trial}`]!.rssMb;
            rss.p50 = dbzz.p50 * 1.5;
            rss.peak = dbzz.peak * 1.5;
          }
        },
      },
    ];
    for (const entry of cases) {
      const after = copy();
      entry.mutate(after);
      expect(() => assertPerformanceAcceptance(after, baselineJson), entry.name).toThrow("Convex floor failed");
    }
  });

  test("requires partitioned fixed-rate to complete the exact offered workload", () => {
    const after = copy();
    subscription(after, "dbzz", "partitioned").updates--;
    expect(() => assertPerformanceAcceptance(after, baselineJson)).toThrow(
      "partitioned fixed-rate offered target failed",
    );
  });
});
