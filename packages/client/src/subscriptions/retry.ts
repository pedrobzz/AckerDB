import { retryDelay, type RetryPolicy } from "../connection/retry-policy.ts";

export interface SubscriptionRetryClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SubscriptionRetryState {
  /** The next delay's backoff step; 1 is the first retry after a settled stream. */
  backoffStep: number;
  handle?: unknown;
  notBeforeMs?: number;
}

export function createSubscriptionRetryState(): SubscriptionRetryState {
  return { backoffStep: 1 };
}

/** Owns retry deadlines and timers while the subscription owns logical demand. */
export class SubscriptionRetryScheduler {
  constructor(
    private readonly clock: SubscriptionRetryClock,
    private readonly policy: RetryPolicy,
    private readonly random: () => number,
    private readonly maximumDelayMs: number,
  ) {}

  waiting(state: SubscriptionRetryState): boolean {
    return state.notBeforeMs !== undefined;
  }

  schedule(state: SubscriptionRetryState, floorMs: number): void {
    if (state.notBeforeMs !== undefined) return;
    const delay = retryDelay(
      this.policy,
      state.backoffStep,
      floorMs,
      this.random,
      this.maximumDelayMs,
    );
    state.backoffStep++;
    state.notBeforeMs = this.clock.now() + delay;
  }

  arm(state: SubscriptionRetryState, retry: () => void): void {
    if (state.handle !== undefined || state.notBeforeMs === undefined) return;
    const remainingMs = Math.max(0, state.notBeforeMs - this.clock.now());
    state.handle = this.clock.setTimeout(() => {
      state.handle = undefined;
      state.notBeforeMs = undefined;
      retry();
    }, remainingMs);
  }

  settle(state: SubscriptionRetryState): void {
    state.backoffStep = 1;
    this.clear(state);
  }

  clear(state: SubscriptionRetryState): void {
    this.pause(state);
    state.notBeforeMs = undefined;
  }

  pause(state: SubscriptionRetryState): void {
    if (state.handle === undefined) return;
    this.clock.clearTimeout(state.handle);
    state.handle = undefined;
  }
}
