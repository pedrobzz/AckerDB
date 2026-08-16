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

/**
 * Refuse a millisecond value that is not one. A broken clock fails here, loudly,
 * instead of writing `NaN` into a durable row or a timer delay.
 */
export function finiteMillis(value: number, what: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${what} must be finite milliseconds`);
  return value;
}
