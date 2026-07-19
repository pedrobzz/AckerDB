import {
  offeredFixedRateUpdates,
  type DriverResult,
  type LatencyStats,
  type SubscriptionResult,
  type SubscriptionCapacityResult,
  type SystemName,
} from "./benchmark.ts";
import type { ProcessTreeWindowSummary } from "./process-tree.ts";

/** A directional move must exceed this observed run-to-run envelope before recovery starts. */
export const REGRESSION_NOISE_FLOOR_RELATIVE = 0.15;
/** `ps` CPU accounting is quantized at idle, so a relative threshold alone is not meaningful there. */
export const REGRESSION_NOISE_FLOOR_CPU_CORES = 0.025;

export interface MeasuredSystem {
  workload: DriverResult;
  startupIdle: { window: ProcessTreeWindowSummary };
  resources: { server: { phases: Record<string, ProcessTreeWindowSummary> } };
}

export interface BenchmarkRecordLike {
  schemaVersion: number;
  timestamp: string;
  git: { commit: string; sourceHash: string };
  machine: {
    platform: string;
    arch: string;
    cpu: string;
    logicalCpus: number;
    memGb: number;
    osRelease: string;
    fileDescriptorLimit: number;
  };
  methodology: { sampleIntervalMs: number };
  systems: Partial<Record<SystemName, MeasuredSystem>>;
}

export type MetricDirection = "higher" | "lower";

export interface ComparableMetric {
  path: string;
  value: number;
  direction: MetricDirection;
  family: string;
  offeredWorkComplete?: boolean;
  convexRssFloor?: boolean;
}

export interface PerformanceRegression {
  path: string;
  direction: MetricDirection;
  previous: number;
  current: number;
  deltaPercent: number | null;
  threshold: number;
}

export interface PerformanceAcceptanceEvidence {
  schemaVersion: 1;
  previousVersion: string | null;
  currentVersion: string;
  metricCount: number;
  regressions: readonly PerformanceRegression[];
}

export type PerformanceAcceptanceResult =
  | {
      readonly status: "passed" | "recovery-needed";
      readonly evidence: PerformanceAcceptanceEvidence;
    }
  | {
      readonly status: "not-evaluated";
      readonly reason: "correctness-failed";
    };

class MetricCollector {
  readonly metrics: ComparableMetric[] = [];
  private readonly paths = new Set<string>();

  add(metric: ComparableMetric): void {
    if (this.paths.has(metric.path)) throw new Error(`duplicate comparable metric path ${metric.path}`);
    if (!Number.isFinite(metric.value) || metric.value < 0) {
      throw new Error(`comparable metric ${metric.path} is not a finite non-negative number`);
    }
    this.paths.add(metric.path);
    this.metrics.push(metric);
  }
}

