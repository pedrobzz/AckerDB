import { currentInvocationTelemetryContext } from "../../app/invocation.ts";
import type { OutboundLane } from "../../subscriptions/delivery/budget.ts";
import {
  FINALIZE_DELIVERY_OBSERVER,
  type DeliveryObservation,
  type DeliveryObserver,
} from "../../subscriptions/delivery/observation.ts";
import {
  CLAIM_OPERATION_DELIVERY_LEASE,
  RELEASE_DELIVERY_LEASE,
  Telemetry,
  prepareTelemetryTraceContext,
  type PreparedTelemetryTraceContext,
  type TelemetryOperation,
  type TelemetryOutcome,
  type TelemetryResource,
  type TelemetryStage,
} from "../../telemetry/telemetry.ts";
import {
  RuntimeTraceBridge,
  type RuntimeTraceScope,
} from "./trace-bridge.ts";

/** Individually retained non-ok observations per summary key per sampler interval. */
const FAILURE_EXEMPLARS_PER_INTERVAL = 8;
/** Early flush bound so an unsampled storm cannot defer its summary indefinitely. */
const FAILURE_SUMMARY_FLUSH_THRESHOLD = 4_096;

interface DeliveryFailureSummary {
  readonly operation: TelemetryOperation;
  readonly stage: TelemetryStage;
  readonly outcome: TelemetryOutcome;
  readonly resource: TelemetryResource;
  exemplars: number;
  summarized: number;
}

interface DetachedDeliveryTrace {
  readonly operation: TelemetryOperation;
  readonly context: PreparedTelemetryTraceContext;
}

/** Owns delivery trace capture and bounded failure coalescing. */
export class RuntimeDeliveryTelemetry {
  private readonly summaries = new Map<string, DeliveryFailureSummary>();

  readonly observer: DeliveryObserver = (observation): void => {
    const ambient = this.tracing.currentScope();
    if (ambient !== undefined) {
      this.observe(
        ambient,
        this.tracing.invocationNode(
          ambient,
          currentInvocationTelemetryContext(),
        ),
        observation,
      );
      return;
    }
    this.observe({
      operation: observation.transport === "sse" ? "sse" : "subscription",
      context: prepareTelemetryTraceContext(),
    }, 0, observation);
  };

  constructor(
    private readonly telemetry: Telemetry,
    private readonly tracing: RuntimeTraceBridge,
    private readonly connectionId: (clientSessionId: string) => string,
  ) {}

  capture(
    lane: OutboundLane = "application",
    clientSessionId?: string,
  ): DeliveryObserver | undefined {
    if (!this.telemetry.enabled) return undefined;
    const scope = this.tracing.currentScope();
    if (scope === undefined) {
      const detached: DetachedDeliveryTrace = {
        operation: lane === "control" ? "lifecycle" : "subscription",
        context: prepareTelemetryTraceContext(
          clientSessionId === undefined
            ? {}
            : { connectionId: this.connectionId(clientSessionId) },
        ),
      };
      return (observation) => this.observe(detached, 0, observation);
    }
    const parent = this.tracing.invocationNode(
      scope,
      currentInvocationTelemetryContext(),
    );
    const lease = scope.operation === "sse"
      ? undefined
      : this.telemetry[CLAIM_OPERATION_DELIVERY_LEASE](scope.trace);
    if (lease === undefined) {
      return (observation) => this.observe(scope, parent, observation);
    }
    let released = false;
    return Object.assign(
      (observation: DeliveryObservation) =>
        this.observe(scope, parent, observation),
      {
        [FINALIZE_DELIVERY_OBSERVER]: () => {
          if (released) return;
          released = true;
          this.telemetry[RELEASE_DELIVERY_LEASE](lease);
        },
      },
    );
  }

  flush(): void {
    for (const summary of this.summaries.values()) this.flushSummary(summary);
    this.summaries.clear();
  }

  private observe(
    trace: RuntimeTraceScope | DetachedDeliveryTrace,
    parentNode: number,
    observation: DeliveryObservation,
  ): void {
    const outcome: TelemetryOutcome = observation.outcome === "dropped"
      ? "unavailable"
      : observation.outcome;
    const fallbackOperation: TelemetryOperation = observation.transport === "sse"
      ? "sse"
      : "subscription";
    const resource: TelemetryResource = observation.transport === "sse"
      ? "sse"
      : "outbound";
    if (observation.droppedObservations !== undefined) {
      this.telemetry.recordMetric({
        name: "delivery.observations_dropped",
        value: observation.droppedObservations,
        unit: "count",
        labels: { operation: fallbackOperation, resource },
      });
    }
    // A successfully encoded terminal error frame reports outcome "ok" while
    // carrying the actual failure in terminalOutcome, so that shape budgets by
    // the terminal outcome.
    const terminalFailure = observation.source === "terminal" &&
      observation.stage === "encoding" &&
      observation.terminalOutcome !== undefined;
    const failureOutcome: TelemetryOutcome | undefined = outcome !== "ok"
      ? outcome
      : terminalFailure
        ? observation.terminalOutcome
        : undefined;
    let summarizedFailure = false;
    if (failureOutcome !== undefined && this.telemetry.enabled) {
      const operation = trace.operation;
      const key = `${operation}|${observation.stage}|${failureOutcome}|${resource}`;
      let summary = this.summaries.get(key);
      if (summary === undefined) {
        summary = {
          operation,
          stage: observation.stage,
          outcome: failureOutcome,
          resource,
          exemplars: 0,
          summarized: 0,
        };
        this.summaries.set(key, summary);
      }
      if (summary.exemplars >= FAILURE_EXEMPLARS_PER_INTERVAL) {
        summarizedFailure = true;
        summary.summarized++;
        if (summary.summarized >= FAILURE_SUMMARY_FLUSH_THRESHOLD) {
          this.flushSummary(summary);
        }
      } else {
        summary.exemplars++;
      }
    }
    // A summarized observation emits no span at all: even an ok encoding span
    // can be retained once an exemplar promotes the ambient trace.
    if (!summarizedFailure) {
      const span = {
        stage: observation.stage,
        outcome,
        resource,
        durationMs: observation.durationMs,
        sizeBytes: observation.bytes,
      } as const;
      if ("trace" in trace) {
        this.tracing.span(span, fallbackOperation, trace, parentNode);
      } else {
        this.telemetry.recordSpan({
          ...span,
          operation: trace.operation,
          context: trace.context,
        });
      }
    }
    if (terminalFailure && !summarizedFailure) {
      const event = {
        name: "failure",
        level: "error",
        operation: trace.operation,
        stage: "delivery",
        outcome: observation.terminalOutcome,
        resource,
      } as const;
      if ("trace" in trace) {
        this.tracing.event(event, trace, parentNode);
      } else {
        this.telemetry.recordEvent({ ...event, context: trace.context });
      }
    }
  }

  private flushSummary(summary: DeliveryFailureSummary): void {
    if (summary.summarized > 0) {
      this.telemetry.recordMetric({
        name: "delivery.failures_coalesced",
        value: summary.summarized,
        unit: "count",
        labels: {
          operation: summary.operation,
          stage: summary.stage,
          outcome: summary.outcome,
          resource: summary.resource,
        },
        // Keep the count visible on the default local-console profile, where
        // summarized per-frame records no longer appear.
        local: true,
      });
    }
    summary.summarized = 0;
  }
}
