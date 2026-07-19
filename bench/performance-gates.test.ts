import { describe, expect, test } from "bun:test";
import {
  compareDbzzMetrics,
  REGRESSION_NOISE_FLOOR_CPU_CORES,
  REGRESSION_NOISE_FLOOR_RELATIVE,
  regressionThreshold,
  type ComparableMetric,
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
});
