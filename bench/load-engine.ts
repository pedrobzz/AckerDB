import type { ClosedLoopResult, LatencyStats } from "./benchmark.ts";

export function latencyStats(samples: number[]): LatencyStats {
  if (samples.length === 0) {
    return { count: 0, minMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const quantile = (q: number) => sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)]!;
  return {
    count: sorted.length,
    minMs: sorted[0]!,
    p50Ms: quantile(0.5),
    p95Ms: quantile(0.95),
    p99Ms: quantile(0.99),
    maxMs: sorted[sorted.length - 1]!,
  };
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

interface ClosedLoopOptions<T> {
  durationMs: number;
  slots: number;
  drainTimeoutMs: number;
  onWindowStart?(timestampMs: number): void;
  operation(slot: number, sequence: number): Promise<T>;
  validate?(value: T, slot: number, sequence: number): void;
}

export async function runClosedLoop<T>(options: ClosedLoopOptions<T>): Promise<ClosedLoopResult> {
  const startedAt = performance.now();
  const deadline = startedAt + options.durationMs;
  const windowStartedAtMs = performance.timeOrigin + startedAt;
  options.onWindowStart?.(windowStartedAtMs);
  let sequence = 0;
  let attempted = 0;
  let completedInWindow = 0;
  let completedAfterWindow = 0;
  let failed = 0;
  const errors: string[] = [];
  const latencies: number[] = [];

  const workers = Array.from({ length: options.slots }, async (_, slot) => {
    for (;;) {
      const operationStartedAt = performance.now();
      if (operationStartedAt >= deadline) return;
      const currentSequence = sequence++;
      attempted++;
      try {
        const value = await options.operation(slot, currentSequence);
        options.validate?.(value, slot, currentSequence);
        const completedAt = performance.now();
        latencies.push(completedAt - operationStartedAt);
        if (completedAt <= deadline) completedInWindow++;
        else completedAfterWindow++;
      } catch (error) {
        failed++;
        if (errors.length < 8) errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  });

  await withTimeout(Promise.all(workers), options.durationMs + options.drainTimeoutMs, "closed-loop drain");
  return {
    windowStartedAtMs,
    windowEndedAtMs: windowStartedAtMs + options.durationMs,
    wallMs: options.durationMs,
    attempted,
    completedInWindow,
    completedAfterWindow,
    failed,
    throughputPerSec: completedInWindow / (options.durationMs / 1_000),
    latency: latencyStats(latencies),
    errors,
  };
}
