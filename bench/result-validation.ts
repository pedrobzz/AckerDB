import {
  OPERATION_NAMES,
  subscriptionCapacitySlots,
  type BenchmarkConfig,
  type ClosedLoopResult,
  type DriverResult,
  type SystemName,
} from "./benchmark.ts";

export type BenchmarkFailureKind = "operation" | "connection" | "subscription" | "subscription-capacity";

export interface BenchmarkValidationTarget {
  readonly label: string;
  readonly system: SystemName;
  readonly workload: DriverResult;
}

export interface BenchmarkCorrectnessFailure {
  readonly target: string;
  readonly kind: BenchmarkFailureKind;
  readonly case: string;
  readonly errors: readonly string[];
}

export interface BenchmarkValidation {
  /** Whole-run verdict across every target, comparative legs included. */
  readonly status: "passed" | "failed";
  /**
   * The verdict over DBZZ targets alone — what the release gate judges.
   * Comparative targets make the DBZZ result interpretable; their harness
   * failures are recorded above but never veto a DBZZ release.
   */
  readonly dbzzStatus: "passed" | "failed";
  readonly failures: readonly BenchmarkCorrectnessFailure[];
}

function operationShape(workload: DriverResult): string {
  return JSON.stringify(
    [
      ...workload.operations.map((operation) => [operation.operation, operation.profile]),
      ...(workload.failures ?? []).flatMap((failure) =>
        failure.kind === "operation" ? [[failure.operation, failure.profile]] : []
      ),
    ].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  );
}

function expectedOperationShape(config: BenchmarkConfig): string {
  return JSON.stringify(
    OPERATION_NAMES.flatMap((operation) =>
      config.operation.profiles.map((profile) => [operation, profile]),
    ).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  );
}

function connectionShape(workload: DriverResult): string {
  return JSON.stringify([
    ...workload.connections.map((connection) => connection.targetConnections),
    ...(workload.failures ?? []).flatMap((failure) =>
      failure.kind === "connection" ? [failure.targetConnections] : []
    ),
  ].sort((left, right) => left - right));
}

function subscriptionShape(workload: DriverResult): string {
  return JSON.stringify([
    ...workload.subscriptions.map((subscription) => subscription.pattern),
    ...(workload.failures ?? []).flatMap((failure) => failure.kind === "subscription" ? [failure.pattern] : []),
  ].sort());
}

function expectedSubscriptionShape(config: BenchmarkConfig): string {
  return JSON.stringify(
    [...config.subscriptions.patterns].sort(),
  );
}

function assertRequestAccounting(
  errors: string[],
  label: string,
  result: Pick<ClosedLoopResult, "attempted" | "completedInWindow" | "completedAfterWindow" | "failed">,
): void {
  const counts = {
    attempted: result.attempted,
    completedInWindow: result.completedInWindow,
    completedAfterWindow: result.completedAfterWindow,
    failed: result.failed,
  };
  for (const [field, value] of Object.entries(counts)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      errors.push(`${label}: ${field} must be a non-negative safe integer`);
    }
  }
  if (result.attempted !== result.completedInWindow + result.completedAfterWindow + result.failed) {
    errors.push(`${label}: request accounting mismatch`);
  }
}

function failureErrors(
  errors: readonly string[],
  failedRequests = 0,
  fallback = "correctness check failed without details",
): readonly string[] {
  const unique = new Set(errors.filter((error) => error.length > 0));
  if (failedRequests > 0) {
    unique.add(`${failedRequests} request${failedRequests === 1 ? "" : "s"} failed`);
  }
  if (unique.size === 0) unique.add(fallback);
  return Object.freeze([...unique]);
}

function addFailure(
  failures: BenchmarkCorrectnessFailure[],
  target: string,
  kind: BenchmarkFailureKind,
  benchmarkCase: string,
  errors: readonly string[],
  failedRequests = 0,
  fallback?: string,
): void {
  failures.push(Object.freeze({
    target,
    kind,
    case: benchmarkCase,
    errors: failureErrors(errors, failedRequests, fallback),
  }));
}

/**
 * Asserts that result sets remain structurally comparable, then returns the
 * measured systems' correctness outcome as data. Structural and request-
 * accounting failures remain fatal because their metrics are not meaningful.
 */
