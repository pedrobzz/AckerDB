import { createHash } from "node:crypto";
import { outcomeFromError } from "../runtime/outcome.ts";
import type {
  AuthenticationAttemptInput,
  AuthenticationAttemptObservation,
} from "../auth/attempt-observation.ts";
import {
  FINISH_OPERATION_TRACE,
  IDENTIFY_OPERATION_TRACE,
  OPEN_OPERATION_TRACE,
  RECORD_OPERATION_EVENT,
  RECORD_OPERATION_SPAN,
  deriveTelemetryTraceContext,
  prepareTelemetryTraceContext,
  RECORD_PREPARED_SPAN,
  type OperationTraceHandle,
  type PreparedTelemetryTraceContext,
  type Telemetry,
  type TelemetryOperation,
  type TelemetryOutcome,
  type TelemetryResource,
} from "./telemetry.ts";

type HttpOperation = "query" | "mutation" | "procedure" | "sse";
type HttpTracePhase = "external" | "runtime" | "finished";

interface HttpTraceState {
  readonly telemetry: Telemetry;
  readonly operation: HttpOperation;
  readonly startedAt: number;
  readonly trace: OperationTraceHandle;
  functionName: string;
  phase: HttpTracePhase;
  failureRecorded: boolean;
}

const HTTP_TRACE_STATE: unique symbol = Symbol("ackerdb.httpTraceState");
const CLAIMED_TRACE_STATE: unique symbol = Symbol("ackerdb.claimedHttpTraceState");

/** Package-internal opaque ownership token passed from Serve to Runtime. */
export interface ExternalHttpTrace {
  readonly [HTTP_TRACE_STATE]: HttpTraceState;
}

export interface ClaimedHttpTrace {
  readonly trace: OperationTraceHandle;
  readonly [CLAIMED_TRACE_STATE]: HttpTraceState;
}

function durationSince(startedAt: number): number {
  return Math.max(0, performance.now() - startedAt);
}

function finishState(state: HttpTraceState): void {
  if (state.phase === "finished") return;
  state.phase = "finished";
  try {
    state.telemetry[FINISH_OPERATION_TRACE](state.trace);
  } catch {
    // Trace retention is fail-open and ownership is already terminal.
  }
}

function recordOperationFailureEvent(
  state: HttpTraceState,
  stage: "admission" | "auth",
  outcome: TelemetryOutcome,
  resource: TelemetryResource,
  error: unknown,
): void {
  state.telemetry[RECORD_OPERATION_EVENT](state.trace, 0, {
    name: "failure",
    level: "error",
    operation: state.operation,
    stage,
    outcome,
    functionName: state.functionName,
    resource,
    errorClass: error instanceof Error ? error.name : "UnknownError",
  });
}

function recordFailureEvent(
  telemetry: Telemetry,
  operation: TelemetryOperation,
  functionName: string,
  context: PreparedTelemetryTraceContext,
  outcome: TelemetryOutcome,
  resource: TelemetryResource,
  error: unknown,
): void {
  telemetry.recordEvent({
    name: "failure",
    level: "error",
    operation,
    stage: "auth",
    outcome,
    functionName,
    resource,
    context,
    errorClass: error instanceof Error ? error.name : "UnknownError",
  });
}

export function beginHttpTrace(
  telemetry: Telemetry,
  operation: HttpOperation,
): ExternalHttpTrace | undefined {
  if (!telemetry.enabled) return undefined;
  try {
    const state: HttpTraceState = {
      telemetry,
      operation,
      startedAt: performance.now(),
      trace: telemetry[OPEN_OPERATION_TRACE]({
        operation,
        functionName: `http.${operation}`,
      }),
      functionName: `http.${operation}`,
      phase: "external",
      failureRecorded: false,
    };
    return Object.freeze({ [HTTP_TRACE_STATE]: state });
  } catch {
    return undefined;
  }
}

export function identifyHttpTrace(
  trace: ExternalHttpTrace | undefined,
  functionName: string,
  requestId: string,
): void {
  const state = trace?.[HTTP_TRACE_STATE];
  if (state?.phase !== "external") return;
  state.functionName = functionName;
  state.telemetry[IDENTIFY_OPERATION_TRACE](state.trace, functionName, requestId);
}

