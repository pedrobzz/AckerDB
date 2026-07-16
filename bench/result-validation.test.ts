import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { DriverResult, SystemName } from "./benchmark.ts";
import {
  formatBenchmarkValidation,
  validateBenchmarkResults,
  type BenchmarkValidationTarget,
} from "./result-validation.ts";

const baseline = JSON.parse(
  readFileSync(new URL("./results/2026-07-13T15-34-33Z-74d8554.json", import.meta.url), "utf8"),
) as { systems: Record<SystemName, { workload: DriverResult }> };

function targets(): BenchmarkValidationTarget[] {
  return (["dbzz", "convex", "spacetimedb"] as const).map((system) => ({
    label: system,
    system,
    workload: structuredClone(baseline.systems[system].workload),
  }));
}

function workload(results: BenchmarkValidationTarget[], system: SystemName): DriverResult {
  return results.find((result) => result.system === system)!.workload;
}

describe("benchmark result validation", () => {
  test("returns immutable pass evidence for comparable correct results", () => {
    const validation = validateBenchmarkResults(targets());

    expect(validation).toEqual({ status: "passed", failures: [] });
    expect(formatBenchmarkValidation(validation)).toBe("Benchmark correctness validation: PASSED");
    expect(Object.isFrozen(validation)).toBe(true);
    expect(Object.isFrozen(validation.failures)).toBe(true);
  });

  test("records measured operation, connection, and subscription failures without throwing", () => {
    const results = targets();
    const operation = workload(results, "dbzz").operations[0]!.trials[0]!;
    operation.completedInWindow--;
    operation.failed++;
    operation.errors.push("query checksum mismatch");
    operation.correctness = { ok: false, errors: ["query checksum mismatch"] };

    const connection = workload(results, "convex").connections[0]!;
    connection.connected--;
    connection.errors.push("connection refused");

    const subscription = workload(results, "spacetimedb").subscriptions[0]!;
    subscription.duplicateDeliveries++;
    subscription.correctness = { ok: false, errors: ["1 duplicate deliveries"] };

    const capacity = workload(results, "dbzz").subscriptions[0]!.capacity[0]!;
    capacity.completedInWindow--;
    capacity.failed++;
    capacity.correctness = { ok: false, errors: ["delivery timeout"] };

    const validation = validateBenchmarkResults(results);

    expect(validation.status).toBe("failed");
    expect(validation.failures).toEqual([
      {
        target: "dbzz",
        kind: "operation",
        case: "query/latency/trial-0",
        errors: ["query checksum mismatch", "1 request failed"],
      },
      {
        target: "dbzz",
        kind: "subscription-capacity",
        case: "subscriptions/shared/capacity-1",
        errors: ["delivery timeout", "1 request failed"],
      },
      {
        target: "convex",
        kind: "connection",
        case: "connections/1",
        errors: ["connected 0/1", "connection refused"],
      },
      {
        target: "spacetimedb",
        kind: "subscription",
        case: "subscriptions/shared",
        errors: ["1 duplicate deliveries"],
      },
    ]);
    expect(formatBenchmarkValidation(validation)).toContain("Benchmark correctness validation: FAILED (4 cases)");
    expect(Object.isFrozen(validation.failures[0])).toBe(true);
    expect(Object.isFrozen(validation.failures[0]!.errors)).toBe(true);
  });

  test("keeps broken request accounting fatal for every closed-loop result family", () => {
    for (const mutate of [
      (results: BenchmarkValidationTarget[]) => workload(results, "dbzz").operations[0]!.trials[0]!.attempted++,
      (results: BenchmarkValidationTarget[]) => workload(results, "dbzz").connections[0]!.work.attempted++,
      (results: BenchmarkValidationTarget[]) =>
        workload(results, "dbzz").subscriptions[0]!.capacity[0]!.attempted++,
    ]) {
      const results = targets();
      mutate(results);
      expect(() => validateBenchmarkResults(results)).toThrow("request accounting mismatch");
    }
  });

  test("derives every fixed-rate delivery failure from the measured counters", () => {
    for (const [field, message] of [
      ["missingDeliveries", "1 missing deliveries"],
      ["duplicateDeliveries", "1 duplicate deliveries"],
      ["unexpectedDeliveries", "1 unexpected deliveries"],
      ["corruptDeliveries", "1 corrupt deliveries"],
    ] as const) {
      const results = targets();
      const subscription = workload(results, "dbzz").subscriptions[0]!;
      subscription[field] = 1;

      const validation = validateBenchmarkResults(results);

      expect(validation.status).toBe("failed");
      expect(validation.failures[0]).toMatchObject({
        kind: "subscription",
        errors: [message],
      });
    }
  });

  test("keeps config and case-shape mismatches fatal", () => {
    const configMismatch = targets();
    workload(configMismatch, "convex").config.seed++;
    expect(() => validateBenchmarkResults(configMismatch)).toThrow("workload config differs");

    const caseMismatch = targets();
    workload(caseMismatch, "spacetimedb").operations.pop();
    expect(() => validateBenchmarkResults(caseMismatch)).toThrow("operation case shape differs");

    const sharedOmission = targets();
    for (const result of sharedOmission) result.workload.operations.pop();
    expect(() => validateBenchmarkResults(sharedOmission)).toThrow("operation case shape differs");
  });

  test("cannot hide reported correctness errors behind an accidental ok flag", () => {
    const results = targets();
    const trial = workload(results, "dbzz").operations[0]!.trials[0]!;
    trial.correctness = { ok: true, errors: ["query payload mismatch"] };
    const capacity = workload(results, "convex").subscriptions[0]!.capacity[0]!;
    capacity.correctness = { ok: true, errors: ["delivery checksum mismatch"] };

    const validation = validateBenchmarkResults(results);

    expect(validation.status).toBe("failed");
    expect(validation.failures).toEqual([
      expect.objectContaining({ kind: "operation", errors: ["query payload mismatch"] }),
      expect.objectContaining({ kind: "subscription-capacity", errors: ["delivery checksum mismatch"] }),
    ]);
  });
});
