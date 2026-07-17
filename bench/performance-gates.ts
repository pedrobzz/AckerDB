import { createHash } from "node:crypto";
import {
  offeredFixedRateUpdates,
  type DriverResult,
  type LatencyStats,
  type SubscriptionResult,
  type SubscriptionCapacityResult,
  type SystemName,
} from "./benchmark.ts";
import type { ProcessTreeWindowSummary } from "./process-tree.ts";
import type { BenchmarkValidation } from "./result-validation.ts";

export const FROZEN_BASELINE_PATH = "bench/results/2026-07-13T15-34-33Z-74d8554.json";
export const FROZEN_BASELINE_SHA256 = "ab78ada0d9d16576b7aca175c1230c456064bcf5b4a80e66b5e1c55a4528a474";
export const FROZEN_METRICS_PER_SYSTEM = 351;
export const FROZEN_DBZZ_SPACETIME_WINS = 273;
export const FROZEN_NEAR_TIE_WINS = 22;
export const FROZEN_CONVEX_FLOORS = 126;

/**
 * Run-to-run measurement noise floor from the repo benchmark doctrine:
 * percentiles move ±15% between runs on this hardware, and a real regression
 * shows a consistent direction across metrics and runs rather than a
 * single-draw flip. The doctrine quantifies 15% for latency percentiles; it
 * is adopted as the single repo-derived bound for every family rather than
 * inventing uncalibrated per-family numbers. The exposure this creates is
 * bounded and non-compounding: a near-tie path can drift at most one
 * envelope behind current SpacetimeDB — roughly its baseline margin plus
 * the floor, once — before the gate fails, and every near-tie margin is
 * printed and recorded on every accepted run, unlike the strict gate, which
 * surfaced nothing until a flip. Applied as a fraction of the SpacetimeDB
 * value on the same path.
 */
export const NOISE_FLOOR_RELATIVE = 0.15;
/**
 * Absolute noise floor for the resource.cpu family only. A windowed cpuCores
 * value is the difference of two ps cputime readings quantized to 10 ms and
 * interpolated across 250 ms sample spacing, so an idle plateau a few seconds
 * long resolves one system only to several milli-cores, and the repo's own
 * back-to-back full runs move individual idle readings by ~12 milli-cores.
 * A DBZZ-versus-SpacetimeDB difference therefore swings ~25 milli-cores with
 * no code change. The absolute floor governs only windows below
 * NOISE_FLOOR_CPU_CORES / NOISE_FLOOR_RELATIVE ≈ 0.17 cores — idle plateaus —
 * while loaded CPU windows (0.5–1.0+ cores) stay on the relative envelope.
 */
export const NOISE_FLOOR_CPU_CORES = 0.025;

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

export type FrozenWinClassification = "solid" | "near-tie";

export interface FrozenWinEvidence {
  path: string;
  direction: MetricDirection;
  /** Derived from the frozen baseline only: "near-tie" iff the baseline win margin is below the measurement noise floor. */
  classification: FrozenWinClassification;
  baselineDbzz: number;
  baselineSpacetime: number;
  afterDbzz: number;
  afterSpacetime: number;
  /** Deficit versus current SpacetimeDB this path may show before failing: 0 for solid wins (strict), the noise envelope for near-ties. */
  noiseAllowance: number;
  passed: boolean;
}

export interface FloorEvidence {
  path: string;
  rule: string;
  dbzz: number;
  convex: number;
  limit: number;
  passed: boolean;
}

export interface FixedRateEvidence {
  offeredUpdatesPerSec: number;
  offeredUpdates: number;
  completedUpdates: number;
  expectedDeliveries: number;
  observedDeliveries: number;
  deliveryTargetPerSec: number;
  deliveryThroughputPerSec: number;
  minimumMeasuredDeliveryPerSec: number;
  passed: boolean;
}

export interface PerformanceAcceptanceEvidence {
  schemaVersion: 3;
  passed: boolean;
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
    frozenNearTieWins: number;
    convexFloorChecks: number;
  };
  frozenDbzzSpacetimeWins: readonly FrozenWinEvidence[];
  convexFloors: readonly FloorEvidence[];
  sharedFixedRate: FixedRateEvidence;
  partitionedFixedRate: FixedRateEvidence;
  exclusions: readonly { metric: string; reason: string }[];
}

export interface PerformanceAcceptanceFailure {
  readonly kind: "frozen-win" | "convex-floor" | "fixed-rate";
  readonly path: string;
  readonly message: string;
}

