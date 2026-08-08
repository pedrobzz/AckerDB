/**
 * The unit of comparison. A unit is the smallest slice of the workload that one
 * side can perform end to end in a few hundred milliseconds, which is what lets
 * the pair driver alternate base and head *inside* every workload instead of
 * running one side's entire pass and then the other's. Drift, thermal ramp, and
 * a noisy neighbour then land on both sides in equal measure rather than
 * entirely on whichever side happened to run second.
 */
import {
  OPERATION_NAMES,
  subscriptionCapacitySlots,
  type BenchmarkConfig,
  type OperationName,
  type OperationProfile,
  type SubscriptionPattern,
} from "./benchmark.ts";

export type BenchUnit =
  | { readonly kind: "operation"; readonly id: string; readonly operation: OperationName; readonly profile: OperationProfile }
  | { readonly kind: "connection"; readonly id: string; readonly targetConnections: number }
  | { readonly kind: "subscription"; readonly id: string; readonly pattern: SubscriptionPattern };

/**
 * Subscriptions stay one unit per pattern rather than one per measured window:
 * a pattern's five-thousand-subscriber fleet costs more to build than the
 * windows it feeds cost to measure, so splitting the fixed-rate window from the
 * capacity ladder would pay that setup several times for no extra pairing.
 */
export function benchUnits(config: BenchmarkConfig): BenchUnit[] {
  return [
    ...OPERATION_NAMES.flatMap((operation) =>
      config.operation.profiles.map((profile): BenchUnit => ({
        kind: "operation",
        id: `operation:${operation}:${profile.name}`,
        operation,
        profile,
      }))
    ),
    ...config.connections.levels.map((targetConnections): BenchUnit => ({
      kind: "connection",
      id: `connection:${targetConnections}`,
      targetConnections,
    })),
    ...config.subscriptions.patterns.map((pattern): BenchUnit => ({
      kind: "subscription",
      id: `subscription:${pattern}`,
      pattern,
    })),
  ];
}

/**
 * Which commit performs a unit first on a given repetition. Going first is
 * measurably different from going second — the leader meets a machine the
 * other side has just finished using — so the lead alternates, and over an even
 * number of repetitions each side leads exactly half of them. The cost of the
 * leading slot then cancels inside a single run.
 *
 * The order used to be a coin derived from the head commit's SHA. That is
 * constant across every rerun of the same pull request, so the randomisation it
 * existed to provide never happened: it decided once, permanently per commit,
 * which side would be charged for running second.
 */
export function leadingSide(repetition: number): "base" | "head" {
  return repetition % 2 === 0 ? "base" : "head";
}

/** One named number a unit produces, paired against the other side's value for the same name. */
export interface UnitMetric {
  readonly name: string;
  readonly value: number;
}

export interface MetricPolicy {
  readonly better: "higher" | "lower";
  /** Whether a regression in this metric alone fails the check. */
  readonly gated: boolean;
  readonly note?: string;
}

/**
 * Policy lives here rather than beside each measurement so that a metric's
 * direction and gating are decided once, by name, for every unit that emits it.
 * `report.ts` refuses to render a metric the table does not know, so a new
 * measurement cannot enter the comparison without someone deciding whether a
 * move in it should stop a merge.
 */
export const METRIC_POLICY: Readonly<Record<string, MetricPolicy>> = Object.freeze({
  "throughput/s": { better: "higher", gated: true },
  "p50 ms": { better: "lower", gated: true },
  "p95 ms": { better: "lower", gated: true },
  "p99 ms": {
    better: "lower",
    gated: false,
    note: "the noisiest statistic in the set: one scheduling stall in a few thousand operations moves it, so it is reported for reading and never gates",
  },
  "ready/s": { better: "higher", gated: true },
  "ready p50 ms": { better: "lower", gated: true },
  "ready p95 ms": {
    better: "lower",
    gated: false,
    note: "connect readiness carries a scheduling tail that belongs to the host, not to the change",
  },
  "updates/s": { better: "higher", gated: true },
  "deliveries/s": { better: "higher", gated: true },
  "delivery p50 ms": { better: "lower", gated: true },
  "delivery p95 ms": { better: "lower", gated: true },
  "delivery p99 ms": { better: "lower", gated: false, note: "see p99 ms" },
  "ack p50 ms": { better: "lower", gated: true },
  "ack p95 ms": { better: "lower", gated: true },
  "all p50 ms": { better: "lower", gated: true },
  "all p95 ms": { better: "lower", gated: true },
  "all p99 ms": { better: "lower", gated: false, note: "see p99 ms" },
});

export function metricPolicy(name: string): MetricPolicy {
  const policy = METRIC_POLICY[/^\d+ writers\/(.+)$/.exec(name)?.[1] ?? name];
  if (policy === undefined) {
    throw new Error(
      `benchmark metric ${JSON.stringify(name)} has no direction or gating policy in bench/units.ts`,
    );
  }
  return policy;
}

/** Capacity metrics are namespaced by writer slots so the policy suffix still resolves. */
export function capacityMetricName(slots: number, metric: string): string {
  return `${slots} writers/${metric}`;
}

/**
 * What the head commit owes the comparison but did not deliver. Silence is not
 * agreement: a unit that stops emitting a metric, or that pairs fewer
 * repetitions than the run asked for, shrinks the comparison until there is
 * nothing left to regress. Every absence is named so it can fail the check
 * instead of quietly passing it.
 */
export function contractShortfalls(
  config: BenchmarkConfig,
  repetitions: number,
  series: readonly { readonly unitId: string; readonly metric: string; readonly samples: readonly unknown[] }[],
): string[] {
  const present = new Map(series.map((entry) => [`${entry.unitId} ${entry.metric}`, entry]));
  const shortfalls: string[] = [];
  for (const unit of benchUnits(config)) {
    for (const metric of expectedUnitMetricNames(config, unit)) {
      const entry = present.get(`${unit.id} ${metric}`);
      if (entry === undefined) {
        shortfalls.push(`${unit.id} never produced ${metric}`);
      } else if (entry.samples.length !== repetitions) {
        shortfalls.push(`${unit.id} ${metric} paired ${entry.samples.length} of ${repetitions} repetitions`);
      }
    }
  }
  return shortfalls;
}

export function expectedUnitMetricNames(config: BenchmarkConfig, unit: BenchUnit): string[] {
  if (unit.kind === "operation") return ["throughput/s", "p50 ms", "p95 ms", "p99 ms"];
  if (unit.kind === "connection") {
    return ["ready/s", "ready p50 ms", "ready p95 ms", "throughput/s", "p50 ms", "p95 ms", "p99 ms"];
  }
  return [
    "updates/s",
    "deliveries/s",
    "delivery p50 ms",
    "delivery p95 ms",
    "delivery p99 ms",
    ...subscriptionCapacitySlots(config.subscriptions, unit.pattern).flatMap((slots) => [
      capacityMetricName(slots, "updates/s"),
      capacityMetricName(slots, "deliveries/s"),
      capacityMetricName(slots, "ack p50 ms"),
      capacityMetricName(slots, "ack p95 ms"),
      capacityMetricName(slots, "all p50 ms"),
      capacityMetricName(slots, "all p95 ms"),
      capacityMetricName(slots, "all p99 ms"),
    ]),
  ];
}