export async function observeHttpAuth<T>(
  trace: ExternalHttpTrace | undefined,
  work: () => T | Promise<T>,
): Promise<T> {
  const state = trace?.[HTTP_TRACE_STATE];
  if (state?.phase !== "external") return work();
  const startedAt = performance.now();
  try {
    const value = await work();
    try {
      state.telemetry[RECORD_OPERATION_SPAN](state.trace, -1, 0, {
        operation: state.operation,
        stage: "auth",
        outcome: "ok",
        functionName: state.functionName,
        resource: "operation",
        durationMs: durationSince(startedAt),
      });
    } catch {
      // Telemetry cannot change credential verification semantics.
    }
    return value;
  } catch (error) {
    state.failureRecorded = true;
    try {
      const outcome = outcomeFromError(error).code;
      state.telemetry[RECORD_OPERATION_SPAN](state.trace, -1, 0, {
        operation: state.operation,
        stage: "auth",
        outcome,
        functionName: state.functionName,
        resource: "operation",
        durationMs: durationSince(startedAt),
      });
      recordOperationFailureEvent(state, "auth", outcome, "operation", error);
    } catch {
      // Telemetry cannot replace the owning authentication failure.
    }
    throw error;
  }
}

export function recordHttpTraceFailure(
  trace: ExternalHttpTrace | undefined,
  error: unknown,
): void {
  const state = trace?.[HTTP_TRACE_STATE];
  if (state?.phase !== "external" || state.failureRecorded) return;
  state.failureRecorded = true;
  try {
    const safe = outcomeFromError(error);
    const resource = safe.resource ?? "operation";
    state.telemetry[RECORD_OPERATION_SPAN](state.trace, -1, 0, {
      operation: state.operation,
      stage: "admission",
      outcome: safe.code,
      functionName: state.functionName,
      resource,
      durationMs: durationSince(state.startedAt),
    });
    recordOperationFailureEvent(state, "admission", safe.code, resource, error);
  } catch {
    // Transport failure ownership remains with Serve.
  }
}

export function finishHttpTrace(trace: ExternalHttpTrace | undefined): void {
  const state = trace?.[HTTP_TRACE_STATE];
  if (state?.phase === "external") finishState(state);
}

export function claimHttpTrace(
  trace: ExternalHttpTrace | undefined,
  operation: HttpOperation,
  functionName: string,
  requestId: string,
): ClaimedHttpTrace | undefined {
  const state = trace?.[HTTP_TRACE_STATE];
  if (state?.phase !== "external" || state.operation !== operation) return undefined;
  identifyHttpTrace(trace, functionName, requestId);
  state.phase = "runtime";
  return Object.freeze({
    trace: state.trace,
    [CLAIMED_TRACE_STATE]: state,
  });
}

export function finishClaimedHttpTrace(trace: ClaimedHttpTrace | undefined): void {
  const state = trace?.[CLAIMED_TRACE_STATE];
  if (state?.phase === "runtime") finishState(state);
}

export function beginSessionAuthTrace(
  telemetry: Telemetry,
  input: AuthenticationAttemptInput,
): AuthenticationAttemptObservation | undefined {
  if (!telemetry.enabled) return undefined;
  try {
    const context = prepareTelemetryTraceContext({
      connectionId: createHash("sha256").update(input.clientSessionId).digest("base64url"),
      requestId: input.attemptId === undefined ? "hello" : String(input.attemptId),
    });
    const functionName = `ws.${input.kind}`;
    const startedAt = performance.now();
    const opened = telemetry.beginTrace(context);
    let finished = false;
    return Object.freeze({
      finish(error?: unknown): void {
        if (finished) return;
        finished = true;
        try {
          const outcome = error === undefined ? "ok" : outcomeFromError(error).code;
          telemetry[RECORD_PREPARED_SPAN]({
            operation: "lifecycle",
            stage: "auth",
            outcome,
            functionName,
            resource: "connection",
            context,
            durationMs: durationSince(startedAt),
          });
          if (error !== undefined) {
            recordFailureEvent(
              telemetry,
              "lifecycle",
              functionName,
              context,
              outcome,
              "connection",
              error,
            );
          }
        } catch {
          // Session authentication remains fail-open to observation failures.
        } finally {
          if (opened) {
            try {
              telemetry.finishTrace(context);
            } catch {
              // Ownership is terminal even when trace retention rejects cleanup.
            }
          }
        }
      },
    });
  } catch {
    return undefined;
  }
}
