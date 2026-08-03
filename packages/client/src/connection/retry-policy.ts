export interface RetryPolicy {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

/** Full-jitter retry delay, floored by an authoritative server hint. */
export function retryDelay(
  policy: RetryPolicy,
  attempt: number,
  floorMs: number,
  random: () => number,
  maximumFloorMs: number,
): number {
  const windowMs = Math.min(
    policy.maxDelayMs,
    policy.baseDelayMs * 2 ** Math.min(attempt + 1, 30),
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
