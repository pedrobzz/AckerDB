import type { ClaimedHttpTrace } from "../../telemetry/external-trace.ts";
import { finishClaimedHttpTrace } from "../../telemetry/external-trace.ts";
import {
  FINISH_OPERATION_TRACE,
  OPERATION_TRACE_CONTEXT,
  RECORD_OPERATION_SPAN,
  type Telemetry,
  type TelemetryOperation,
  type TelemetryOutcome,
} from "../../telemetry/telemetry.ts";
import { isValidationError } from "../../validation/error.ts";
import { AckerDBError } from "../../shared/errors.ts";
import { settleOnAbort } from "../abort.ts";
import { outcomeFromError } from "../outcome.ts";
import type {
  RuntimeTraceBridge,
  RuntimeTraceIdentifiers,
  RuntimeTraceScope,
} from "../telemetry/trace-bridge.ts";

export type RuntimeOperationOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

export type RuntimeOperationFinalizer<T, R> = (
  outcome: RuntimeOperationOutcome<T>,
) => R | Promise<R>;

export type SessionOperationOrder =
  | { readonly kind: "subscription-control"; readonly id: number }
  | { readonly kind: "subscription-frontier" };

export interface OperationAdmission {
  readonly predecessor: Promise<void> | undefined;
  release(): void;
}

export interface RunOperationOptions<T, R> {
  readonly identifiers?: RuntimeTraceIdentifiers;
  readonly synthesizeHandler?: boolean;
  readonly finalize?: RuntimeOperationFinalizer<T, R>;
  readonly claimedTrace?: ClaimedHttpTrace;
  readonly fairnessKey?: string;
  readonly sessionOrder?: SessionOperationOrder;
  /** Releases admission when the owning operation is cancelled. */
  readonly abortSignal?: AbortSignal;
}

export interface RuntimeOperationSession {
  readonly telemetryConnectionId?: string;
}

interface RuntimeOperationCapabilities<Session extends RuntimeOperationSession> {
  readonly telemetry: Telemetry;
  readonly tracing: RuntimeTraceBridge;
  readonly assertRequestBytes: (bytes: number) => void;
  readonly admit: (
    session: Session | null,
    fairnessKey?: string,
    sessionOrder?: SessionOperationOrder,
  ) => OperationAdmission;
  /** Error-group ingest for unhandled failures; expected outcomes never join. */
  readonly captureError?: (
    error: unknown,
    functionName: string | undefined,
    traceId: string | undefined,
  ) => void;
}

/** Unhandled failures group; expected outcomes stay error rates in Traces. */
function isUnhandledFailure(outcome: TelemetryOutcome): boolean {
  return outcome === "internal" || outcome === "application_error";
}

export function transportError(error: unknown): unknown {
  return isValidationError(error)
    ? new AckerDBError("validation", error.message, { cause: error })
    : error;
}

/** Owns admission, trace lifetime, cancellation, and finalization for every runtime operation. */
export class RuntimeOperationRunner<Session extends RuntimeOperationSession> {
  constructor(private readonly capabilities: RuntimeOperationCapabilities<Session>) {}

  private traceId(scope: RuntimeTraceScope | undefined): string | undefined {
    if (scope === undefined) return undefined;
    return this.capabilities.telemetry[OPERATION_TRACE_CONTEXT](scope.trace, 0)?.traceId;
  }

