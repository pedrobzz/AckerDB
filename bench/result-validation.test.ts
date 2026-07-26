import { describe, expect, test } from "bun:test";
import type { BenchmarkConfig, DriverResult, SystemName } from "./benchmark.ts";
import {
  formatBenchmarkValidation,
  validateBenchmarkResults,
  type BenchmarkValidationTarget,
} from "./result-validation.ts";

const config: BenchmarkConfig = {
  profile: "default",
  seed: 1,
  operation: {
    warmupMs: 1,
    steadyMs: 1,
    trials: 1,
    drainTimeoutMs: 1,
    profiles: [{ name: "latency", connections: 1, inFlightPerConnection: 1 }],
  },
  connections: { levels: [1], batchSize: 1, workMs: 1, timeoutMs: 1 },
  subscriptions: {
    users: 1,
    queriesPerUser: 1,
    durationMs: 1_000,
    sharedUpdatesPerSec: 1,
    partitionedUpdatesPerSec: 1,
    capacityDurationMs: 1_000,
    capacitySlots: [1],
    setupTimeoutMs: 1,
    drainTimeoutMs: 1,
    patterns: ["shared"],
  },
  resources: { idleMs: 1 },
  seedBatchSize: 1,
};

function loop(phaseId: string) {
  return {
    phaseId,
    windowStartedAtMs: 0,
    windowEndedAtMs: 1,
    wallMs: 1,
    attempted: 1,
    completedInWindow: 1,
    completedAfterWindow: 0,
    failed: 0,
    throughputPerSec: 1,
    latency: { count: 1, minMs: 1, p50Ms: 1, p95Ms: 1, p99Ms: 1, maxMs: 1 },
    errors: [],
    interruption: null,
  };
}

function workload(system: SystemName): DriverResult {
  return {
    system,
    config: structuredClone(config),
    snapshots: { seededIdle: "seeded", seededIdlePhaseId: "seeded", connectionBaselineIdlePhaseId: "baseline" },
    operations: ["query", "mutation-uncontended", "mutation-contended", "procedure"].map((operation) => ({
      operation,
      profile: { name: "latency", connections: 1, inFlightPerConnection: 1 },
      trials: [{ ...loop(`operation:${operation}:latency:trial-0`), correctness: { ok: true, errors: [] } }],
      medianThroughputPerSec: 1,
      medianLatencyP50Ms: 1,
      medianLatencyP95Ms: 1,
      medianLatencyP99Ms: 1,
    })) as DriverResult["operations"],
    connections: [{
      targetConnections: 1,
      connected: 1,
      addedConnections: 1,
      setupMs: 1,
      readyConnectionsPerSec: 1,
      readyLatency: { count: 1, minMs: 1, p50Ms: 1, p95Ms: 1, p99Ms: 1, maxMs: 1 },
      connectedSnapshotId: "connected",
      connectedIdlePhaseId: "connections:1:idle",
      work: loop("connections:1:work"),
      errors: [],
    }],
    subscriptions: [{
      pattern: "shared",
      users: 1,
      queriesPerUser: 1,
      logicalSubscriptions: 1,
      distinctQueryArguments: 1,
      baselineIdlePhaseId: "subscriptions:shared:baseline-idle",
      setupMs: 1,
      setupConnectionsPerSec: 1,
      subscribedSnapshotId: "subscribed",
      subscribedIdlePhaseId: "subscriptions:shared:idle",
      phaseId: "subscriptions:shared:updates",
      updates: 1,
      updateThroughputPerSec: 1,
      expectedDeliveries: 1,
      observedDeliveries: 1,
      duplicateDeliveries: 0,
      unexpectedDeliveries: 0,
      corruptDeliveries: 0,
      missingDeliveries: 0,
      deliveryThroughputPerSec: 1,
      updateAckLatency: { count: 1, minMs: 1, p50Ms: 1, p95Ms: 1, p99Ms: 1, maxMs: 1 },
      deliveryLatency: { count: 1, minMs: 1, p50Ms: 1, p95Ms: 1, p99Ms: 1, maxMs: 1 },
      timeToAll: { count: 1, minMs: 1, p50Ms: 1, p95Ms: 1, p99Ms: 1, maxMs: 1 },
      capacity: [{ ...loop("subscriptions:shared:capacity-1"), slots: 1, deliveriesPerUpdate: 1, deliveryThroughputPerSec: 1, updateAckLatency: { count: 1, minMs: 1, p50Ms: 1, p95Ms: 1, p99Ms: 1, maxMs: 1 }, deliveryLatency: { count: 1, minMs: 1, p50Ms: 1, p95Ms: 1, p99Ms: 1, maxMs: 1 }, correctness: { ok: true, errors: [] } }],
      correctness: { ok: true, errors: [] },
    }],
    failures: [],
  };
}

function targets(): BenchmarkValidationTarget[] {
  return (["ackerdb", "convex", "spacetimedb"] as const).map((system) => ({ label: system, system, workload: workload(system) }));
}

describe("benchmark result validation", () => {
  test("returns immutable empty observations for comparable correct results", () => {
    const validation = validateBenchmarkResults(targets());
    expect(validation).toEqual({ failures: [], integrityAnomalies: [] });
    expect(formatBenchmarkValidation(validation)).toBe("Benchmark validation observations: none");
    expect(Object.isFrozen(validation)).toBe(true);
  });

  test("reports measured correctness failures with their system identity", () => {
    const results = targets();
    const trial = results[0]!.workload.operations[0]!.trials[0]!;
    trial.completedInWindow = 0;
    trial.failed = 1;
    trial.correctness = { ok: false, errors: ["query checksum mismatch"] };
    const validation = validateBenchmarkResults(results);
    expect(validation).toMatchObject({
      failures: [{ target: "ackerdb", system: "ackerdb", kind: "operation", case: "query/latency/trial-0", errors: ["query checksum mismatch", "1 request failed"] }],
      integrityAnomalies: [],
    });
  });

  test("records comparative-target failures without deriving a verdict", () => {
    const results = targets();
    const trial = results[1]!.workload.operations[0]!.trials[0]!; // convex
    trial.completedInWindow = 0;
    trial.failed = 1;
    trial.correctness = { ok: false, errors: ["duplicate deliveries"] };
    const validation = validateBenchmarkResults(results);
    expect(validation.failures).toEqual([
      expect.objectContaining({ target: "convex", system: "convex", errors: ["duplicate deliveries", "1 request failed"] }),
    ]);
  });

  test("records changed workloads and broken accounting as integrity observations", () => {
    const configMismatch = targets();
    configMismatch[1]!.workload.config.seed = 2;
    expect(validateBenchmarkResults(configMismatch).integrityAnomalies).toContainEqual(
      expect.objectContaining({ target: "convex", system: "convex", message: expect.stringContaining("workload config differs") }),
    );

    const accountingMismatch = targets();
    accountingMismatch[0]!.workload.connections[0]!.work.attempted = 2;
    expect(validateBenchmarkResults(accountingMismatch).integrityAnomalies).toContainEqual(
      expect.objectContaining({ target: "ackerdb", system: "ackerdb", message: expect.stringContaining("request accounting mismatch") }),
    );
  });
});
