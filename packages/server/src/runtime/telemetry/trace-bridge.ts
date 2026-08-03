import { AsyncLocalStorage } from "node:async_hooks";
import {
  currentInvocationFunctionContext,
  currentInvocationTelemetryContext,
  withInvocationContext,
  withInvocationTelemetry,
  type InvocationOutcome,
  type InvocationTelemetryContext,
} from "../../app/invocation.ts";
import type { Registry } from "../../app/registry.ts";
import type {
  DbStatementObservation,
  DbStatementObserver,
} from "../../database/statement-observation.ts";
import type {
  ReactiveObservation,
  ReactiveObserver,
} from "../../subscriptions/reactive.ts";
import type { ApplicationLogCallContext } from "../../telemetry/application-signals/types.ts";
import {
  OPEN_OPERATION_TRACE,
  OPERATION_INVOCATION_NODE,
  OPERATION_TRACE_CONTEXT,
  RECORD_OPERATION_EVENT,
  RECORD_OPERATION_SPAN,
  prepareTelemetryTraceContext,
  type OperationTraceHandle,
  type PreparedTelemetryTraceContext,
  type Telemetry,
  type TelemetryEventInput,
  type TelemetryOperation,
  type TelemetryOutcome,
  type TelemetryResource,
  type TelemetryStage,
  type TelemetryTraceContext,
} from "../../telemetry/telemetry.ts";
import {
  withFetchObserver,
  type CommitTelemetryEvent,
  type FetchObservation,
} from "../coordinator.ts";

export type RuntimeTraceIdentifiers = Partial<Pick<
  TelemetryTraceContext,
  "requestId" | "connectionId" | "mutationId" | "commitId" | "subscriptionId"
>>;

export interface RuntimeTraceScope {
  readonly operation: TelemetryOperation;
  readonly rootFunction?: string;
  readonly trace: OperationTraceHandle;
  invocations: number;
}

export interface RuntimeTraceSpan {
  readonly operation?: TelemetryOperation;
  readonly stage: TelemetryStage;
  readonly outcome: TelemetryOutcome;
  readonly functionName?: string;
  readonly statement?: string;
  readonly resource?: TelemetryResource;
  readonly durationMs: number;
  readonly sizeBytes?: number;
  readonly rowCount?: number;
  readonly resultCount?: number;
  readonly replayed?: boolean;
  readonly dependencyCount?: number;
  readonly postCommit?: boolean;
  readonly requestId?: string;
  readonly connectionId?: string;
  readonly mutationId?: string;
  readonly commitId?: string;
  readonly subscriptionId?: string;
}

function observationOutcome(outcome: ReactiveObservation["outcome"]): TelemetryOutcome {
  return outcome === "changed" || outcome === "unchanged" ||
      outcome === "matched" || outcome === "unmatched"
    ? "ok"
    : outcome;
}

/** Runtime-owned adapter between execution scopes and the telemetry implementation. */
export class RuntimeTraceBridge {
  private readonly storage = new AsyncLocalStorage<RuntimeTraceScope>();

  constructor(
    readonly telemetry: Telemetry,
    private readonly registry: Pick<Registry, "invocationNameOf" | "kindOf">,
  ) {}

  private readonly observeInvocation = (
    invocation: InvocationTelemetryContext,
    phase: "auth" | "policy" | "handler",
    durationMs: number,
    outcome: InvocationOutcome,
  ): void => {
    const scope = this.storage.getStore();
    if (scope === undefined) return;
    scope.invocations++;
    const parent = this.invocationNode(scope, invocation.parent, "handler");
    const node = this.telemetry[OPERATION_INVOCATION_NODE](
      scope.trace,
      invocation.invocationId,
      phase,
      parent,
    );
    this.telemetry[RECORD_OPERATION_SPAN](scope.trace, node, parent, {
      operation: scope.operation,
      stage: phase,
      outcome,
      functionName: this.registry.invocationNameOf(invocation.fn) ?? scope.rootFunction,
      durationMs,
    });
  };

  private readonly observeFetch = (observation: Readonly<FetchObservation>): void => {
    this.span({
      stage: "fetch",
      outcome: observation.outcome,
      resource: "outbound",
      durationMs: observation.durationMs,
    }, "procedure");
  };

  readonly observeStatement: DbStatementObserver = (
    observation: Readonly<DbStatementObservation>,
  ): void => {
    this.span({
      stage: "statement",
      outcome: observation.outcome === "ok" ? "ok" : "internal",
      statement: `${observation.table}.${observation.statement}`,
      resource: observation.kind === "read" ? "reader" : "writer",
      durationMs: observation.durationMs,
      ...(observation.rowCount === undefined ? {} : { rowCount: observation.rowCount }),
    }, observation.kind === "read" ? "query" : "transaction");
  };

