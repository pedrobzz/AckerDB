export interface RetryPolicy {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

/**
 * Full-jitter retry delay, floored by an authoritative server hint.
 *
 * `backoffStep` is the power of two the base delay is doubled by, and nothing
 * else: step 0 draws from one base delay, step 1 from two, step 2 from four, up
 * to a clamp of 30 so the shift cannot run away. Every caller keeps its own
 * counter already at that meaning, so no call site converts an attempt number
 * here — which is what let two of them drift a step apart unnoticed.
 */
export function retryDelay(
  policy: RetryPolicy,
  backoffStep: number,
  floorMs: number,
  random: () => number,
  maximumFloorMs: number,
): number {
  const windowMs = Math.min(
    policy.maxDelayMs,
    policy.baseDelayMs * 2 ** Math.min(backoffStep, 30),
  );
  const value = random();
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new RangeError("client random source is invalid");
  }
  const minimum = Math.max(
    policy.baseDelayMs,
    Math.min(Math.max(0, floorMs), maximumFloorMs),
  );
  const ceiling = Math.max(minimum, windowMs);
  return Math.min(
    maximumFloorMs,
    minimum + Math.floor(value * (ceiling - minimum + 1)),
  );
}