export function validateBenchmarkResults(targets: readonly BenchmarkValidationTarget[]): BenchmarkValidation {
  const reference = targets[0]?.workload;
  if (reference === undefined) throw new Error("benchmark validation requires at least one result target");

  const integrityErrors: string[] = [];
  const failures: BenchmarkCorrectnessFailure[] = [];
  const labels = new Set<string>();
  const referenceConfig = JSON.stringify(reference.config);
  const expectedOperations = expectedOperationShape(reference.config);
  const expectedConnections = JSON.stringify(reference.config.connections.levels);
  const expectedSubscriptions = expectedSubscriptionShape(reference.config);

  for (const target of targets) {
    if (labels.has(target.label)) integrityErrors.push(`duplicate validation target ${target.label}`);
    labels.add(target.label);

    const workload = target.workload;
    if (workload.system !== target.system) {
      integrityErrors.push(`${target.label}: workload identified itself as ${workload.system}`);
    }
    if (JSON.stringify(workload.config) !== referenceConfig) {
      integrityErrors.push(`${target.label}: workload config differs`);
    }
    if (operationShape(workload) !== expectedOperations) {
      integrityErrors.push(`${target.label}: operation case shape differs`);
    }
    if (connectionShape(workload) !== expectedConnections) {
      integrityErrors.push(`${target.label}: connection ladder differs`);
    }
    if (subscriptionShape(workload) !== expectedSubscriptions) {
      integrityErrors.push(`${target.label}: subscription case shape differs`);
    }

    for (const operation of workload.operations) {
      const operationCase = `${operation.operation}/${operation.profile.name}`;
      if (operation.trials.length !== workload.config.operation.trials) {
        integrityErrors.push(
          `${target.label} ${operationCase}: measured ${operation.trials.length}/${workload.config.operation.trials} trials`,
        );
      }
      for (const [trialIndex, trial] of operation.trials.entries()) {
        const benchmarkCase = `${operation.operation}/${operation.profile.name}/trial-${trialIndex}`;
        assertRequestAccounting(integrityErrors, `${target.label} ${benchmarkCase}`, trial);
        const errors = [...trial.correctness.errors, ...trial.errors];
        if (!trial.correctness.ok || trial.failed > 0 || errors.length > 0) {
          addFailure(
            failures,
            target.label,
            "operation",
            benchmarkCase,
            errors,
            trial.failed,
          );
        }
      }
    }

    for (const connection of workload.connections) {
      const benchmarkCase = `connections/${connection.targetConnections}`;
      assertRequestAccounting(integrityErrors, `${target.label} ${benchmarkCase}`, connection.work);
      const errors = [
        ...(connection.connected === connection.targetConnections
          ? []
          : [`connected ${connection.connected}/${connection.targetConnections}`]),
        ...connection.errors,
        ...connection.work.errors,
      ];
      if (errors.length > 0 || connection.work.failed > 0) {
        addFailure(
          failures,
          target.label,
          "connection",
          benchmarkCase,
          errors,
          connection.work.failed,
        );
      }
    }

    for (const subscription of workload.subscriptions) {
      const benchmarkCase = `subscriptions/${subscription.pattern}`;
      const expectedCapacity = JSON.stringify(subscriptionCapacitySlots(workload.config.subscriptions, subscription.pattern));
      const actualCapacity = JSON.stringify([
        ...subscription.capacity.map((capacity) => capacity.slots),
        ...(workload.failures ?? []).flatMap((failure) =>
          failure.kind === "subscription-capacity" && failure.pattern === subscription.pattern
            ? [failure.slots]
            : []
        ),
      ].sort((left, right) => left - right));
      if (actualCapacity !== expectedCapacity) {
        integrityErrors.push(`${target.label} ${benchmarkCase}: capacity ladder differs`);
      }
      const errors = [
        ...subscription.correctness.errors,
        ...(subscription.missingDeliveries === 0
          ? []
          : [`${subscription.missingDeliveries} missing deliveries`]),
        ...(subscription.duplicateDeliveries === 0
          ? []
          : [`${subscription.duplicateDeliveries} duplicate deliveries`]),
        ...(subscription.unexpectedDeliveries === 0
          ? []
          : [`${subscription.unexpectedDeliveries} unexpected deliveries`]),
        ...(subscription.corruptDeliveries === 0
          ? []
          : [`${subscription.corruptDeliveries} corrupt deliveries`]),
      ];
      if (!subscription.correctness.ok || errors.length > 0) {
        addFailure(failures, target.label, "subscription", benchmarkCase, errors);
      }

      for (const capacity of subscription.capacity) {
        const capacityCase = `${benchmarkCase}/capacity-${capacity.slots}`;
        assertRequestAccounting(integrityErrors, `${target.label} ${capacityCase}`, capacity);
        const errors = [...capacity.correctness.errors, ...capacity.errors];
        if (!capacity.correctness.ok || capacity.failed > 0 || errors.length > 0) {
          addFailure(
            failures,
            target.label,
            "subscription-capacity",
            capacityCase,
            errors,
            capacity.failed,
          );
        }
      }
    }

    for (const failure of workload.failures ?? []) {
      if (failure.message.length === 0) {
        integrityErrors.push(`${target.label}: failed ${failure.kind} case has no error message`);
      }
      if (failure.partial !== undefined) {
        assertRequestAccounting(integrityErrors, `${target.label} ${failure.kind}/partial`, failure.partial);
      }
      if (failure.kind === "operation") {
        for (const [trialIndex, trial] of failure.completedTrials.entries()) {
          assertRequestAccounting(
            integrityErrors,
            `${target.label} ${failure.operation}/${failure.profile.name}/trial-${trialIndex}`,
            trial,
          );
        }
      }
      const benchmarkCase = failure.kind === "operation"
        ? `${failure.operation}/${failure.profile.name}`
        : failure.kind === "connection"
          ? `connections/${failure.targetConnections}`
          : failure.kind === "subscription"
            ? `subscriptions/${failure.pattern}`
            : `subscriptions/${failure.pattern}/capacity-${failure.slots}`;
      addFailure(
        failures,
        target.label,
        failure.kind,
        benchmarkCase,
        [failure.message, ...(failure.partial?.errors ?? [])],
        failure.partial?.failed ?? 0,
      );
    }
  }

  if (integrityErrors.length > 0) {
    throw new Error(`benchmark produced incomparable results:\n${integrityErrors.join("\n")}`);
  }

  const systemOf = new Map(targets.map((target) => [target.label, target.system]));
  return Object.freeze({
    status: failures.length === 0 ? "passed" : "failed",
    dbzzStatus: failures.some((failure) => systemOf.get(failure.target) === "dbzz") ? "failed" : "passed",
    failures: Object.freeze(failures),
  });
}

export function formatBenchmarkValidation(validation: BenchmarkValidation): string {
  if (validation.status === "passed") return "Benchmark correctness validation: PASSED";
  return [
    `Benchmark correctness validation: FAILED (${validation.failures.length} case${validation.failures.length === 1 ? "" : "s"})`,
    ...validation.failures.map(
      (failure) =>
        `  - ${failure.target} ${failure.case} [${failure.kind}]: ${failure.errors.join("; ")}`,
    ),
  ].join("\n");
}