  measureStatement<T>(
    kind: DbStatementObservation["kind"],
    table: string,
    statement: string,
    work: () => T,
    rowCount: (value: T) => number,
  ): T {
    if (!this.telemetry.enabled) return work();
    const startedAt = performance.now();
    try {
      const value = work();
      this.observeStatement({
        kind,
        table,
        statement,
        outcome: "ok",
        durationMs: Math.max(0, performance.now() - startedAt),
        rowCount: rowCount(value),
      });
      return value;
    } catch (error) {
      this.observeStatement({
        kind,
        table,
        statement,
        outcome: "failed",
        durationMs: Math.max(0, performance.now() - startedAt),
      });
      throw error;
    }
  }

  readonly observeCommit = (event: Readonly<CommitTelemetryEvent>): void => {
    const resource: TelemetryResource = event.stage === "publication"
      ? "publication"
      : event.replayed === true || event.stage === "encoding"
        ? "idempotency"
        : "writer";
    this.span({
      operation: event.operation,
      stage: event.stage,
      outcome: event.outcome,
      resource,
      durationMs: event.durationMs,
      ...(event.sizeBytes === undefined ? {} : { sizeBytes: event.sizeBytes }),
      ...(event.resultCount === undefined ? {} : { resultCount: event.resultCount }),
      ...(event.dependencyCount === undefined ? {} : { dependencyCount: event.dependencyCount }),
      ...(event.replayed === undefined ? {} : { replayed: event.replayed }),
      ...(event.postCommit === undefined ? {} : { postCommit: event.postCommit }),
      ...(event.commitVersion === undefined ? {} : { commitId: String(event.commitVersion) }),
    }, event.operation);
  };

  readonly observeReactive: ReactiveObserver = (observation: ReactiveObservation): void => {
    if (observation.phase === "failure") {
      this.event({
        name: "failure",
        level: "error",
        operation: "subscription",
        outcome: observationOutcome(observation.outcome),
        ...(observation.address === undefined ? {} : { functionName: observation.address }),
        resource: "subscription",
        ...(observation.subscriptionId === undefined
          ? {}
          : { subscriptionId: String(observation.subscriptionId) }),
        ...(observation.commitVersion === undefined
          ? {}
          : { commitId: String(observation.commitVersion) }),
      });
      return;
    }
    const stage: TelemetryStage = observation.phase === "initial_evaluation" ||
        observation.phase === "evaluation"
      ? "evaluation"
      : observation.phase === "invalidation_match" || observation.phase === "event_match"
        ? "match"
        : observation.phase === "revalidation_queue" || observation.phase === "listener_queue"
          ? "queue"
          : observation.phase;
    const resource: TelemetryResource = observation.phase === "revalidation_queue" ||
        observation.phase === "evaluation" || observation.phase === "initial_evaluation" ||
        observation.phase === "changed" || observation.phase === "unchanged"
      ? "revalidation"
      : observation.phase === "delivery" || observation.phase === "listener_queue" ||
          observation.phase === "fanout"
        ? "outbound"
        : "subscription";
    const scope = this.storage.getStore();
    const subscriptionId = observation.subscriptionId === undefined
      ? undefined
      : String(observation.subscriptionId);
    const commitId = observation.commitVersion === undefined
      ? undefined
      : String(observation.commitVersion);
    if (scope === undefined) {
      this.telemetry.recordSpan({
        operation: "subscription",
        stage,
        outcome: observationOutcome(observation.outcome),
        resource,
        durationMs: observation.durationMs,
        functionName: observation.address,
        resultCount: observation.resultCount,
        dependencyCount: observation.dependencyCount,
        sizeBytes: observation.byteCount,
        context: prepareTelemetryTraceContext({ subscriptionId, commitId }),
      });
      return;
    }
    this.telemetry[RECORD_OPERATION_SPAN](
      scope.trace,
      -1,
      this.invocationNode(scope, currentInvocationTelemetryContext()),
      {
        operation: "subscription",
        stage,
        outcome: observationOutcome(observation.outcome),
        functionName: observation.address,
        resource,
        durationMs: observation.durationMs,
        sizeBytes: observation.byteCount,
        resultCount: observation.resultCount,
        dependencyCount: observation.dependencyCount,
        commitId,
        subscriptionId,
      },
    );
  };

