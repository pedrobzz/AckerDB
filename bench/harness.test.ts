import { describe, expect, test } from "bun:test";
import { subscriptionCapacitySlots, type BenchmarkConfig } from "./benchmark.ts";
import { latencyStats, median, runClosedLoop } from "./load-engine.ts";
import { ProcessTreeMonitor, parseProcessTable, parsePsDuration, readProcessTable } from "./process-tree.ts";

describe("latency statistics", () => {
  test("uses exact nearest-rank percentiles without mutating input", () => {
    const samples = [10, 1, 7, 3, 5];
    expect(latencyStats(samples)).toEqual({
      count: 5,
      minMs: 1,
      p50Ms: 5,
      p95Ms: 10,
      p99Ms: 10,
      maxMs: 10,
    });
    expect(samples).toEqual([10, 1, 7, 3, 5]);
  });

  test("computes odd and even medians", () => {
    expect(median([9, 1, 5])).toBe(5);
    expect(median([9, 1, 5, 3])).toBe(4);
  });
});

describe("closed-loop accounting", () => {
  test("accounts for every attempted request and exposes an exact epoch window", async () => {
    let emittedStart = 0;
    const signals = new Set<AbortSignal>();
    const result = await runClosedLoop({
      phaseId: "accounting",
      durationMs: 20,
      slots: 2,
      drainTimeoutMs: 1_000,
      cancel: () => {
        throw new Error("successful work must not cancel");
      },
      onWindowStart: (timestampMs) => {
        emittedStart = timestampMs;
      },
      operation: async (_slot, sequence, cancellation) => {
        signals.add(cancellation.signal);
        return sequence;
      },
      validate: (value, _slot, sequence) => {
        if (value !== sequence) throw new Error(`sequence ${value} != ${sequence}`);
      },
    });

    expect(result.attempted).toBe(result.completedInWindow + result.completedAfterWindow + result.failed);
    expect(result.failed).toBe(0);
    expect(result.windowStartedAtMs).toBe(emittedStart);
    expect(result.windowEndedAtMs - result.windowStartedAtMs).toBe(20);
    expect(signals.size).toBe(1);
    expect([...signals][0]!.aborted).toBe(false);
  });

  test("aborts timed-out operations and settles every closed-loop worker", async () => {
    let active = 0;
    let finished = 0;
    let attempts = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const signals = new Set<AbortSignal>();
    let thrown: unknown;

    try {
      await runClosedLoop({
        phaseId: "subscriptions:partitioned:capacity-500",
        durationMs: 10,
        slots: 3,
        drainTimeoutMs: 10,
        cancel: () => release(),
        operation: async (_slot, _sequence, cancellation) => {
          attempts++;
          active++;
          signals.add(cancellation.signal);
          try {
            await gate;
          } finally {
            active--;
            finished++;
          }
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(
      "phase subscriptions:partitioned:capacity-500 exceeded 10ms window + 10ms drain: " +
        "3 attempted, 0 settled, 3 in flight",
    );
    expect({ active, attempts, finished }).toEqual({ active: 0, attempts: 3, finished: 3 });
    expect(signals.size).toBe(1);
    const [signal] = signals;
    expect(signal!.aborted).toBe(true);
    expect(signal!.reason).toBe(thrown);
  });

  test("aborts benchmark-owned delivery waits without detaching the operation", async () => {
    let active = 0;
    let signal: AbortSignal | undefined;
    let thrown: unknown;

    try {
      await runClosedLoop({
        phaseId: "subscriptions:shared:capacity-50",
        durationMs: 10,
        slots: 1,
        drainTimeoutMs: 10,
        cancel: () => {},
        operation: async (_slot, _sequence, cancellation) => {
          signal = cancellation.signal;
          active++;
          try {
            await cancellation.wait(new Promise<never>(() => {}));
          } finally {
            active--;
          }
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(active).toBe(0);
    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toBe(thrown);
  });
});

describe("subscription saturation profiles", () => {
  test("caps writer slots at the distinct channels available to each pattern", () => {
    const config: BenchmarkConfig["subscriptions"] = {
      users: 10,
      queriesPerUser: 5,
      durationMs: 500,
      sharedUpdatesPerSec: 5,
      partitionedUpdatesPerSec: 10,
      capacityDurationMs: 500,
      capacitySlots: [1, 8, 32, 512],
      setupTimeoutMs: 1_000,
      drainTimeoutMs: 1_000,
      patterns: ["shared", "partitioned"],
    };

    expect(subscriptionCapacitySlots(config, "shared")).toEqual([1, 5]);
    expect(subscriptionCapacitySlots(config, "partitioned")).toEqual([1, 8, 10]);
  });
});

describe("process-tree sampling", () => {
  test("parses macOS ps durations and rows", () => {
    expect(parsePsDuration("01:02")).toBe(62);
    expect(parsePsDuration("02:03:04.50")).toBe(7_384.5);
    expect(parsePsDuration("1-02:03:04")).toBe(93_784);
    expect(parseProcessTable("  10  1  2048  00:01.25  00:10\n").get(10)).toEqual({
      pid: 10,
      ppid: 1,
      rssMb: 2,
      cpuSeconds: 1.25,
      elapsedSeconds: 10,
    });
  });

  test("shares one process-table read across multiple tree monitors", () => {
    const table = readProcessTable();
    const first = new ProcessTreeMonitor(process.pid).sampleNow(table);
    const second = new ProcessTreeMonitor(process.pid).sampleNow(table);
    expect(first.timestampMs).toBe(second.timestampMs);
    expect(first.processCount).toBeGreaterThanOrEqual(1);
    expect(second.processCount).toBe(first.processCount);
  });
});
