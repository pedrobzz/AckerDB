import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  assertPerformanceAcceptance,
  classifyFrozenWin,
  extractComparableMetrics,
  FROZEN_BASELINE_PATH,
  FROZEN_BASELINE_SHA256,
  FROZEN_NEAR_TIE_WINS,
  nearTieDriftTable,
  NOISE_FLOOR_CPU_CORES,
  NOISE_FLOOR_RELATIVE,
  noiseAllowance,
  PERFORMANCE_EXCLUSIONS,
  type BenchmarkRecordLike,
  type ComparableMetric,
} from "./performance-gates.ts";

const baselineJson = readFileSync(new URL(`../${FROZEN_BASELINE_PATH}`, import.meta.url), "utf8");
const baseline = JSON.parse(baselineJson) as BenchmarkRecordLike;
const copy = () => {
  const record = structuredClone(baseline);
  record.schemaVersion = 5;
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

function subscription(
  record: BenchmarkRecordLike,
  system: "dbzz" | "convex" | "spacetimedb",
  pattern: "shared" | "partitioned",
) {
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
  test("requires the exporter-cost schema-v5 after record", () => {
    const oldAfter = copy();
    oldAfter.schemaVersion = 4;
    expect(() => assertPerformanceAcceptance(oldAfter, baselineJson)).toThrow("after-run schema-v5");
  });

  test("the immutable baseline passes its own complete wins and margin floors", () => {
    const evidence = assertPerformanceAcceptance(copy(), baselineJson);
    expect(evidence).toMatchObject({
      schemaVersion: 2,
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
        frozenNearTieWins: 22,
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

  test("classifies exactly the frozen near-tie wins, keeping every other win a strict solid obligation", () => {
    const evidence = assertPerformanceAcceptance(copy(), baselineJson);
    const nearTies = evidence.frozenDbzzSpacetimeWins.filter((win) => win.classification === "near-tie");
    const solids = evidence.frozenDbzzSpacetimeWins.filter((win) => win.classification === "solid");
    expect(nearTies).toHaveLength(FROZEN_NEAR_TIE_WINS);
    expect(solids).toHaveLength(273 - FROZEN_NEAR_TIE_WINS);
    expect(nearTies.map((win) => win.path)).toEqual([
      "connections/100/resources/server/idle/cpuCores",
      "connections/1000/resources/server/idle/cpuCores",
      "connections/500/resources/server/idle/cpuCores",
      "operations/procedure/saturation/latency/p95Ms",
      "subscriptions/partitioned/capacity/32/deliveryLatency/p50Ms",
      "subscriptions/partitioned/capacity/32/timeToAll/p50Ms",
      "subscriptions/partitioned/capacity/32/updateAckLatency/p50Ms",
      "subscriptions/partitioned/fixed-rate/deliveryThroughputPerSec",
      "subscriptions/partitioned/fixed-rate/resources/server/subscribed-idle/cpuCores",
      "subscriptions/partitioned/fixed-rate/setupConnectionsPerSec",
      "subscriptions/partitioned/fixed-rate/setupMs",
      "subscriptions/partitioned/fixed-rate/updateThroughputPerSec",
      "subscriptions/shared/capacity/32/deliveryLatency/p99Ms",
      "subscriptions/shared/capacity/32/updateAckLatency/p95Ms",
      "subscriptions/shared/capacity/32/updateAckLatency/p99Ms",
      "subscriptions/shared/capacity/50/deliveryLatency/p95Ms",
      "subscriptions/shared/capacity/50/deliveryLatency/p99Ms",
      "subscriptions/shared/capacity/50/timeToAll/p99Ms",
      "subscriptions/shared/capacity/50/updateAckLatency/p99Ms",
      "subscriptions/shared/capacity/8/resources/server/work/cpuCores",
      "subscriptions/shared/fixed-rate/deliveryThroughputPerSec",
      "subscriptions/shared/fixed-rate/resources/server/subscribed-idle/cpuCores",
    ]);
    for (const win of solids) expect(win.noiseAllowance, win.path).toBe(0);
    for (const win of nearTies) expect(win.noiseAllowance, win.path).toBeGreaterThan(0);
  });

  test("noise floor boundaries are deterministic per family and margin", () => {
    const metric = (family: string, direction: "higher" | "lower", value: number): ComparableMetric => ({
      path: `synthetic/${family}/${direction}/${value}`,
      value,
      direction,
      family,
    });

    expect(noiseAllowance("operation.throughput", 100)).toBe(NOISE_FLOOR_RELATIVE * 100);
    expect(noiseAllowance("resource.cpu", 1)).toBe(NOISE_FLOOR_RELATIVE);
    expect(noiseAllowance("resource.cpu", 0.05)).toBe(NOISE_FLOOR_CPU_CORES);
    expect(noiseAllowance("resource.rss", 0.05)).toBe(NOISE_FLOOR_RELATIVE * 0.05);

    // relative floor: a 10% margin is a near-tie, a 16% margin is solid, and
    // a margin at the floor is solid (classification uses a strict <)
    expect(classifyFrozenWin(metric("operation.throughput", "higher", 110), metric("operation.throughput", "higher", 100))).toBe("near-tie");
    expect(classifyFrozenWin(metric("operation.throughput", "higher", 116), metric("operation.throughput", "higher", 100))).toBe("solid");
    expect(classifyFrozenWin(metric("operation.latency.p95", "lower", 3.4), metric("operation.latency.p95", "lower", 4))).toBe("solid");
    expect(classifyFrozenWin(metric("operation.latency.p95", "lower", 3.5), metric("operation.latency.p95", "lower", 4))).toBe("near-tie");

    // resource.cpu absolute floor: a large relative margin at milli-core scale
    // is still a near-tie, while the same relative margin at load scale is solid
    expect(classifyFrozenWin(metric("resource.cpu", "lower", 0.034), metric("resource.cpu", "lower", 0.048))).toBe("near-tie");
    expect(classifyFrozenWin(metric("resource.cpu", "lower", 0.68), metric("resource.cpu", "lower", 0.96))).toBe("solid");
    expect(classifyFrozenWin(metric("resource.cpu", "lower", 0.075), metric("resource.cpu", "lower", 0.1))).toBe("solid");
    expect(classifyFrozenWin(metric("resource.cpu", "lower", 0.08), metric("resource.cpu", "lower", 0.1))).toBe("near-tie");

    expect(() => classifyFrozenWin(metric("resource.cpu", "lower", 0.1), metric("resource.cpu", "lower", 0.1))).toThrow(
      "is not a frozen baseline win",
    );
  });

  test("allows shorter measurement effort without changing the workload identity", () => {
    const after = copy();
    for (const system of ["dbzz", "convex", "spacetimedb"] as const) {
      const config = after.systems[system]!.workload.config;
      config.operation.warmupMs = 500;
      config.operation.steadyMs = 2_000;
      config.operation.trials = 1;
      config.connections.workMs = 1_000;
      config.subscriptions.durationMs = 2_000;
      config.subscriptions.capacityDurationMs = 2_000;
      for (const result of after.systems[system]!.workload.subscriptions) {
        const rate = result.pattern === "shared"
          ? config.subscriptions.sharedUpdatesPerSec
          : config.subscriptions.partitionedUpdatesPerSec;
        result.updates = (config.subscriptions.durationMs / 1_000) * rate;
        result.expectedDeliveries = result.updates * (result.pattern === "shared" ? result.users : 1);
        result.observedDeliveries = result.expectedDeliveries;
        result.missingDeliveries = 0;
      }
    }
    expect(assertPerformanceAcceptance(after, baselineJson).passed).toBe(true);
  });

  test("rejects current-system measurement drift and frozen workload drift", () => {
    const currentDrift = copy();
    currentDrift.systems.convex!.workload.config.operation.steadyMs = 2_000;
    expect(() => assertPerformanceAcceptance(currentDrift, baselineJson)).toThrow(
      "convex after-run config does not match the current DBZZ config",
    );

    const workloadDrift = copy();
    for (const system of ["dbzz", "convex", "spacetimedb"] as const) {
      workloadDrift.systems[system]!.workload.config.connections.levels = [1, 100, 500];
    }
    expect(() => assertPerformanceAcceptance(workloadDrift, baselineJson)).toThrow(
      "after-run workload identity does not match the frozen baseline",
    );
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

  test("a solid win that slips behind by less than the noise floor still fails: the floor never loosens strict obligations", () => {
    const after = copy();
    const spacetime = after.systems.spacetimedb!.resources.server.phases["connections:100:work"]!.cpuCores;
    after.systems.dbzz!.resources.server.phases["connections:100:work"]!.cpuCores = spacetime * 1.01;
    expect(() => assertPerformanceAcceptance(after, baselineJson)).toThrow(
      "frozen DBZZ-over-SpacetimeDB win lost at connections/100/resources/server/work/cpuCores",
    );
  });

  test("a near-tie win flipped within the noise floor passes and stays visible in evidence and the drift table", () => {
    const after = copy();
    const spacetimeDelivery = subscription(after, "spacetimedb", "shared").deliveryThroughputPerSec;
    subscription(after, "dbzz", "shared").deliveryThroughputPerSec = spacetimeDelivery * 0.9;
    const spacetimeIdle = after.systems.spacetimedb!.resources.server.phases["connections:500:idle"]!.cpuCores;
    after.systems.dbzz!.resources.server.phases["connections:500:idle"]!.cpuCores = spacetimeIdle + 0.02;

    const evidence = assertPerformanceAcceptance(after, baselineJson);
    expect(evidence.metricCounts.frozenNearTieWins).toBe(22);
    const delivery = evidence.frozenDbzzSpacetimeWins.find(
      (win) => win.path === "subscriptions/shared/fixed-rate/deliveryThroughputPerSec",
    )!;
    expect(delivery.classification).toBe("near-tie");
    expect(delivery.afterDbzz).toBeLessThan(delivery.afterSpacetime);
    const idle = evidence.frozenDbzzSpacetimeWins.find(
      (win) => win.path === "connections/500/resources/server/idle/cpuCores",
    )!;
    expect(idle.classification).toBe("near-tie");
    expect(idle.noiseAllowance).toBe(NOISE_FLOOR_CPU_CORES);

    const table = nearTieDriftTable(evidence.frozenDbzzSpacetimeWins);
    expect(table).toContain("subscriptions/shared/fixed-rate/deliveryThroughputPerSec");
    expect(table).toContain("-10.0%");
    expect(table).toContain("connections/500/resources/server/idle/cpuCores");
    expect(table.split("\n")).toHaveLength(1 + 22);
  });

  test("a near-tie win reversed beyond the noise floor fails on both the relative and the absolute cpu envelope", () => {
    const relative = copy();
    subscription(relative, "dbzz", "shared").deliveryThroughputPerSec =
      subscription(relative, "spacetimedb", "shared").deliveryThroughputPerSec * 0.8;
    expect(() => assertPerformanceAcceptance(relative, baselineJson)).toThrow(
      "frozen near-tie DBZZ-over-SpacetimeDB win reversed beyond the noise floor at subscriptions/shared/fixed-rate/deliveryThroughputPerSec",
    );

    const absolute = copy();
    const spacetimeIdle = absolute.systems.spacetimedb!.resources.server.phases["connections:500:idle"]!.cpuCores;
    absolute.systems.dbzz!.resources.server.phases["connections:500:idle"]!.cpuCores = spacetimeIdle + 0.03;
    expect(() => assertPerformanceAcceptance(absolute, baselineJson)).toThrow(
      "frozen near-tie DBZZ-over-SpacetimeDB win reversed beyond the noise floor at connections/500/resources/server/idle/cpuCores",
    );
  });

  test("a coherent setup slowdown that lands beyond the floor fails even though both setup paths are near-ties", () => {
    const after = copy();
    const dbzzSetup = subscription(after, "dbzz", "partitioned");
    const spacetimeSetup = subscription(after, "spacetimedb", "partitioned");
    // one internally consistent regression: setup time and its derived
    // connections/s move together until DBZZ is 16% behind SpacetimeDB
    const factor = (spacetimeSetup.setupMs * 1.16) / dbzzSetup.setupMs;
    expect(factor).toBeGreaterThan(1);
    dbzzSetup.setupMs *= factor;
    dbzzSetup.setupConnectionsPerSec /= factor;
    expect(() => assertPerformanceAcceptance(after, baselineJson)).toThrow(
      "frozen near-tie DBZZ-over-SpacetimeDB win reversed beyond the noise floor at subscriptions/partitioned/fixed-rate/setupMs",
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
