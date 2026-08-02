export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

/**
 * A promise a test settles by hand, so a test can hold a server, handler, or
 * transport at an exact point instead of sleeping until it is probably there.
 * `T` defaults to `void` so `deferred()` yields a plain `resolve()` signal.
 */
export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/**
 * Polls until `predicate` holds. The deadline is a test-failure bound, not a
 * timing assertion: a test that needs to prove *when* something happened must
 * observe the transition itself rather than time this loop.
 */
export async function until(
  predicate: () => boolean,
  description: string,
  deadlineMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

/**
 * Bounds a promise a test expects to settle, so a hang fails as a named test
 * failure instead of the runner's opaque global timeout. The deadline is only
 * that bound: raising it delays a failure, it never rescues a passing test, so
 * a test asserting *when* something settled must observe it directly.
 *
 * The timer is unreferenced so a settled race never holds the loop open.
 */
export async function within<T>(
  promise: Promise<T>,
  description = "operation",
  timeoutMs = 5_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** Resolves once `signal` aborts, including when it already has. */
export function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
