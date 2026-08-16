/**
 * Give the caller its answer back the moment its signal aborts, and never leave
 * the value the late promise still delivers unowned: `onLate` disposes of it.
 * The abort error is read at abort time, so a reason set by the abort itself
 * is the one thrown.
 */
export async function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  abortError: () => unknown,
  onLate?: (value: T) => void,
): Promise<T> {
  const discard = (value: T): never => {
    try {
      onLate?.(value);
    } catch {
      // Late external values cannot regain ownership or replace the cancellation outcome.
    }
    throw abortError();
  };
  const observed = promise.then((value) => (signal.aborted ? discard(value) : value));
  if (signal.aborted) {
    void observed.catch(() => {});
    throw abortError();
  }
  const interrupted = Promise.withResolvers<never>();
  const onAbort = (): void => interrupted.reject(abortError());
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const value = await Promise.race([observed, interrupted.promise]);
    return signal.aborted ? discard(value) : value;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
