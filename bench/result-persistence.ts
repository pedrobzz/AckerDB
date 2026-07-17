import type { PerformanceAcceptanceResult } from "./performance-gates.ts";
import type { BenchmarkValidation } from "./result-validation.ts";

export interface PersistableBenchmarkOutcome {
  readonly schemaVersion: 7;
  readonly validation: BenchmarkValidation;
  readonly performanceAcceptance: PerformanceAcceptanceResult;
}

export interface PersistedBenchmarkOutcome {
  readonly status: "passed" | "failed";
}

/** Persistence completes before the caller can apply the returned failing status. */
export async function persistBenchmarkOutcome(
  path: string,
  record: PersistableBenchmarkOutcome,
): Promise<PersistedBenchmarkOutcome> {
  const performance = record.performanceAcceptance;
  const consistent = performance.status === "not-evaluated"
    ? performance.reason === "correctness-failed"
      ? record.validation.status === "failed"
      : record.validation.status === "passed"
    : record.validation.status === "passed";
  if (!consistent) {
    throw new Error("benchmark correctness and performance outcomes are inconsistent");
  }
  await Bun.write(path, `${JSON.stringify(record, null, 2)}\n`);
  return Object.freeze({
    status:
      record.validation.status === "failed" || record.performanceAcceptance.status === "failed"
        ? "failed"
        : "passed",
  });
}