  open(
    telemetryConnectionId: string | undefined,
    operation: TelemetryOperation,
    functionName: string | undefined,
    identifiers: RuntimeTraceIdentifiers,
    inheritedContext?: PreparedTelemetryTraceContext,
  ): RuntimeTraceScope {
    return {
      operation,
      ...(functionName === undefined ? {} : { rootFunction: functionName }),
      trace: this.telemetry[OPEN_OPERATION_TRACE]({
        operation,
        ...(functionName === undefined ? {} : { functionName }),
        ...(telemetryConnectionId === undefined ? {} : { connectionId: telemetryConnectionId }),
        ...identifiers,
        ...(inheritedContext === undefined ? {} : { inheritedContext }),
      }),
      invocations: 0,
    };
  }

  applicationLogContext(): ApplicationLogCallContext {
    const scope = this.storage.getStore();
    if (scope === undefined) {
      return Object.freeze({ functionAddress: "unknown", functionKind: "unknown" });
    }
    const invocation = currentInvocationFunctionContext();
    const telemetryInvocation = currentInvocationTelemetryContext();
    const functionAddress = invocation === undefined
      ? scope.rootFunction ?? "unknown"
      : this.registry.invocationNameOf(invocation.fn) ?? scope.rootFunction ?? "unknown";
    const functionKind = invocation?.fn.kind ?? this.registry.kindOf(functionAddress) ?? scope.operation;
    const node = telemetryInvocation === undefined
      ? 0
      : this.invocationNode(scope, telemetryInvocation);
    const correlation = this.telemetry[OPERATION_TRACE_CONTEXT](scope.trace, node);
    return Object.freeze({
      functionAddress,
      functionKind,
      ...(correlation?.traceId === undefined ? {} : { traceId: correlation.traceId }),
      ...(correlation?.spanId === undefined ? {} : { spanId: correlation.spanId }),
      ...(correlation?.requestId === undefined ? {} : { requestId: correlation.requestId }),
    });
  }

  currentScope(): RuntimeTraceScope | undefined {
    return this.storage.getStore();
  }

  invocationNode(
    scope: RuntimeTraceScope,
    invocation: InvocationTelemetryContext | undefined,
    phase: "auth" | "policy" | "handler" = "handler",
  ): number {
    if (invocation === undefined) return 0;
    const parent = this.invocationNode(scope, invocation.parent, "handler");
    return this.telemetry[OPERATION_INVOCATION_NODE](
      scope.trace,
      invocation.invocationId,
      phase,
      parent,
    );
  }

  span(
    input: RuntimeTraceSpan,
    fallbackOperation: TelemetryOperation,
    capturedScope?: RuntimeTraceScope,
    capturedParent?: number,
  ): void {
    if (!this.telemetry.enabled) return;
    const scope = capturedScope ?? this.storage.getStore();
    if (scope === undefined) return;
    const invocation = currentInvocationTelemetryContext();
    const parent = capturedParent ?? this.invocationNode(scope, invocation);
    const currentFunction = invocation === undefined
      ? undefined
      : this.registry.invocationNameOf(invocation.fn);
    this.telemetry[RECORD_OPERATION_SPAN](scope.trace, -1, parent, {
      ...input,
      operation: input.operation ?? scope.operation ?? fallbackOperation,
      functionName: input.functionName ?? currentFunction ?? scope.rootFunction,
    });
  }

  event(
    input: Omit<TelemetryEventInput, "context"> & RuntimeTraceIdentifiers,
    capturedScope?: RuntimeTraceScope,
    capturedParent?: number,
  ): void {
    const scope = capturedScope ?? this.storage.getStore();
    if (scope === undefined) return;
    const parent = capturedParent ?? this.invocationNode(
      scope,
      currentInvocationTelemetryContext(),
    );
    const { requestId, connectionId, mutationId, commitId, subscriptionId, ...event } = input;
    this.telemetry[RECORD_OPERATION_EVENT](
      scope.trace,
      parent,
      event,
      requestId,
      connectionId,
      mutationId,
      commitId,
      subscriptionId,
    );
  }

  runScope<T>(scope: RuntimeTraceScope, work: () => T): T {
    return this.storage.run(scope, work);
  }

  runOperation<T>(scope: RuntimeTraceScope, work: () => T): T {
    return this.storage.run(scope, () => this.telemetry.enabled
      ? withFetchObserver(
          this.observeFetch,
          () => withInvocationTelemetry(this.observeInvocation, work),
        )
      : withInvocationContext(work));
  }
}
