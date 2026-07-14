import { createHash } from "node:crypto";
import { outcomeFromError } from "./outcome.ts";
import type {
  SessionAuthAttemptInput,
  SessionAuthAttemptObservation,
} from "./session.ts";
import {
  deriveTelemetryTraceContext,
  prepareTelemetryTraceContext,
  RECORD_PREPARED_SPAN,
  type PreparedTelemetryTraceContext,
  type Telemetry,
  type TelemetryOperation,
  type TelemetryOutcome,
  type TelemetryResource,
} from "./telemetry.ts";

type HttpOperation = "procedure" | "sse";
type HttpTracePhase = "external" | "runtime" | "finished";

interface HttpTraceState {
  readonly telemetry: Telemetry;
  readonly operation: HttpOperation;
  readonly startedAt: number;
  readonly opened: boolean;
  context: PreparedTelemetryTraceContext;
  functionName: string;
  phase: HttpTracePhase;
  failureRecorded: boolean;
}

const HTTP_TRACE_STATE: unique symbol = Symbol("dbzz.httpTraceState");
const CLAIMED_TRACE_STATE: unique symbol = Symbol("dbzz.claimedHttpTraceState");

/** Package-internal opaque ownership token passed from Serve to Runtime. */
export interface ExternalHttpTrace {
  readonly [HTTP_TRACE_STATE]: HttpTraceState;
}

export interface ClaimedHttpTrace {
  readonly context: PreparedTelemetryTraceContext;
  readonly [CLAIMED_TRACE_STATE]: HttpTraceState;
}

function durationSince(startedAt: number): number {
  return Math.max(0, performance.now() - startedAt);
}

function finishState(state: HttpTraceState): void {
  if (state.phase === "finished") return;
  state.phase = "finished";
  if (!state.opened) return;
  try {
    state.telemetry.finishTrace(state.context);
  } catch {
    // Trace retention is fail-open and ownership is already terminal.
  }
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
    const context = prepareTelemetryTraceContext();
    const state: HttpTraceState = {
      telemetry,
      operation,
      startedAt: performance.now(),
      opened: telemetry.beginTrace(context),
      context,
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
  state.context = prepareTelemetryTraceContext({ ...state.context, requestId });
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
      state.telemetry[RECORD_PREPARED_SPAN]({
        operation: state.operation,
        stage: "auth",
        outcome: "ok",
        functionName: state.functionName,
        resource: "operation",
        context: deriveTelemetryTraceContext(state.context),
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
      const context = deriveTelemetryTraceContext(state.context);
      state.telemetry[RECORD_PREPARED_SPAN]({
        operation: state.operation,
        stage: "auth",
        outcome,
        functionName: state.functionName,
        resource: "operation",
        context,
        durationMs: durationSince(startedAt),
      });
      recordFailureEvent(
        state.telemetry,
        state.operation,
        state.functionName,
        context,
        outcome,
        "operation",
        error,
      );
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
    const context = deriveTelemetryTraceContext(state.context);
    const resource = safe.resource ?? "operation";
    state.telemetry[RECORD_PREPARED_SPAN]({
      operation: state.operation,
      stage: "admission",
      outcome: safe.code,
      functionName: state.functionName,
      resource,
      context,
      durationMs: durationSince(state.startedAt),
    });
    state.telemetry.recordEvent({
      name: "failure",
      level: "error",
      operation: state.operation,
      stage: "admission",
      outcome: safe.code,
      functionName: state.functionName,
      resource,
      context,
      errorClass: error instanceof Error ? error.name : "UnknownError",
    });
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
    context: state.context,
    [CLAIMED_TRACE_STATE]: state,
  });
}

export function finishClaimedHttpTrace(trace: ClaimedHttpTrace | undefined): void {
  const state = trace?.[CLAIMED_TRACE_STATE];
  if (state?.phase === "runtime") finishState(state);
}

export function beginSessionAuthTrace(
  telemetry: Telemetry,
  input: SessionAuthAttemptInput,
): SessionAuthAttemptObservation | undefined {
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