function median(values: number[], path: string): number {
  if (values.length === 0) throw new Error(`${path} has no resource windows`);
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function phase(system: MeasuredSystem, actual: string, expected: string): ProcessTreeWindowSummary {
  if (actual !== expected) throw new Error(`miswired phase ${actual}; expected ${expected}`);
  const window = system.resources.server.phases[actual];
  if (window === undefined) throw new Error(`missing server resource window ${actual}`);
  return window;
}

function addResources(
  metrics: MetricCollector,
  path: string,
  window: ProcessTreeWindowSummary,
  convexRssFloor = false,
): void {
  metrics.add({ path: `${path}/rssMb/p50`, value: window.rssMb.p50, direction: "lower", family: "resource.rss", convexRssFloor });
  metrics.add({ path: `${path}/rssMb/peak`, value: window.rssMb.peak, direction: "lower", family: "resource.rss", convexRssFloor });
  metrics.add({ path: `${path}/cpuCores`, value: window.cpuCores, direction: "lower", family: "resource.cpu" });
}

function addLatency(
  metrics: MetricCollector,
  path: string,
  latency: Pick<LatencyStats, "p50Ms" | "p95Ms" | "p99Ms">,
  family: string,
  offeredWorkComplete?: boolean,
): void {
  for (const percentile of ["p50Ms", "p95Ms", "p99Ms"] as const) {
    metrics.add({
      path: `${path}/${percentile}`,
      value: latency[percentile],
      direction: "lower",
      family: `${family}.${percentile.slice(0, 3)}`,
      ...(offeredWorkComplete === undefined ? {} : { offeredWorkComplete }),
    });
  }
}

function fixedRateComplete(result: SubscriptionResult, durationMs: number, offeredUpdatesPerSec: number): boolean {
  return result.correctness.ok &&
    result.updates === offeredFixedRateUpdates(durationMs, offeredUpdatesPerSec) &&
    result.observedDeliveries === result.expectedDeliveries &&
    result.missingDeliveries === 0;
}

function capacityComplete(result: SubscriptionCapacityResult): boolean {
  return result.correctness.ok &&
    result.failed === 0 &&
    result.attempted === result.completedInWindow + result.completedAfterWindow;
}

export function extractComparableMetrics(system: MeasuredSystem): ComparableMetric[] {
  const metrics = new MetricCollector();
  const workload = system.workload;
  if ((workload.failures ?? []).length > 0) {
    throw new Error("cannot extract performance metrics from a failed workload");
  }
  addResources(metrics, "resources/startup-idle", system.startupIdle.window);
  addResources(
    metrics,
    "resources/seeded-idle",
    phase(system, workload.snapshots.seededIdlePhaseId, "server:seeded-idle-window"),
  );
  addResources(
    metrics,
    "resources/connection-baseline-idle",
    phase(system, workload.snapshots.connectionBaselineIdlePhaseId, "connections:baseline-idle"),
  );

  for (const operation of workload.operations) {
    const root = `operations/${operation.operation}/${operation.profile.name}`;
    metrics.add({
      path: `${root}/throughputPerSec`,
      value: operation.medianThroughputPerSec,
      direction: "higher",
      family: "operation.throughput",
    });
    addLatency(metrics, `${root}/latency`, {
      p50Ms: operation.medianLatencyP50Ms,
      p95Ms: operation.medianLatencyP95Ms,
      p99Ms: operation.medianLatencyP99Ms,
    }, "operation.latency");
    const windows = operation.trials.map((trial, index) =>
      phase(system, trial.phaseId, `operation:${operation.operation}:${operation.profile.name}:trial-${index}`),
    );
    metrics.add({
      path: `${root}/resources/server/rssMb/p50Median`,
      value: median(windows.map((window) => window.rssMb.p50), root),
      direction: "lower",
      family: "resource.rss",
      convexRssFloor: true,
    });
    metrics.add({
      path: `${root}/resources/server/rssMb/peakMax`,
      value: Math.max(...windows.map((window) => window.rssMb.peak)),
      direction: "lower",
      family: "resource.rss",
      convexRssFloor: true,
    });
    metrics.add({
      path: `${root}/resources/server/cpuCoresMedian`,
      value: median(windows.map((window) => window.cpuCores), root),
      direction: "lower",
      family: "resource.cpu",
    });
  }

  for (const connection of workload.connections) {
    const root = `connections/${connection.targetConnections}`;
    metrics.add({
      path: `${root}/readiness/connectionsPerSec`,
      value: connection.readyConnectionsPerSec,
      direction: "higher",
      family: "connection.readiness.throughput",
    });
    metrics.add({
      path: `${root}/readiness/setupMs`,
      value: connection.setupMs,
      direction: "lower",
      family: "connection.readiness.setup",
    });
    addLatency(metrics, `${root}/readiness/latency`, connection.readyLatency, "connection.readiness.latency");
    metrics.add({
      path: `${root}/work/throughputPerSec`,
      value: connection.work.throughputPerSec,
      direction: "higher",
      family: "connection.work.throughput",
    });
    addLatency(metrics, `${root}/work/latency`, connection.work.latency, "connection.work.latency");
    addResources(
      metrics,
      `${root}/resources/server/idle`,
      phase(system, connection.connectedIdlePhaseId, `connections:${connection.targetConnections}:idle`),
      true,
    );
    addResources(
      metrics,
      `${root}/resources/server/work`,
      phase(system, connection.work.phaseId, `connections:${connection.targetConnections}:work`),
      true,
    );
  }

  for (const subscription of workload.subscriptions) {
    const root = `subscriptions/${subscription.pattern}/fixed-rate`;
    const offered = subscription.pattern === "shared"
      ? workload.config.subscriptions.sharedUpdatesPerSec
      : workload.config.subscriptions.partitionedUpdatesPerSec;
    const complete = fixedRateComplete(subscription, workload.config.subscriptions.durationMs, offered);
    metrics.add({ path: `${root}/setupMs`, value: subscription.setupMs, direction: "lower", family: "subscription.fixed.setup" });
    metrics.add({
      path: `${root}/setupConnectionsPerSec`,
      value: subscription.setupConnectionsPerSec,
      direction: "higher",
      family: "subscription.fixed.setupThroughput",
    });
    metrics.add({
      path: `${root}/updateThroughputPerSec`,
      value: subscription.updateThroughputPerSec,
      direction: "higher",
      family: "subscription.fixed.update.throughput",
    });
    metrics.add({
      path: `${root}/deliveryThroughputPerSec`,
      value: subscription.deliveryThroughputPerSec,
      direction: "higher",
      family: "subscription.fixed.delivery.throughput",
      offeredWorkComplete: complete,
    });
    addLatency(metrics, `${root}/updateAckLatency`, subscription.updateAckLatency, "subscription.fixed.ack", complete);
    addLatency(metrics, `${root}/deliveryLatency`, subscription.deliveryLatency, "subscription.fixed.delivery", complete);
    addLatency(metrics, `${root}/timeToAll`, subscription.timeToAll, "subscription.fixed.all", complete);
    addResources(
      metrics,
      `${root}/resources/server/baseline-idle`,
      phase(system, subscription.baselineIdlePhaseId, `subscriptions:${subscription.pattern}:baseline-idle`),
    );
    addResources(
      metrics,
      `${root}/resources/server/subscribed-idle`,
      phase(system, subscription.subscribedIdlePhaseId, `subscriptions:${subscription.pattern}:idle`),
      true,
    );
    addResources(
      metrics,
      `${root}/resources/server/work`,
      phase(system, subscription.phaseId, `subscriptions:${subscription.pattern}:updates`),
      true,
    );

    for (const capacity of subscription.capacity) {
      const capacityRoot = `subscriptions/${subscription.pattern}/capacity/${capacity.slots}`;
      const capacityCompleted = capacityComplete(capacity);
      metrics.add({
        path: `${capacityRoot}/updateThroughputPerSec`,
        value: capacity.throughputPerSec,
        direction: "higher",
        family: "subscription.capacity.update.throughput",
      });
      metrics.add({
        path: `${capacityRoot}/deliveryThroughputPerSec`,
        value: capacity.deliveryThroughputPerSec,
        direction: "higher",
        family: "subscription.capacity.delivery.throughput",
      });
      addLatency(metrics, `${capacityRoot}/updateAckLatency`, capacity.updateAckLatency, "subscription.capacity.ack", capacityCompleted);
      addLatency(metrics, `${capacityRoot}/deliveryLatency`, capacity.deliveryLatency, "subscription.capacity.delivery", capacityCompleted);
      addLatency(metrics, `${capacityRoot}/timeToAll`, capacity.latency, "subscription.capacity.all", capacityCompleted);
      addResources(
        metrics,
        `${capacityRoot}/resources/server/work`,
        phase(system, capacity.phaseId, `subscriptions:${subscription.pattern}:capacity-${capacity.slots}`),
        true,
      );
    }
  }
  return metrics.metrics.sort((a, b) => a.path.localeCompare(b.path));
}

function requireSystems(record: BenchmarkRecordLike): Record<SystemName, MeasuredSystem> {
  for (const name of ["dbzz", "convex", "spacetimedb"] as const) {
    if (record.systems[name] === undefined) throw new Error(`performance acceptance requires ${name}`);
  }
  return record.systems as Record<SystemName, MeasuredSystem>;
}

function indexMetrics(metrics: readonly ComparableMetric[]): Map<string, ComparableMetric> {
  return new Map(metrics.map((metric) => [metric.path, metric]));
}

function assertMetricParity(
  expected: readonly ComparableMetric[],
  actual: readonly ComparableMetric[],
  label: string,
): void {
  if (expected.length !== actual.length) {
    throw new Error(`${label} comparable metric count is ${actual.length}; expected ${expected.length}`);
  }
  const actualByPath = indexMetrics(actual);
  for (const metric of expected) {
    const candidate = actualByPath.get(metric.path);
    if (candidate === undefined) throw new Error(`${label} omitted comparable metric ${metric.path}`);
    if (candidate.direction !== metric.direction || candidate.family !== metric.family) {
      throw new Error(`${label} miswired comparable metric ${metric.path}`);
    }
  }
}

function workloadIdentity(config: DriverResult["config"]): object {
  return {
    profile: config.profile,
    seed: config.seed,
    operation: config.operation,
    connections: config.connections,
    subscriptions: config.subscriptions,
    resources: config.resources,
    seedBatchSize: config.seedBatchSize,
  };
}

function assertComparableRun(previous: BenchmarkRecordLike, current: BenchmarkRecordLike): void {
  const previousMachine = previous.machine;
  const currentMachine = current.machine;
  for (const key of ["platform", "arch", "cpu", "logicalCpus", "memGb"] as const) {
    if (previousMachine[key] !== currentMachine[key]) {
      throw new Error(`release benchmark machine ${key} differs from the prior version`);
    }
  }
  if (previous.methodology.sampleIntervalMs !== current.methodology.sampleIntervalMs) {
    throw new Error("release benchmark server-resource sampling interval differs from the prior version");
  }
  const previousSystems = requireSystems(previous);
  const currentSystems = requireSystems(current);
  const currentConfig = JSON.stringify(currentSystems.dbzz.workload.config);
  for (const name of ["dbzz", "convex", "spacetimedb"] as const) {
    if (JSON.stringify(currentSystems[name].workload.config) !== currentConfig) {
      throw new Error(`${name} release benchmark config does not match the current DBZZ config`);
    }
    if (
      JSON.stringify(workloadIdentity(previousSystems[name].workload.config)) !==
      JSON.stringify(workloadIdentity(currentSystems[name].workload.config))
    ) {
      throw new Error(`${name} release benchmark workload differs from the prior version`);
    }
  }
}

export function regressionThreshold(metric: ComparableMetric): number {
  const relative = metric.value * REGRESSION_NOISE_FLOOR_RELATIVE;
  return metric.family === "resource.cpu" ? Math.max(relative, REGRESSION_NOISE_FLOOR_CPU_CORES) : relative;
}

export function compareDbzzMetrics(
  previous: readonly ComparableMetric[],
  current: readonly ComparableMetric[],
): readonly PerformanceRegression[] {
  assertMetricParity(previous, current, "current DBZZ");
  const previousByPath = indexMetrics(previous);
  const regressions: PerformanceRegression[] = [];

  for (const metric of current) {
    const before = previousByPath.get(metric.path)!;
    const threshold = regressionThreshold(before);
    const regressed = metric.direction === "higher"
      ? metric.value < before.value - threshold
      : metric.value > before.value + threshold;
    if (!regressed) continue;
    regressions.push(Object.freeze({
      path: metric.path,
      direction: metric.direction,
      previous: before.value,
      current: metric.value,
      deltaPercent: before.value === 0 ? null : ((metric.value - before.value) / before.value) * 100,
      threshold,
    }));
  }
  return Object.freeze(regressions.sort((left, right) => left.path.localeCompare(right.path)));
}

/**
 * Release performance compares DBZZ only with the preceding final DBZZ release.
 * Convex and SpacetimeDB still run in the same Hetzner workload to keep the
 * result interpretable, but their vendor movement cannot turn into a DBZZ
 * release regression.
 */
export function evaluatePerformanceAcceptance(
  previous: BenchmarkRecordLike,
  current: BenchmarkRecordLike,
  versions: { previousVersion: string; currentVersion: string },
): PerformanceAcceptanceResult {
  assertComparableRun(previous, current);
  const previousMetrics = extractComparableMetrics(requireSystems(previous).dbzz);
  const currentMetrics = extractComparableMetrics(requireSystems(current).dbzz);
  const regressions = compareDbzzMetrics(previousMetrics, currentMetrics);
  const evidence = Object.freeze({
    schemaVersion: 1,
    previousVersion: versions.previousVersion,
    currentVersion: versions.currentVersion,
    metricCount: currentMetrics.length,
    regressions,
  } satisfies PerformanceAcceptanceEvidence);
  return Object.freeze({
    status: regressions.length === 0 ? "passed" : "recovery-needed",
    evidence,
  });
}
