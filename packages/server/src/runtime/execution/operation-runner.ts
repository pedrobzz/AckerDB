import { isValidationError } from "../../validation/error.ts";
import { AckerDBError } from "../../shared/errors.ts";
import { settleOnAbort } from "../abort.ts";

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
  readonly finalize?: RuntimeOperationFinalizer<T, R>;
  readonly fairnessKey?: string;
  readonly sessionOrder?: SessionOperationOrder;
  /** Releases admission when the owning operation is cancelled. */
  readonly abortSignal?: AbortSignal;
}

interface RuntimeOperationCapabilities<Session> {
  readonly assertRequestBytes: (bytes: number) => void;
  readonly admit: (
    session: Session | null,
    fairnessKey?: string,
    sessionOrder?: SessionOperationOrder,
  ) => OperationAdmission;
}

export function transportError(error: unknown): unknown {
  return isValidationError(error)
    ? new AckerDBError("validation", error.message, { cause: error })
    : error;
}

/** Owns admission, cancellation, and finalization for every runtime operation. */
export class RuntimeOperationRunner<Session> {
  constructor(private readonly capabilities: RuntimeOperationCapabilities<Session>) {}

  run<T, R = T>(
    session: Session | null,
    sizeBytes: number,
    work: () => T | Promise<T>,
    options: RunOperationOptions<T, R> = {},
  ): Promise<R> {
    const settle = async (outcome: RuntimeOperationOutcome<T>): Promise<R> => {
      if (options.finalize !== undefined) return options.finalize(outcome);
      if (outcome.ok) return outcome.value as unknown as R;
      throw outcome.error;
    };

    let admission: OperationAdmission;
    try {
      this.capabilities.assertRequestBytes(sizeBytes);
      admission = this.capabilities.admit(
        session,
        options.fairnessKey,
        options.sessionOrder,
      );
    } catch (error) {
      return settle({ ok: false, error: transportError(error) });
    }

    const start = () => {
      if (options.abortSignal?.aborted) return Promise.reject(options.abortSignal.reason);
      return Promise.resolve().then(work);
    };
    const scheduled = admission.predecessor === undefined
      ? start()
      : admission.predecessor.then(start);
    const execution = options.abortSignal === undefined
      ? scheduled
      : settleOnAbort(scheduled, options.abortSignal);

    return execution.then(
      (value) => settle({ ok: true, value }),
      (error) => settle({ ok: false, error: transportError(error) }),
    ).finally(admission.release);
  }
}
