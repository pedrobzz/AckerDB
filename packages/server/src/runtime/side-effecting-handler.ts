import {
  AckerDBError,
  isAckerDBError,
  throwIfAborted,
} from "../shared/errors.ts";

type SideEffectingHandlerKind =
  | "procedure"
  | "http handler"
  | "system callback";

function canceledHandlerOutcome(
  signal: AbortSignal,
  kind: SideEffectingHandlerKind,
  cause: unknown,
): AckerDBError {
  const reason = signal.reason;
  if (
    isAckerDBError(reason) &&
    (
      reason.code === "unauthenticated" ||
      reason.code === "unauthorized" ||
      reason.code === "auth_unavailable"
    )
  ) {
    return reason;
  }
  return new AckerDBError(
    "indeterminate",
    `${kind} completion is unknown after cancellation`,
    { resource: "operation", cause },
  );
}

/**
 * Before policy admission, cancellation is determinate. Once a side-effecting
 * handler starts, transport cancellation cannot prove whether external work
 * committed; authoritative authentication revocation remains fail-closed.
 */
export async function invokeSideEffectingHandler<Value>(
  signal: AbortSignal,
  kind: SideEffectingHandlerKind,
  invoke: (onAuthorized: () => void) => Promise<Value>,
): Promise<Value> {
  let handlerStarted = false;
  let value: Value;
  try {
    value = await invoke(() => {
      throwIfAborted(signal);
      handlerStarted = true;
    });
  } catch (cause) {
    if (!handlerStarted || !signal.aborted) throw cause;
    throw canceledHandlerOutcome(signal, kind, cause);
  }
  if (signal.aborted) {
    throw canceledHandlerOutcome(signal, kind, signal.reason);
  }
  return value;
}
