/**
 * One answer to "the work failed and so did the cleanup". A lone failure travels
 * alone; two failures travel together so neither is masked by the other.
 */

/** Combine a primary failure with whatever the cleanup that followed it added. */
export function combinedFailure(
  primary: unknown,
  cleanupFailures: readonly unknown[],
  message: string,
): unknown {
  if (cleanupFailures.length === 0) return primary;
  return new AggregateError([primary, ...cleanupFailures], message);
}

/** Run work, then cleanup whatever happened; both failures survive together. */
export function runWithCleanup<T>(
  work: () => T,
  cleanup: () => void,
  message: string,
): T {
  let failed = false;
  let failure: unknown;
  let value: T | undefined;
  try {
    value = work();
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    cleanup();
  } catch (cleanupError) {
    if (failed) throw combinedFailure(failure, [cleanupError], message);
    throw cleanupError;
  }
  if (failed) throw failure;
  return value!;
}

/** The asynchronous twin: the cleanup runs after the work settles, either way. */
export async function runWithCleanupAsync<T>(
  work: () => T | Promise<T>,
  cleanup: () => void | Promise<void>,
  message: string,
): Promise<T> {
  let failed = false;
  let failure: unknown;
  let value: T | undefined;
  try {
    value = await work();
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    await cleanup();
  } catch (cleanupError) {
    if (failed) throw combinedFailure(failure, [cleanupError], message);
    throw cleanupError;
  }
  if (failed) throw failure;
  return value!;
}

/**
 * Run work that owns something on success — an artifact left on disk, a handle
 * returned to the caller — and discard it only when the work fails.
 */
export function cleanupOnFailure<T>(
  work: () => T,
  cleanup: () => void,
  message: string,
): T {
  try {
    return work();
  } catch (failure) {
    try {
      cleanup();
    } catch (cleanupError) {
      throw combinedFailure(failure, [cleanupError], message);
    }
    throw failure;
  }
}