export type PerformanceAcceptanceResult =
  | {
      readonly status: "passed" | "failed";
      readonly evidence: PerformanceAcceptanceEvidence;
      readonly failures: readonly PerformanceAcceptanceFailure[];
    }
  | {
      readonly status: "not-evaluated";
      readonly reason: "correctness-failed" | "current-host-comparison";
    };

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
    reason: "benchmark validation records these as correctness before performance acceptance, so they are not directional performance metrics",
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

/**
 * Both fixed-rate patterns must complete the offered workload at the offered
 * rate. This hard floor is what keeps the fixed-rate throughput near-ties
 * honest: the noise envelope tolerates a bounded ranking flip against
 * SpacetimeDB, never a failure to sustain the offered load itself.
 */
function evaluateFixedRateOfferedTarget(
  system: MeasuredSystem,
  pattern: "shared" | "partitioned",
  failures: PerformanceAcceptanceFailure[],
): FixedRateEvidence {
  const result = system.workload.subscriptions.find((item) => item.pattern === pattern);
  if (result === undefined) throw new Error(`DBZZ after-run omits ${pattern} fixed-rate subscriptions`);
  const config = system.workload.config.subscriptions;
  const offeredPerSec = pattern === "shared" ? config.sharedUpdatesPerSec : config.partitionedUpdatesPerSec;
  const offeredUpdates = offeredFixedRateUpdates(config.durationMs, offeredPerSec);
  // the realized offered rate: the discrete update count the workload emits
  // over the exact window, which equals the configured rate whenever the
  // window is a whole number of seconds
  const realizedOfferedPerSec = offeredUpdates / (config.durationMs / 1_000);
  const deliveryTarget = result.expectedDeliveries / (config.durationMs / 1_000);
  const minimumDelivery = deliveryTarget * 0.99;
  const failed =
    !fixedRateComplete(result, config.durationMs, offeredPerSec) ||
    result.updateThroughputPerSec < realizedOfferedPerSec ||
    result.deliveryThroughputPerSec < minimumDelivery;
  if (failed) {
    failures.push(Object.freeze({
      kind: "fixed-rate",
      path: `subscriptions/${pattern}/fixed-rate`,
      message:
        `${pattern} fixed-rate offered target failed: ${result.deliveryThroughputPerSec}/s, ` +
        `expected at least ${minimumDelivery}/s with exact completion`,
    }));
  }
  return {
    offeredUpdatesPerSec: offeredPerSec,
    offeredUpdates,
    completedUpdates: result.updates,
    expectedDeliveries: result.expectedDeliveries,
    observedDeliveries: result.observedDeliveries,
    deliveryTargetPerSec: deliveryTarget,
    deliveryThroughputPerSec: result.deliveryThroughputPerSec,
    minimumMeasuredDeliveryPerSec: minimumDelivery,
    passed: !failed,
  };
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

function strictWin(left: ComparableMetric, right: ComparableMetric): boolean {
  return left.direction === "higher" ? left.value > right.value : left.value < right.value;
}

/** Signed DBZZ advantage over SpacetimeDB in the metric's own units; positive means DBZZ is ahead. */
function signedAdvantage(dbzz: ComparableMetric, spacetime: ComparableMetric): number {
  return dbzz.direction === "higher" ? dbzz.value - spacetime.value : spacetime.value - dbzz.value;
}

/** The measurement-noise envelope for one path, in the metric's own units. */
export function noiseAllowance(family: string, spacetimeValue: number): number {
  const relative = NOISE_FLOOR_RELATIVE * spacetimeValue;
  return family === "resource.cpu" ? Math.max(relative, NOISE_FLOOR_CPU_CORES) : relative;
}

/**
 * Classify a frozen baseline win. A baseline margin below the noise envelope
 * was a coin flip when it was frozen, so demanding a strict win on every
 * after-run re-flips that coin; such paths become bounded near-tie
 * obligations instead. Margins at or above the envelope stay strict.
 */
export function classifyFrozenWin(dbzz: ComparableMetric, spacetime: ComparableMetric): FrozenWinClassification {
  if (!strictWin(dbzz, spacetime)) throw new Error(`${dbzz.path} is not a frozen baseline win`);
  return signedAdvantage(dbzz, spacetime) < noiseAllowance(dbzz.family, spacetime.value) ? "near-tie" : "solid";
}

/** Compact near-tie drift table: baseline versus current margins, so within-floor drift stays visible run-over-run. */
export function nearTieDriftTable(wins: readonly FrozenWinEvidence[]): string {
  const margin = (dbzz: number, spacetime: number, direction: MetricDirection): string => {
    if (spacetime === 0) return "n/a";
    const fraction = (direction === "higher" ? dbzz - spacetime : spacetime - dbzz) / spacetime;
    return `${fraction >= 0 ? "+" : ""}${(fraction * 100).toFixed(1)}%`;
  };
  const rows = wins
    .filter((win) => win.classification === "near-tie")
    .map((win) =>
      `  ${win.path.padEnd(62)} baseline ${margin(win.baselineDbzz, win.baselineSpacetime, win.direction).padStart(7)}` +
      `  current ${margin(win.afterDbzz, win.afterSpacetime, win.direction).padStart(7)}` +
      `  (${win.afterDbzz.toPrecision(4)} vs ${win.afterSpacetime.toPrecision(4)}, allowed deficit ${win.noiseAllowance.toPrecision(3)})`,
    );
  return [
    `near-tie frozen wins (baseline margin below measurement noise; a deficit beyond the floor fails the run):`,
    ...rows,
  ].join("\n");
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

function workloadIdentity(config: DriverResult["config"]): object {
  return {
    profile: config.profile,
    seed: config.seed,
    operation: {
      drainTimeoutMs: config.operation.drainTimeoutMs,
      profiles: config.operation.profiles,
    },
    connections: {
      levels: config.connections.levels,
      batchSize: config.connections.batchSize,
      timeoutMs: config.connections.timeoutMs,
    },
    subscriptions: {
      users: config.subscriptions.users,
      queriesPerUser: config.subscriptions.queriesPerUser,
      sharedUpdatesPerSec: config.subscriptions.sharedUpdatesPerSec,
      partitionedUpdatesPerSec: config.subscriptions.partitionedUpdatesPerSec,
      capacitySlots: config.subscriptions.capacitySlots,
      setupTimeoutMs: config.subscriptions.setupTimeoutMs,
      drainTimeoutMs: config.subscriptions.drainTimeoutMs,
      patterns: config.subscriptions.patterns,
    },
    seedBatchSize: config.seedBatchSize,
  };
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
  const afterConfig = JSON.stringify(afterSystems.dbzz.workload.config);
  for (const name of ["dbzz", "convex", "spacetimedb"] as const) {
    if (JSON.stringify(afterSystems[name].workload.config) !== afterConfig) {
      throw new Error(`${name} after-run config does not match the current DBZZ config`);
    }
    if (
      JSON.stringify(workloadIdentity(afterSystems[name].workload.config)) !==
        JSON.stringify(workloadIdentity(baselineSystems[name].workload.config))
    ) {
      throw new Error(`${name} after-run workload identity does not match the frozen baseline`);
    }
  }
}

function floorCheck(
  evidence: FloorEvidence[],
  failures: PerformanceAcceptanceFailure[],
  dbzz: ComparableMetric,
  convex: ComparableMetric,
  rule: string,
  factor: number,
  comparable = true,
): void {
  const limit = convex.value * factor;
  if (!comparable) {
    failures.push(Object.freeze({
      kind: "convex-floor",
      path: dbzz.path,
      message: `Convex floor could not be evaluated at ${dbzz.path}: offered work was incomplete`,
    }));
    evidence.push({ path: dbzz.path, rule, dbzz: dbzz.value, convex: convex.value, limit, passed: false });
    return;
  }
  const passed = dbzz.direction === "higher" ? dbzz.value >= limit : dbzz.value <= limit;
  if (!passed) {
    failures.push(Object.freeze({
      kind: "convex-floor",
      path: dbzz.path,
      message:
        `Convex floor failed at ${dbzz.path}: DBZZ ${dbzz.value} must be ` +
        `${dbzz.direction === "higher" ? ">=" : "<="} ${limit} (${rule})`,
    }));
  }
  evidence.push({ path: dbzz.path, rule, dbzz: dbzz.value, convex: convex.value, limit, passed });
}

function evaluateMeasuredPerformance(
  after: BenchmarkRecordLike,
  frozenBaselineJson: string,
): {
  readonly evidence: PerformanceAcceptanceEvidence;
  readonly failures: readonly PerformanceAcceptanceFailure[];
} {
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
  if (after.schemaVersion !== 7) throw new Error("performance acceptance requires an after-run schema-v7 record");
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
  const failures: PerformanceAcceptanceFailure[] = [];
  for (const [path, dbzz] of baselineDbzz) {
    const spacetime = baselineSpacetime.get(path)!;
    if (!strictWin(dbzz, spacetime)) continue;
    const currentDbzz = afterDbzz.get(path)!;
    const currentSpacetime = afterSpacetime.get(path)!;
    const classification = classifyFrozenWin(dbzz, spacetime);
    const allowance = classification === "near-tie" ? noiseAllowance(dbzz.family, currentSpacetime.value) : 0;
    const passed = classification === "solid"
      ? strictWin(currentDbzz, currentSpacetime)
      : signedAdvantage(currentDbzz, currentSpacetime) >= -allowance;
    if (!passed) {
      failures.push(Object.freeze({
        kind: "frozen-win",
        path,
        message: classification === "solid"
          ? `frozen DBZZ-over-SpacetimeDB win lost at ${path}: ${currentDbzz.value} vs ${currentSpacetime.value}`
          : `frozen near-tie DBZZ-over-SpacetimeDB win reversed beyond the noise floor at ${path}: ` +
            `${currentDbzz.value} vs ${currentSpacetime.value} (allowed deficit ${allowance})`,
      }));
    }
    frozenWins.push({
      path,
      direction: dbzz.direction,
      classification,
      baselineDbzz: dbzz.value,
      baselineSpacetime: spacetime.value,
      afterDbzz: currentDbzz.value,
      afterSpacetime: currentSpacetime.value,
      noiseAllowance: allowance,
      passed,
    });
  }
  if (frozenWins.length !== FROZEN_DBZZ_SPACETIME_WINS) {
    throw new Error(
      `frozen baseline derives ${frozenWins.length} DBZZ-over-SpacetimeDB wins; expected ${FROZEN_DBZZ_SPACETIME_WINS}`,
    );
  }
  const nearTieWins = frozenWins.filter((win) => win.classification === "near-tie").length;
  if (nearTieWins !== FROZEN_NEAR_TIE_WINS) {
    throw new Error(
      `frozen baseline derives ${nearTieWins} near-tie DBZZ-over-SpacetimeDB wins; expected ${FROZEN_NEAR_TIE_WINS}`,
    );
  }

  const convexByPath = indexMetrics(afterMetrics.convex);
  const floors: FloorEvidence[] = [];
  for (const metric of afterMetrics.dbzz) {
    const convex = convexByPath.get(metric.path)!;
    if (metric.family === "operation.throughput" || metric.family === "connection.work.throughput") {
      floorCheck(floors, failures, metric, convex, ">=5x throughput", 5);
    } else if (metric.family === "operation.latency.p95" || metric.family === "connection.work.latency.p95") {
      floorCheck(floors, failures, metric, convex, "<=50% p95 latency", 0.5);
    } else if (
      metric.family === "subscription.fixed.delivery.throughput" &&
      metric.path.startsWith("subscriptions/shared/")
    ) {
      floorCheck(floors, failures, metric, convex, ">=1.25x shared fixed-rate delivery throughput", 1.25);
    } else if (
      metric.family === "subscription.fixed.delivery.p95" ||
      metric.family === "subscription.capacity.delivery.p95"
    ) {
      floorCheck(
        floors,
        failures,
        metric,
        convex,
        "<=50% delivery p95 with complete offered work",
        0.5,
        metric.offeredWorkComplete === true && convex.offeredWorkComplete === true,
      );
    } else if (metric.family === "resource.rss" && metric.convexRssFloor === true) {
      floorCheck(floors, failures, metric, convex, "<=50% comparable server RSS", 0.5);
    }
  }
  const sharedFixedRate = evaluateFixedRateOfferedTarget(afterSystems.dbzz, "shared", failures);
  const partitionedFixedRate = evaluateFixedRateOfferedTarget(afterSystems.dbzz, "partitioned", failures);
  if (floors.length !== FROZEN_CONVEX_FLOORS) {
    throw new Error(`after-run evaluated ${floors.length} Convex floors; expected ${FROZEN_CONVEX_FLOORS}`);
  }

  const evidence = Object.freeze({
    schemaVersion: 3,
    passed: failures.length === 0,
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
      frozenNearTieWins: nearTieWins,
      convexFloorChecks: floors.length,
    },
    frozenDbzzSpacetimeWins: Object.freeze(frozenWins.map((win) => Object.freeze(win))),
    convexFloors: Object.freeze(floors.map((floor) => Object.freeze(floor))),
    sharedFixedRate,
    partitionedFixedRate,
    exclusions: PERFORMANCE_EXCLUSIONS,
  } satisfies PerformanceAcceptanceEvidence);
  return Object.freeze({ evidence, failures: Object.freeze(failures) });
}

export function evaluatePerformanceAcceptance(
  after: BenchmarkRecordLike,
  frozenBaselineJson: string,
  validation: BenchmarkValidation,
): PerformanceAcceptanceResult {
  if (validation.status === "failed") {
    return Object.freeze({ status: "not-evaluated", reason: "correctness-failed" });
  }
  const { evidence, failures } = evaluateMeasuredPerformance(after, frozenBaselineJson);
  return Object.freeze({
    status: failures.length === 0 ? "passed" : "failed",
    evidence,
    failures,
  });
}
