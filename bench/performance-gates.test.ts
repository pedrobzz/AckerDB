import { describe, expect, test } from "bun:test";
import {
  compareDbzzMetrics,
  extractComparableMetrics,
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

  test("recognizes latency growth as a regression", () => {
    const previous = [metric("query/p95", 10, "lower", "operation.latency.p95")];
    const regressions = compareDbzzMetrics(previous, [metric("query/p95", 12, "lower", "operation.latency.p95")]);
    expect(regressions.map((regression) => regression.path)).toEqual(["query/p95"]);
    expect(regressionThreshold(previous[0]!)).toBe(10 * REGRESSION_NOISE_FLOOR_RELATIVE);
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

  test("resource measurements remain raw evidence and never become comparable metrics", () => {
    const window = {
      wallMs: 1_000,
      cpuSeconds: 1,
      cpuCores: 1,
      rssKind: "sumProcessRss" as const,
      rssMb: { p50: 10, peak: 12 },
      sampleCount: 20,
      processCountPeak: 1,
    };
    const system = {
      startupIdle: { window },
      resources: { server: { phases: { "server:seeded-idle-window": window } } },
      workload: {
        failures: [],
        operations: [],
        connections: [],
        subscriptions: [],
      },
    } as unknown as MeasuredSystem;

    const metrics = extractComparableMetrics(system);
    expect(metrics.some((entry) => entry.family.startsWith("resource.") || entry.path.includes("resources/"))).toBe(false);
    expect(system.startupIdle.window).toEqual(window);
    expect(system.resources.server.phases["server:seeded-idle-window"]).toEqual(window);
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
