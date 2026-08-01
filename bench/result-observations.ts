import {
  OPERATION_NAMES,
  subscriptionCapacitySlots,
  type BenchmarkConfig,
  type ClosedLoopResult,
  type DriverResult,
  type SystemName,
} from "./benchmark.ts";

export type BenchmarkFailureKind = "operation" | "connection" | "subscription" | "subscription-capacity";

export interface BenchmarkObservationTarget {
  readonly label: string;
  readonly system: SystemName;
  readonly workload: DriverResult;
}

export interface BenchmarkCorrectnessFailure {
  readonly target: string;
  readonly system: SystemName;
  readonly kind: BenchmarkFailureKind;
  readonly case: string;
  readonly errors: readonly string[];
}

export interface BenchmarkIntegrityAnomaly {
  readonly target: string;
  readonly system: SystemName;
  readonly message: string;
}

export interface BenchmarkObservations {
  readonly failures: readonly BenchmarkCorrectnessFailure[];
  readonly integrityAnomalies: readonly BenchmarkIntegrityAnomaly[];
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
  system: SystemName,
  kind: BenchmarkFailureKind,
  benchmarkCase: string,
  errors: readonly string[],
  failedRequests = 0,
  fallback?: string,
): void {
  failures.push(Object.freeze({
    target,
    system,
    kind,
    case: benchmarkCase,
    errors: failureErrors(errors, failedRequests, fallback),
  }));
}

/**
 * Records concrete correctness and structural observations. Interpretation is
 * deliberately left to the release reviewer rather than encoded as a verdict.
 */
export function collectBenchmarkObservations(
  targets: readonly BenchmarkObservationTarget[],
): BenchmarkObservations {
  const reference = targets[0]?.workload;
  if (reference === undefined) throw new Error("benchmark observation collection requires at least one result target");

  const integrityAnomalies: BenchmarkIntegrityAnomaly[] = [];
  const failures: BenchmarkCorrectnessFailure[] = [];
  const labels = new Set<string>();
  const referenceConfig = JSON.stringify(reference.config);
  const expectedOperations = expectedOperationShape(reference.config);
  const expectedConnections = JSON.stringify(reference.config.connections.levels);
  const expectedSubscriptions = expectedSubscriptionShape(reference.config);

  for (const target of targets) {
    const integrityErrors: string[] = [];
    if (labels.has(target.label)) integrityErrors.push(`duplicate observation target ${target.label}`);
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
            target.system,
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
          target.system,
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
        addFailure(failures, target.label, target.system, "subscription", benchmarkCase, errors);
      }

      for (const capacity of subscription.capacity) {
        const capacityCase = `${benchmarkCase}/capacity-${capacity.slots}`;
        assertRequestAccounting(integrityErrors, `${target.label} ${capacityCase}`, capacity);
        const errors = [...capacity.correctness.errors, ...capacity.errors];
        if (!capacity.correctness.ok || capacity.failed > 0 || errors.length > 0) {
          addFailure(
            failures,
            target.label,
            target.system,
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
        target.system,
        failure.kind,
        benchmarkCase,
        [failure.message, ...(failure.partial?.errors ?? [])],
        failure.partial?.failed ?? 0,
      );
    }
    integrityAnomalies.push(...integrityErrors.map((message) => Object.freeze({
      target: target.label,
      system: target.system,
      message,
    })));
  }

  return Object.freeze({
    failures: Object.freeze(failures),
    integrityAnomalies: Object.freeze(integrityAnomalies),
  });
}

export function formatBenchmarkObservations(observations: BenchmarkObservations): string {
  if (observations.failures.length === 0 && observations.integrityAnomalies.length === 0) {
    return "Benchmark harness observations: none";
  }
  return [
    `Benchmark harness observations: ${observations.failures.length} correctness, ${observations.integrityAnomalies.length} integrity`,
    ...observations.failures.map(
      (failure) =>
        `  - ${failure.target} ${failure.case} [${failure.kind}]: ${failure.errors.join("; ")}`,
    ),
    ...observations.integrityAnomalies.map(
      (anomaly) => `  - ${anomaly.target} [integrity]: ${anomaly.message}`,
    ),
  ].join("\n");
}
