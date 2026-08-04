import type { TelemetryScheduler } from "../contracts/types.ts";

export interface AbsoluteDeadline {
  readonly reached: Promise<void>;
  readonly expired: () => boolean;
  close(): void;
}

export function createAbsoluteDeadline(
  scheduler: TelemetryScheduler,
  now: () => number | undefined,
  deadlineAtMs: number,
  observeInvalidClock: () => void,
): AbsoluteDeadline {
  let reachedDeadline = false;
  let timeoutHandle: unknown;
  let timeoutScheduled = false;
  let resolveReached!: () => void;
  const reached = new Promise<void>((resolve) => {
    resolveReached = resolve;
  });
  const expire = (): void => {
    if (reachedDeadline) return;
    reachedDeadline = true;
    resolveReached();
  };
  const initialNow = now();
  if (!Number.isFinite(deadlineAtMs) || initialNow === undefined) {
    observeInvalidClock();
    expire();
  } else if (deadlineAtMs <= initialNow) {
    expire();
  } else {
    try {
      timeoutHandle = scheduler.setTimeout(expire, deadlineAtMs - initialNow);
      timeoutScheduled = true;
    } catch {
      expire();
    }
  }

  return {
    reached,
    expired: () => {
      if (reachedDeadline) return true;
      const currentNow = now();
      if (currentNow === undefined) {
        observeInvalidClock();
        expire();
      } else if (currentNow >= deadlineAtMs) {
        expire();
      }
      return reachedDeadline;
    },
    close: () => {
      if (!timeoutScheduled) return;
      timeoutScheduled = false;
      try {
        scheduler.clearTimeout(timeoutHandle);
      } catch {
        // Cleanup faults must not turn shutdown into a rejection.
      }
    },
  };
}
