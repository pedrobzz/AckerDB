import { describe, expect, test } from "bun:test";
import {
  compareDbzzMetrics,
  extractComparableMetrics,
  REGRESSION_NOISE_FLOOR_CPU_CORES,
  REGRESSION_NOISE_FLOOR_RELATIVE,
  regressionThreshold,
  retainRepeatedRegressions,
  type ComparableMetric,
  type MeasuredSystem,
  type PerformanceRegression,
} from "./performance-gates.ts";

function metric(
  path: string,
  value: number,
  direction: ComparableMetric["direction"] = "higher",
  family = "operation.throughput",
): ComparableMetric {
  return { path, value, direction, family };
}

describe("version-to-version performance recovery threshold", () => {
  test("requires a directional move beyond the 15% noise envelope", () => {
    const previous = [metric("mutation/throughput", 100)];
    expect(compareDbzzMetrics(previous, [metric("mutation/throughput", 85)])).toEqual([]);
    expect(compareDbzzMetrics(previous, [metric("mutation/throughput", 84)])).toEqual([
      expect.objectContaining({
        path: "mutation/throughput",
        previous: 100,
        current: 84,
        deltaPercent: -16,
        threshold: 15,
      }),
    ]);
  });

  test("recognizes latency and resource growth as regressions", () => {
    const previous = [
      metric("query/p95", 10, "lower", "operation.latency.p95"),
      metric("server/cpu", 0.02, "lower", "resource.cpu"),
    ];
    const regressions = compareDbzzMetrics(previous, [
      metric("query/p95", 12, "lower", "operation.latency.p95"),
      metric("server/cpu", 0.046, "lower", "resource.cpu"),
    ]);
    expect(regressions.map((regression) => regression.path)).toEqual(["query/p95", "server/cpu"]);
    expect(regressionThreshold(previous[0]!)).toBe(10 * REGRESSION_NOISE_FLOOR_RELATIVE);
    expect(regressionThreshold(previous[1]!)).toBe(REGRESSION_NOISE_FLOOR_CPU_CORES);
  });

  test("refuses to compare a changed metric contract", () => {
    expect(() => compareDbzzMetrics(
      [metric("query/throughput", 100)],
      [metric("query/throughput", 100, "lower")],
    )).toThrow("miswired comparable metric");
  });

  test("20 latency samples make only p50 statistically ready", () => {
    const sampled = (path: string, value: number, minimumSamples: number): ComparableMetric => ({
      ...metric(path, value, "lower", `operation.latency.${path}`),
      sampleCount: 20,
      minimumSamples,
    });
    const previous = [sampled("p50", 10, 20), sampled("p95", 10, 100), sampled("p99", 10, 500)];
    const current = [sampled("p50", 12, 20), sampled("p95", 12, 100), sampled("p99", 12, 500)];

    expect(compareDbzzMetrics(previous, current).map((regression) => regression.path)).toEqual(["p50"]);
  });

  test("short RSS windows gate peak but not p50", () => {
    const rssP50 = (value: number, sampleCount: number): ComparableMetric => ({
      ...metric("rss/p50", value, "lower", "resource.rss"),
      sampleCount,
      minimumSamples: 20,
    });
    const previous = [rssP50(10, 5), metric("rss/peak", 10, "lower", "resource.rss")];
    const current = [rssP50(12, 6), metric("rss/peak", 12, "lower", "resource.rss")];

    expect(compareDbzzMetrics(previous, current).map((regression) => regression.path)).toEqual(["rss/peak"]);
  });

  test("active CPU remains reported by the benchmark but is not a comparable regression metric", () => {
    const window = (sampleCount: number) => ({
      wallMs: 1_000,
      cpuSeconds: 1,
      cpuCores: 1,
      rssKind: "sumProcessRss" as const,
      rssMb: { p50: 10, peak: 12 },
      sampleCount,
      processCountPeak: 1,
    });
    const idle = window(20);
    const active = window(6);
    const system = {
      startupIdle: { window: idle },
      resources: { server: { phases: {
        "server:seeded-idle-window": idle,
        "connections:baseline-idle": idle,
        "operation:query:default:trial-0": active,
      } } },
      workload: {
        failures: [],
        snapshots: {
          seededIdlePhaseId: "server:seeded-idle-window",
          connectionBaselineIdlePhaseId: "connections:baseline-idle",
        },
        operations: [{
          operation: "query",
          profile: { name: "default" },
          medianThroughputPerSec: 100,
          medianLatencyP50Ms: 1,
          medianLatencyP95Ms: 1,
          medianLatencyP99Ms: 1,
          trials: [{ phaseId: "operation:query:default:trial-0", latency: { count: 20 } }],
        }],
        connections: [],
        subscriptions: [],
      },
    } as unknown as MeasuredSystem;

    const paths = extractComparableMetrics(system).map((entry) => entry.path);
    expect(paths).toContain("resources/startup-idle/cpuCores");
    expect(paths).toContain("operations/query/default/resources/server/rssMb/peakMax");
    expect(paths).not.toContain("operations/query/default/resources/server/cpuCoresMedian");
  });

  test("later iterations retain only regressions repeated from the immediately preceding iteration", () => {
    const regression = (path: string): PerformanceRegression => ({
      path,
      direction: "higher",
      previous: 100,
      current: 80,
      deltaPercent: -20,
      threshold: 15,
    });
    const previousIteration = [regression("query/throughput"), regression("mutation/throughput")];
    const current = [regression("mutation/throughput"), regression("procedure/throughput")];

    expect(retainRepeatedRegressions(previousIteration, current).map((entry) => entry.path))
      .toEqual(["mutation/throughput"]);
  });
});
