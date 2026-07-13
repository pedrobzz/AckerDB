import { createHash } from "node:crypto";
import type {
  DriverResult,
  LatencyStats,
  SubscriptionCapacityResult,
  SubscriptionResult,
  SystemName,
} from "./benchmark.ts";
import type { ProcessTreeWindowSummary } from "./process-tree.ts";

export const FROZEN_BASELINE_PATH = "bench/results/2026-07-13T15-34-33Z-74d8554.json";
export const FROZEN_BASELINE_SHA256 = "ab78ada0d9d16576b7aca175c1230c456064bcf5b4a80e66b5e1c55a4528a474";
export const FROZEN_METRICS_PER_SYSTEM = 351;
export const FROZEN_DBZZ_SPACETIME_WINS = 273;
export const FROZEN_CONVEX_FLOORS = 126;

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

export interface FrozenWinEvidence {
  path: string;
  direction: MetricDirection;
  baselineDbzz: number;
  baselineSpacetime: number;
  afterDbzz: number;
  afterSpacetime: number;
  passed: true;
}

export interface FloorEvidence {
  path: string;
  rule: string;
  dbzz: number;
  convex: number;
  limit: number;
  passed: true;
}

export interface PerformanceAcceptanceEvidence {
  schemaVersion: 1;
  passed: true;
  baseline: {
    path: typeof FROZEN_BASELINE_PATH;
    sha256: string;
    schemaVersion: 3;
    timestamp: string;
    gitCommit: string;
    sourceHash: string;
    machineFingerprint: string;
    configSha256: string;
  };
  metricCounts: {
    baselinePerSystem: Record<SystemName, number>;
    afterPerSystem: Record<SystemName, number>;
    frozenDbzzSpacetimeWins: number;
    convexFloorChecks: number;
  };
  frozenDbzzSpacetimeWins: FrozenWinEvidence[];
  convexFloors: FloorEvidence[];
  partitionedFixedRate: {
    offeredUpdatesPerSec: number;
    offeredUpdates: number;
    completedUpdates: number;
    expectedDeliveries: number;
    observedDeliveries: number;
    deliveryTargetPerSec: number;
    deliveryThroughputPerSec: number;
    minimumMeasuredDeliveryPerSec: number;
    passed: true;
  };
  exclusions: readonly { metric: string; reason: string }[];
}

export const PERFORMANCE_EXCLUSIONS = Object.freeze([
  {
    metric: "load-generator RSS and CPU",
    reason: "SDK/client process architectures differ; acceptance compares the separately sampled server process trees only",
  },
  {
    metric: "instantaneous resource snapshots",
    reason: "timed server windows are comparable and stable; snapshots are boundary diagnostics already retained in the raw record",
  },
  {
    metric: "latency min, max, and sample count",
    reason: "the frozen contract explicitly compares p50, p95, and p99; extrema and counts remain correctness diagnostics",
  },
  {
    metric: "attempt, completion, delivery, and error counters",
    reason: "assertValidResults gates these as correctness before performance acceptance, so they are not directional performance metrics",
  },
  {
    metric: "process-count peaks and RSS deltas",
    reason: "absolute timed-window server RSS is the portable resource metric; process topology and derived deltas are implementation-specific",
  },
  {
    metric: "empty startup, seeded-idle, and pre-connection/subscription baseline RSS in the Convex margin floor",
    reason: "the frozen 50% floor is for loaded operation, connection, and subscription plateaus; idle RSS remains comparable and frozen against prior SpacetimeDB wins",
  },
] as const);

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
  const offeredUpdates = (durationMs / 1_000) * offeredUpdatesPerSec;
  return result.correctness.ok &&
    result.updates === offeredUpdates &&
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

