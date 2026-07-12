/**
 * The benchmark workload, identical for both systems. An adapter provides
 * `mutate` (insert one row, awaited round-trip) and `subscribeTop` (reactive
 * top-20-by-seq subscription).
 *
 * Phase 1 — mutation round-trips: N sequential awaited inserts.
 * Phase 2 — subscription latency: mutate with a monotonically increasing
 * `seq` and time until the subscription callback observes it. (Monotonic seq
 * guarantees every mutation changes the top-20 result — an unchanged result
 * is legitimately never pushed.)
 */
export interface BenchAdapter {
  mutate(seq: number): Promise<unknown>;
  subscribeTop(onRows: (maxSeq: number) => void): () => void;
  close(): void;
}

export interface WorkloadResult {
  mutations: number;
  mutationsPerSec: number;
  mutationMeanMs: number;
  subLatencyP50Ms: number;
  subLatencyP95Ms: number;
}

const quantile = (sorted: number[], q: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;

export async function runWorkload(adapter: BenchAdapter, mutations = 1500, rounds = 100): Promise<WorkloadResult> {
  // phase 1: sequential mutation round-trips
  const t0 = performance.now();
  for (let i = 0; i < mutations; i++) await adapter.mutate(i);
  const mutMs = performance.now() - t0;

  // phase 2: subscription update latency
  let waiter: { seq: number; resolve: () => void } | null = null;
  const unsubscribe = adapter.subscribeTop((maxSeq) => {
    if (waiter !== null && maxSeq >= waiter.seq) {
      const w = waiter;
      waiter = null;
      w.resolve();
    }
  });
  await new Promise((r) => setTimeout(r, 300)); // initial snapshot settles
  const latencies: number[] = [];
  for (let i = 0; i < rounds; i++) {
    const seq = mutations + i;
    const t = performance.now();
    const observed = new Promise<void>((resolve) => {
      waiter = { seq, resolve };
    });
    await adapter.mutate(seq);
    await observed;
    latencies.push(performance.now() - t);
  }
  unsubscribe();
  latencies.sort((a, b) => a - b);
  return {
    mutations,
    mutationsPerSec: Math.round(mutations / (mutMs / 1000)),
    mutationMeanMs: mutMs / mutations,
    subLatencyP50Ms: quantile(latencies, 0.5),
    subLatencyP95Ms: quantile(latencies, 0.95),
  };
}
