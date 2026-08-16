/**
 * The one injectable clock every server component takes: current time plus the
 * timer pair, so a test drives expiry and drain deterministically.
 */
export interface Clock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const SYSTEM_CLOCK: Clock = Object.freeze({
  now: () => Date.now(),
  setTimeout: (callback: () => void, delayMs: number) => {
    const handle = setTimeout(callback, delayMs);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
});

/** The largest delay `setTimeout` can hold: a 32-bit signed millisecond count. */
export const MAX_TIMER_DELAY_MS = 0x7fff_ffff;

/**
 * Refuse a millisecond value that is not one. A broken clock fails here, loudly,
 * instead of writing `NaN` into a durable row or a timer delay.
 */
export function finiteMillis(value: number, what: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${what} must be finite milliseconds`);
  return value;
}

/**
 * Check an injected clock once, where it is injected, so every later read is
 * already a millisecond. A component wraps its `now` in its constructor and then
 * calls `this.now()` plainly — there is no second place a broken clock can slip
 * past, and no call site has to remember to check.
 */
export function finiteClock(now: () => number, what: string): () => number {
  return () => finiteMillis(now(), what);
}