function strictWin(left: ComparableMetric, right: ComparableMetric): boolean {
  return left.direction === "higher" ? left.value > right.value : left.value < right.value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function machineFingerprint(record: BenchmarkRecordLike): string {
  return sha256(JSON.stringify(record.machine));
}

function configSha256(record: BenchmarkRecordLike): string {
  const systems = requireSystems(record);
  return sha256(JSON.stringify({
    sampleIntervalMs: record.methodology.sampleIntervalMs,
    systems: (["dbzz", "convex", "spacetimedb"] as const).map((name) => systems[name].workload.config),
  }));
}

function assertComparableRun(baseline: BenchmarkRecordLike, after: BenchmarkRecordLike): void {
  if (JSON.stringify(after.machine) !== JSON.stringify(baseline.machine)) {
    throw new Error("after-run machine does not match the frozen baseline machine");
  }
  if (after.methodology.sampleIntervalMs !== baseline.methodology.sampleIntervalMs) {
    throw new Error("after-run server resource sampling interval does not match the frozen baseline");
  }
  const baselineSystems = requireSystems(baseline);
  const afterSystems = requireSystems(after);
  for (const name of ["dbzz", "convex", "spacetimedb"] as const) {
    if (JSON.stringify(afterSystems[name].workload.config) !== JSON.stringify(baselineSystems[name].workload.config)) {
      throw new Error(`${name} after-run config does not match the frozen baseline`);
    }
  }
}

function floorCheck(
  evidence: FloorEvidence[],
  dbzz: ComparableMetric,
  convex: ComparableMetric,
  rule: string,
  factor: number,
): void {
  const limit = convex.value * factor;
  const passed = dbzz.direction === "higher" ? dbzz.value >= limit : dbzz.value <= limit;
  if (!passed) {
    throw new Error(
      `Convex floor failed at ${dbzz.path}: DBZZ ${dbzz.value} must be ${dbzz.direction === "higher" ? ">=" : "<="} ${limit} (${rule})`,
    );
  }
  evidence.push({ path: dbzz.path, rule, dbzz: dbzz.value, convex: convex.value, limit, passed: true });
}

export function assertPerformanceAcceptance(
  after: BenchmarkRecordLike,
  frozenBaselineJson: string,
): PerformanceAcceptanceEvidence {
  const baselineDigest = sha256(frozenBaselineJson);
  if (baselineDigest !== FROZEN_BASELINE_SHA256) {
    throw new Error(`frozen benchmark baseline digest is ${baselineDigest}; expected ${FROZEN_BASELINE_SHA256}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(frozenBaselineJson);
  } catch (error) {
    throw new Error("frozen benchmark baseline is not valid JSON", { cause: error });
  }
  const baseline = parsed as BenchmarkRecordLike;
  if (baseline.schemaVersion !== 3 || baseline.git?.commit !== "74d8554") {
    throw new Error("frozen benchmark baseline identity is invalid");
  }
  if (after.schemaVersion !== 4) throw new Error("performance acceptance requires an after-run schema-v4 record");
  assertComparableRun(baseline, after);
  const baselineSystems = requireSystems(baseline);
  const afterSystems = requireSystems(after);
  const baselineMetrics = {} as Record<SystemName, ComparableMetric[]>;
  const afterMetrics = {} as Record<SystemName, ComparableMetric[]>;
  for (const name of ["dbzz", "convex", "spacetimedb"] as const) {
    baselineMetrics[name] = extractComparableMetrics(baselineSystems[name]);
    afterMetrics[name] = extractComparableMetrics(afterSystems[name]);
    if (baselineMetrics[name].length !== FROZEN_METRICS_PER_SYSTEM) {
      throw new Error(
        `baseline ${name} comparable metric count is ${baselineMetrics[name].length}; expected frozen count ${FROZEN_METRICS_PER_SYSTEM}`,
      );
    }
    assertMetricParity(baselineMetrics.dbzz ?? baselineMetrics[name], baselineMetrics[name], `baseline ${name}`);
    assertMetricParity(baselineMetrics[name], afterMetrics[name], `after ${name}`);
  }

  const baselineDbzz = indexMetrics(baselineMetrics.dbzz);
  const baselineSpacetime = indexMetrics(baselineMetrics.spacetimedb);
  const afterDbzz = indexMetrics(afterMetrics.dbzz);
  const afterSpacetime = indexMetrics(afterMetrics.spacetimedb);
  const frozenWins: FrozenWinEvidence[] = [];
  for (const [path, dbzz] of baselineDbzz) {
    const spacetime = baselineSpacetime.get(path)!;
    if (!strictWin(dbzz, spacetime)) continue;
    const currentDbzz = afterDbzz.get(path)!;
    const currentSpacetime = afterSpacetime.get(path)!;
    if (!strictWin(currentDbzz, currentSpacetime)) {
      throw new Error(
        `frozen DBZZ-over-SpacetimeDB win lost at ${path}: ${currentDbzz.value} vs ${currentSpacetime.value}`,
      );
    }
    frozenWins.push({
      path,
      direction: dbzz.direction,
      baselineDbzz: dbzz.value,
      baselineSpacetime: spacetime.value,
      afterDbzz: currentDbzz.value,
      afterSpacetime: currentSpacetime.value,
      passed: true,
    });
  }
  if (frozenWins.length !== FROZEN_DBZZ_SPACETIME_WINS) {
    throw new Error(
      `frozen baseline derives ${frozenWins.length} DBZZ-over-SpacetimeDB wins; expected ${FROZEN_DBZZ_SPACETIME_WINS}`,
    );
  }

  const convexByPath = indexMetrics(afterMetrics.convex);
  const floors: FloorEvidence[] = [];
  for (const metric of afterMetrics.dbzz) {
    const convex = convexByPath.get(metric.path)!;
    if (metric.family === "operation.throughput" || metric.family === "connection.work.throughput") {
      floorCheck(floors, metric, convex, ">=5x throughput", 5);
    } else if (metric.family === "operation.latency.p95" || metric.family === "connection.work.latency.p95") {
      floorCheck(floors, metric, convex, "<=50% p95 latency", 0.5);
    } else if (
      metric.family === "subscription.fixed.delivery.throughput" &&
      metric.path.startsWith("subscriptions/shared/")
    ) {
      floorCheck(floors, metric, convex, ">=1.25x shared fixed-rate delivery throughput", 1.25);
    } else if (
      (metric.family === "subscription.fixed.delivery.p95" ||
        metric.family === "subscription.capacity.delivery.p95") &&
      metric.offeredWorkComplete === true &&
      convex.offeredWorkComplete === true
    ) {
      floorCheck(floors, metric, convex, "<=50% delivery p95 with complete offered work", 0.5);
    } else if (metric.family === "resource.rss" && metric.convexRssFloor === true) {
      floorCheck(floors, metric, convex, "<=50% comparable server RSS", 0.5);
    }
  }
  const partitioned = afterSystems.dbzz.workload.subscriptions.find((item) => item.pattern === "partitioned");
  if (partitioned === undefined) throw new Error("DBZZ after-run omits partitioned fixed-rate subscriptions");
  const config = afterSystems.dbzz.workload.config.subscriptions;
  const offeredUpdates = (config.durationMs / 1_000) * config.partitionedUpdatesPerSec;
  const deliveryTarget = partitioned.expectedDeliveries / (config.durationMs / 1_000);
  const minimumDelivery = deliveryTarget * 0.99;
  if (
    !fixedRateComplete(partitioned, config.durationMs, config.partitionedUpdatesPerSec) ||
    partitioned.updateThroughputPerSec < config.partitionedUpdatesPerSec ||
    partitioned.deliveryThroughputPerSec < minimumDelivery
  ) {
    throw new Error(
      `partitioned fixed-rate offered target failed: ${partitioned.deliveryThroughputPerSec}/s, expected at least ${minimumDelivery}/s with exact completion`,
    );
  }
  if (floors.length !== FROZEN_CONVEX_FLOORS) {
    throw new Error(`after-run evaluated ${floors.length} Convex floors; expected ${FROZEN_CONVEX_FLOORS}`);
  }

  return {
    schemaVersion: 1,
    passed: true,
    baseline: {
      path: FROZEN_BASELINE_PATH,
      sha256: baselineDigest,
      schemaVersion: 3,
      timestamp: baseline.timestamp,
      gitCommit: baseline.git.commit,
      sourceHash: baseline.git.sourceHash,
      machineFingerprint: machineFingerprint(baseline),
      configSha256: configSha256(baseline),
    },
    metricCounts: {
      baselinePerSystem: {
        dbzz: baselineMetrics.dbzz.length,
        convex: baselineMetrics.convex.length,
        spacetimedb: baselineMetrics.spacetimedb.length,
      },
      afterPerSystem: {
        dbzz: afterMetrics.dbzz.length,
        convex: afterMetrics.convex.length,
        spacetimedb: afterMetrics.spacetimedb.length,
      },
      frozenDbzzSpacetimeWins: frozenWins.length,
      convexFloorChecks: floors.length,
    },
    frozenDbzzSpacetimeWins: frozenWins,
    convexFloors: floors,
    partitionedFixedRate: {
      offeredUpdatesPerSec: config.partitionedUpdatesPerSec,
      offeredUpdates,
      completedUpdates: partitioned.updates,
      expectedDeliveries: partitioned.expectedDeliveries,
      observedDeliveries: partitioned.observedDeliveries,
      deliveryTargetPerSec: deliveryTarget,
      deliveryThroughputPerSec: partitioned.deliveryThroughputPerSec,
      minimumMeasuredDeliveryPerSec: minimumDelivery,
      passed: true,
    },
    exclusions: PERFORMANCE_EXCLUSIONS,
  };
}
