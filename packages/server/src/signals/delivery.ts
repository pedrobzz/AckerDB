function reportSignalFailure(error: unknown): void {
  try {
    console.log("[signal] strategy failed", error);
  } catch {
    // Signal delivery is total even when the console itself is unavailable.
  }
}

/** A signal destination never takes ownership of the operation that emitted it. */
export function totalSignal<Args extends unknown[]>(
  deliver: (...args: Args) => unknown,
): (...args: Args) => void {
  return (...args) => {
    try {
      const result = deliver(...args);
      if (
        (typeof result === "object" || typeof result === "function") &&
        result !== null &&
        typeof (result as { readonly then?: unknown }).then === "function"
      ) {
        void Promise.resolve(result).catch(reportSignalFailure);
      }
    } catch (error) {
      reportSignalFailure(error);
    }
  };
}