  run<T, R = T>(
    session: Session | null,
    operation: TelemetryOperation,
    functionName: string | undefined,
    sizeBytes: number,
    work: () => T | Promise<T>,
    options: RunOperationOptions<T, R> = {},
  ): Promise<R> {
    const { telemetry, tracing } = this.capabilities;
    const identifiers = options.identifiers ?? {};
    const synthesizeHandler = options.synthesizeHandler ?? true;
    const finalize = options.finalize;
    const claimedTrace = options.claimedTrace;
    const runtimeScope = tracing.open(
      session?.telemetryConnectionId,
      operation,
      functionName,
      identifiers,
      claimedTrace?.context,
    );
    const observedScope = telemetry.enabled ? runtimeScope : undefined;
    const finishOperationTrace = <V>(result: Promise<V>): Promise<V> =>
      claimedTrace !== undefined
        ? result.finally(() => finishClaimedHttpTrace(claimedTrace))
        : observedScope !== undefined
          ? result.finally(() => {
              telemetry[FINISH_OPERATION_TRACE](observedScope.trace);
            })
          : result;
    const admittedAt = observedScope === undefined ? 0 : performance.now();
    const settle = async (outcome: RuntimeOperationOutcome<T>): Promise<R> => {
      if (finalize !== undefined) return finalize(outcome);
      if (outcome.ok) return outcome.value as unknown as R;
      throw outcome.error;
    };
    let admission: OperationAdmission;
    try {
      this.capabilities.assertRequestBytes(sizeBytes);
      admission = this.capabilities.admit(session, options.fairnessKey, options.sessionOrder);
      if (observedScope !== undefined) {
        telemetry[RECORD_OPERATION_SPAN](observedScope.trace, 0, 0, {
          operation,
          stage: "admission",
          outcome: "ok",
          functionName,
          resource: "operation",
          durationMs: Math.max(0, performance.now() - admittedAt),
          sizeBytes,
        });
      }
    } catch (error) {
      const safeError = transportError(error);
      const outcome: TelemetryOutcome = outcomeFromError(safeError).code;
      if (isUnhandledFailure(outcome)) {
        this.capabilities.captureError?.(safeError, functionName, this.traceId(observedScope));
      }
      if (observedScope !== undefined) {
        telemetry[RECORD_OPERATION_SPAN](observedScope.trace, 0, 0, {
          operation,
          stage: "admission",
          outcome,
          functionName,
          resource: "operation",
          durationMs: Math.max(0, performance.now() - admittedAt),
          sizeBytes,
        });
        tracing.event({
          name: outcome === "overloaded" ? "overload" : "failure",
          level: outcome === "overloaded" ? "warn" : "error",
          operation,
          stage: "admission",
          outcome,
          ...(functionName === undefined ? {} : { functionName }),
          resource: "operation",
          errorClass: safeError instanceof Error ? safeError.name : "UnknownError",
        }, observedScope, 0);
      }
      const rejected = () => settle({ ok: false, error: safeError });
      return finishOperationTrace(tracing.runOperation(runtimeScope, rejected));
    }
    const startedAt = observedScope === undefined ? 0 : performance.now();
    const start = () => {
      if (options.abortSignal?.aborted) return Promise.reject(options.abortSignal.reason);
      return Promise.resolve().then(work);
    };
    const scheduled = () => (admission.predecessor === undefined
      ? start()
      : admission.predecessor.then(start));
    const execute = () => (
      options.abortSignal === undefined
        ? scheduled()
        : settleOnAbort(scheduled(), options.abortSignal)
    )
      .then(
        (value): RuntimeOperationOutcome<T> => {
          if (
            observedScope !== undefined &&
            synthesizeHandler &&
            observedScope.invocations === 0
          ) {
            tracing.span({
              stage: "handler",
              outcome: "ok",
              durationMs: Math.max(0, performance.now() - startedAt),
              sizeBytes,
            }, operation);
          }
          return { ok: true, value };
        },
        (error): RuntimeOperationOutcome<T> => {
          const safeError = transportError(error);
          const outcome: TelemetryOutcome = outcomeFromError(safeError).code;
          if (isUnhandledFailure(outcome)) {
            this.capabilities.captureError?.(safeError, functionName, this.traceId(observedScope));
          }
          if (observedScope !== undefined) {
            if (synthesizeHandler && observedScope.invocations === 0) {
              tracing.span({
                stage: "handler",
                outcome,
                durationMs: Math.max(0, performance.now() - startedAt),
                sizeBytes,
              }, operation);
            }
            tracing.event({
              name: outcome === "overloaded" ? "overload" : "failure",
              level: outcome === "overloaded" ? "warn" : "error",
              operation,
              outcome,
              ...(functionName === undefined ? {} : { functionName }),
              errorClass: safeError instanceof Error ? safeError.name : "UnknownError",
            }, observedScope);
          }
          return { ok: false, error: safeError };
        },
      )
      .then(settle)
      .finally(admission.release);
    return finishOperationTrace(tracing.runOperation(runtimeScope, execute));
  }
}
