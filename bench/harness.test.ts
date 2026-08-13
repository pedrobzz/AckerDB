import { describe, expect, test } from "bun:test";
import {
  documentPayload,
  documentScore,
  searchChecksum,
  subscriptionCapacitySlots,
  type BenchAdapter,
  type BenchConnection,
  type BenchmarkConfig,
  type SearchRow,
} from "./benchmark.ts";
import { latencyStats, median, runClosedLoop } from "./load-engine.ts";
import { ProcessTreeMonitor, parseProcessTable, parsePsDuration, readProcessTable } from "./process-tree.ts";
import { runConnectionLevel } from "./workload.ts";

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
  test("keeps a zero-slot measurement window open for its configured duration", async () => {
    const durationMs = 20;
    const startedAt = performance.now();
    const result = await runClosedLoop({
      phaseId: "zero-slot-window",
      durationMs,
      slots: 0,
      drainTimeoutMs: 100,
      cancel: () => {
        throw new Error("zero-slot work must not cancel");
      },
      operation: async () => {
        throw new Error("zero-slot work must not execute");
      },
    });

    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(durationMs - 1);
    expect(result.windowEndedAtMs - result.windowStartedAtMs).toBe(durationMs);
    expect(result.attempted).toBe(0);
  });

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

  test("records timed-out operations with exact accounting and releases owned workers", async () => {
    let active = 0;
    let finished = 0;
    let attempts = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const signals = new Set<AbortSignal>();
    const result = await runClosedLoop({
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

    const reason =
      "phase subscriptions:partitioned:capacity-500 exceeded 10ms window + 10ms drain: " +
        "3 attempted, 0 settled, 3 in flight";
    expect(result).toMatchObject({
      attempted: 3,
      completedInWindow: 0,
      completedAfterWindow: 0,
      failed: 3,
      errors: [reason],
      interruption: { reason, resourcesReleased: true },
    });
    expect({ active, attempts, finished }).toEqual({ active: 0, attempts: 3, finished: 3 });
    expect(signals.size).toBe(1);
    const [signal] = signals;
    expect(signal!.aborted).toBe(true);
    expect(signal!.reason).toBeInstanceOf(Error);
    expect((signal!.reason as Error).message).toBe(reason);
  });

  test("aborts benchmark-owned delivery waits without detaching the operation", async () => {
    let active = 0;
    let signal: AbortSignal | undefined;
    const result = await runClosedLoop({
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

    expect(result).toMatchObject({
      attempted: 1,
      failed: 1,
      interruption: { resourcesReleased: true },
    });
    expect(active).toBe(0);
    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toBeInstanceOf(Error);
  });

  test("returns a terminal failure when cancellation cannot reclaim an operation", async () => {
    const result = await runClosedLoop({
      phaseId: "unreclaimed",
      durationMs: 1,
      slots: 1,
      drainTimeoutMs: 1,
      cancel: () => new Promise<void>(() => {}),
      operation: () => new Promise<void>(() => {}),
    });

    expect(result.attempted).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.attempted).toBe(
      result.completedInWindow + result.completedAfterWindow + result.failed,
    );
    expect(result.interruption).toMatchObject({ resourcesReleased: false });
    expect(result.errors.at(-1)).toContain("phase cancellation did not settle");
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

describe("connection levels", () => {
  test("each level opens, measures and releases its own cohort", async () => {
    const config: BenchmarkConfig = {
      profile: "quick",
      seed: 1,
      operation: { warmupMs: 10, steadyMs: 10, trials: 1, drainTimeoutMs: 1_000, profiles: [] },
      connections: { levels: [1, 3], batchSize: 2, workMs: 10, timeoutMs: 1_000 },
      subscriptions: {
        users: 1,
        queriesPerUser: 1,
        durationMs: 10,
        sharedUpdatesPerSec: 1,
        partitionedUpdatesPerSec: 1,
        capacityDurationMs: 10,
        capacitySlots: [1],
        setupTimeoutMs: 1_000,
        drainTimeoutMs: 1_000,
        patterns: ["shared"],
      },
      resources: { idleMs: 25 },
      seedBatchSize: 256,
    };
    const searchRows = (partition: number): SearchRow[] =>
      Array.from({ length: 20 }, (_, rank) => ({
        rank,
        score: documentScore(partition, rank),
        payload: documentPayload(partition, rank),
      }));
    const events: string[] = [];
    let connects = 0;
    const unsupported = () => Promise.reject(new Error("not used by the connection ladder"));
    const adapter: BenchAdapter = {
      system: "ackerdb",
      connect: async (): Promise<BenchConnection> => {
        const id = connects++;
        events.push(`connect:${id}`);
        return {
          search: async (partition, nonce) => {
            const rows = searchRows(partition);
            return { nonce, checksum: searchChecksum(nonce, rows), rows };
          },
          transfer: unsupported,
          accountState: unsupported,
          compute: unsupported,
          updateChannel: unsupported,
          subscribeChannels: unsupported,
          seedDocuments: unsupported,
          seedAccounts: unsupported,
          seedChannels: unsupported,
          close: async () => {
            events.push(`close:${id}`);
          },
        };
      },
    };
    let nonce = 0;

    const single = await runConnectionLevel(adapter, config, 1, () => nonce++, { measureIdle: false });
    const batched = await runConnectionLevel(adapter, config, 3, () => nonce++, { measureIdle: true });

    expect(single.failures).toEqual([]);
    expect(batched.failures).toEqual([]);
    if (single.measurement === undefined || batched.measurement === undefined) {
      throw new Error("connection level fixture unexpectedly failed");
    }
    // A level is independent: it opens exactly its own target, not the difference
    // from whatever the previous level happened to leave behind.
    expect(single.measurement.connected).toBe(1);
    expect(single.measurement.readyLatency.count).toBe(1);
    expect(batched.measurement.connected).toBe(3);
    expect(batched.measurement.readyLatency.count).toBe(3);
    expect(connects).toBe(4);

    // Readiness is aggregate ramp time now that no idle gap is baked into it.
    expect(single.measurement.setupMs).toBeGreaterThan(0);
    expect(single.measurement.readyConnectionsPerSec)
      .toBeCloseTo(1 / (single.measurement.setupMs / 1_000), 6);

    // Only the repetition that asked for it pays for an idle plateau.
    expect(single.measurement.connectedIdlePhaseId).toBeUndefined();
    expect(batched.measurement.connectedIdlePhaseId).toBe("connections:3:idle");

    // Every connection a level opened is closed before the next level starts.
    expect(events.filter((event) => event.startsWith("close:"))).toHaveLength(connects);
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
