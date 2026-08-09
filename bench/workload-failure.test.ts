import { describe, expect, test } from "bun:test";
import {
  channelChecksum,
  channelPayload,
  documentPayload,
  documentScore,
  searchChecksum,
  type BenchAdapter,
  type BenchConnection,
  type BenchmarkConfig,
  type ConnectionLevelResult,
  type DriverResult,
  type SearchRow,
} from "./benchmark.ts";
import { collectBenchmarkObservations } from "./result-observations.ts";
import { runConnectionLevel, runSubscriptionCase } from "./workload.ts";

/** The ladder the driver walks, one independent level at a time. */
async function runConnectionLadder(
  adapter: BenchAdapter,
  config: BenchmarkConfig,
  nextNonce: () => number,
): Promise<{ measurements: ConnectionLevelResult[]; failures: DriverResult["failures"] }> {
  const measurements: ConnectionLevelResult[] = [];
  const failures: DriverResult["failures"] = [];
  for (const target of config.connections.levels) {
    const outcome = await runConnectionLevel(adapter, config, target, nextNonce, { measureIdle: false });
    if (outcome.measurement !== undefined) measurements.push(outcome.measurement);
    failures.push(...outcome.failures);
  }
  return { measurements, failures };
}

function config(): BenchmarkConfig {
  return {
    profile: "quick",
    seed: 1,
    operation: { warmupMs: 1, steadyMs: 1, trials: 1, drainTimeoutMs: 20, profiles: [] },
    connections: { levels: [], batchSize: 10, workMs: 2, timeoutMs: 20 },
    subscriptions: {
      users: 1,
      queriesPerUser: 1,
      durationMs: 1,
      sharedUpdatesPerSec: 1,
      partitionedUpdatesPerSec: 1,
      capacityDurationMs: 2,
      capacitySlots: [1],
      setupTimeoutMs: 20,
      drainTimeoutMs: 10,
      patterns: [],
    },
    resources: { idleMs: 1 },
    seedBatchSize: 1,
  };
}

function rows(partition: number): SearchRow[] {
  return Array.from({ length: 20 }, (_, rank) => ({
    rank,
    score: documentScore(partition, rank),
    payload: documentPayload(partition, rank),
  }));
}

function connection(overrides: Partial<BenchConnection> = {}): BenchConnection {
  const unsupported = async (): Promise<never> => {
    throw new Error("not used by this workload test");
  };
  return {
    search: async (partition, nonce) => {
      const resultRows = rows(partition);
      return { nonce, checksum: searchChecksum(nonce, resultRows), rows: resultRows };
    },
    transfer: unsupported,
    accountState: unsupported,
    compute: unsupported,
    updateChannel: unsupported,
    subscribeChannels: unsupported,
    seedDocuments: unsupported,
    seedAccounts: unsupported,
    seedChannels: unsupported,
    close: async () => {},
    ...overrides,
  };
}

function subscriptionWorkload(
  config: BenchmarkConfig,
  subscription: NonNullable<Awaited<ReturnType<typeof runSubscriptionCase>>["measurement"]>,
  failures: DriverResult["failures"] = [],
): DriverResult {
  return {
    system: "ackerdb",
    config,
    operations: [],
    connections: [],
    subscriptions: [subscription],
    failures,
  };
}

function subscriptionAdapter(mode: "normal" | "corrupt-fixed" | "drop-capacity" | "slow-drop-capacity"): BenchAdapter {
  const listeners = new Set<{ channels: Set<number>; onUpdate: Parameters<BenchConnection["subscribeChannels"]>[1] }>();
  const versions = new Map<number, number>();
  let updates = 0;
  return {
    system: "ackerdb",
    connect: async () => connection({
      subscribeChannels: async (channels, onUpdate) => {
        const listener = { channels: new Set(channels), onUpdate };
        listeners.add(listener);
        return async () => {
          listeners.delete(listener);
        };
      },
      updateChannel: async (channel, nonce) => {
        updates++;
        const version = (versions.get(channel) ?? 0) + 1;
        versions.set(channel, version);
        if ((mode === "drop-capacity" || mode === "slow-drop-capacity") && updates > 1) {
          if (mode === "slow-drop-capacity") await Bun.sleep(25);
          return;
        }
        const payload = channelPayload(channel, version, nonce);
        const row = {
          channel,
          version,
          payload,
          checksum: mode === "corrupt-fixed" && updates === 1
            ? channelChecksum(channel, version, nonce, payload) + 1
            : channelChecksum(channel, version, nonce, payload),
        };
        for (const listener of listeners) {
          if (listener.channels.has(channel)) listener.onUpdate(row);
        }
      },
    }),
  };
}

describe("measured workload failures", () => {
  test("keeps later connection levels after an early target misses", async () => {
    const benchmarkConfig = config();
    benchmarkConfig.connections.levels = [1, 3];
    benchmarkConfig.connections.workMs = 15;
    let attempts = 0;
    const adapter: BenchAdapter = {
      system: "ackerdb",
      connect: async () => {
        if (attempts++ === 0) throw new Error("connection refused");
        return connection();
      },
    };
    let nonce = 0;

    const outcome = await runConnectionLadder(adapter, benchmarkConfig, () => nonce++);
    const connections = outcome.measurements;
    const workload: DriverResult = {
      system: "ackerdb",
      config: benchmarkConfig,
      operations: [],
      connections,
      subscriptions: [],
      failures: outcome.failures,
    };
    const observations = collectBenchmarkObservations([{ label: "ackerdb", system: "ackerdb", workload }]);

    expect(connections.map((result) => result.targetConnections)).toEqual([3]);
    expect(connections[0]).toMatchObject({ connected: 3, errors: [] });
    expect(outcome.failures[0]).toMatchObject({
      kind: "connection",
      targetConnections: 1,
      stage: "setup",
      terminal: false,
      message: "connected 0/1; connection refused",
    });
    expect(observations.failures[0]).toMatchObject({
      kind: "connection",
      case: "connections/1",
      errors: ["connected 0/1; connection refused"],
    });
  });

  test("records connection-attempt timeout and closes a connection that resolves late", async () => {
    const benchmarkConfig = config();
    benchmarkConfig.connections.levels = [1];
    benchmarkConfig.connections.timeoutMs = 1;
    let closed = 0;
    const adapter: BenchAdapter = {
      system: "ackerdb",
      connect: async () => {
        await Bun.sleep(10);
        return connection({ close: async () => { closed++; } });
      },
    };

    const outcome = await runConnectionLadder(adapter, benchmarkConfig, () => 1);
    await Bun.sleep(15);

    expect(outcome.measurements).toEqual([]);
    expect(outcome.failures[0]).toMatchObject({
      kind: "connection",
      targetConnections: 1,
      stage: "setup",
      terminal: true,
    });
    expect(outcome.failures[0]!.message).toContain("opening 1 connections timed out after 1ms");
    expect(closed).toBe(1);
  });

  test("turns a hung connection release into a terminal ledger failure", async () => {
    const benchmarkConfig = config();
    benchmarkConfig.connections.levels = [1];
    benchmarkConfig.operation.drainTimeoutMs = 2;
    const adapter: BenchAdapter = {
      system: "ackerdb",
      connect: async () => connection({ close: () => new Promise<void>(() => {}) }),
    };

    const outcome = await runConnectionLadder(adapter, benchmarkConfig, () => 1);

    expect(outcome.measurements).toEqual([]);
    expect(outcome.failures[0]).toMatchObject({
      kind: "connection",
      targetConnections: 1,
      stage: "cleanup",
      terminal: true,
    });
    expect(outcome.failures[0]!.message).toContain("connections:1 release timed out");
  });

  test("cleans a failed readiness batch and continues with the next subscription pattern", async () => {
    const benchmarkConfig = config();
    benchmarkConfig.subscriptions.patterns = ["shared", "partitioned"];
    const listeners = new Set<{
      channels: Set<number>;
      onUpdate: Parameters<BenchConnection["subscribeChannels"]>[1];
    }>();
    const versions = new Map<number, number>();
    let readinessAttempts = 0;
    let closed = 0;
    let unsubscribed = 0;
    const adapter: BenchAdapter = {
      system: "ackerdb",
      connect: async () => connection({
        subscribeChannels: async (channels, onUpdate) => {
          if (readinessAttempts++ === 0) throw new Error("readiness rejected");
          const listener = { channels: new Set(channels), onUpdate };
          listeners.add(listener);
          return async () => {
            unsubscribed++;
            listeners.delete(listener);
          };
        },
        updateChannel: async (channel, nonce) => {
          const version = (versions.get(channel) ?? 0) + 1;
          versions.set(channel, version);
          const payload = channelPayload(channel, version, nonce);
          const row = { channel, version, payload, checksum: channelChecksum(channel, version, nonce, payload) };
          for (const listener of listeners) {
            if (listener.channels.has(channel)) listener.onUpdate(row);
          }
        },
        close: async () => { closed++; },
      }),
    };
    let nonce = 1;
    const failed = await runSubscriptionCase(adapter, "shared", benchmarkConfig, () => nonce++, { measureIdle: false });
    const measured = await runSubscriptionCase(adapter, "partitioned", benchmarkConfig, () => nonce++, { measureIdle: false });

    expect(failed).toMatchObject({
      failures: [{
        kind: "subscription",
        pattern: "shared",
        stage: "setup",
        message: expect.stringContaining("readiness rejected"),
        terminal: false,
      }],
    });
    expect(measured.measurement).toMatchObject({ pattern: "partitioned" });
    expect(measured.failures).toEqual([]);
    expect(closed).toBeGreaterThanOrEqual(3);
    expect(unsubscribed).toBeGreaterThanOrEqual(1);
  });

  test("records corrupt fixed-rate delivery before returning a failing outcome", async () => {
    const benchmarkConfig = config();
    benchmarkConfig.subscriptions.patterns = ["shared"];
    let nonce = 1;

    const outcome = await runSubscriptionCase(
      subscriptionAdapter("corrupt-fixed"),
      "shared",
      benchmarkConfig,
      () => nonce++,
      { measureIdle: false },
    );
    const subscription = outcome.measurement!;
    const observations = collectBenchmarkObservations([{
      label: "ackerdb",
      system: "ackerdb",
      workload: subscriptionWorkload(benchmarkConfig, subscription, outcome.failures),
    }]);

    expect(subscription).toMatchObject({ corruptDeliveries: 1, missingDeliveries: 1 });
    expect(observations.failures[0]).toMatchObject({
      kind: "subscription",
      case: "subscriptions/shared",
    });
  });

  test("records a capacity-writer setup failure and measures the next slot level", async () => {
    const benchmarkConfig = config();
    benchmarkConfig.subscriptions.users = 3;
    benchmarkConfig.subscriptions.patterns = ["partitioned"];
    benchmarkConfig.subscriptions.capacitySlots = [1, 2, 3];
    const base = subscriptionAdapter("normal");
    let connects = 0;
    const adapter: BenchAdapter = {
      system: "ackerdb",
      connect: async (nonce, seeded) => {
        connects++;
        if (connects === 5) throw new Error("capacity writer refused");
        return base.connect(nonce, seeded);
      },
    };
    let nonce = 1;

    const outcome = await runSubscriptionCase(
      adapter,
      "partitioned",
      benchmarkConfig,
      () => nonce++,
      { measureIdle: false },
    );
    const subscription = outcome.measurement!;
    const observations = collectBenchmarkObservations([{
      label: "ackerdb",
      system: "ackerdb",
      workload: subscriptionWorkload(benchmarkConfig, subscription, outcome.failures),
    }]);

    expect(subscription.capacity.map((capacity) => capacity.slots)).toEqual([1, 3]);
    expect(outcome.failures).toEqual([
      expect.objectContaining({
        kind: "subscription-capacity",
        pattern: "partitioned",
        slots: 2,
        stage: "setup",
        message: expect.stringContaining("capacity writer refused"),
        terminal: false,
      }),
    ]);
    expect(observations.failures[0]).toMatchObject({
      kind: "subscription-capacity",
      case: "subscriptions/partitioned/capacity-2",
    });
  });

  test("returns slow-ack capacity delivery timeout before the outer phase deadline", async () => {
    const benchmarkConfig = config();
    benchmarkConfig.subscriptions.patterns = ["shared"];
    benchmarkConfig.subscriptions.capacityDurationMs = 10;
    benchmarkConfig.subscriptions.drainTimeoutMs = 30;
    let nonce = 1;

    const outcome = await runSubscriptionCase(
      subscriptionAdapter("slow-drop-capacity"),
      "shared",
      benchmarkConfig,
      () => nonce++,
      { measureIdle: false },
    );
    const subscription = outcome.measurement!;
    const observations = collectBenchmarkObservations([{
      label: "ackerdb",
      system: "ackerdb",
      workload: subscriptionWorkload(benchmarkConfig, subscription, outcome.failures),
    }]);

    const capacity = subscription.capacity[0]!;

    expect(capacity.attempted).toBe(
      capacity.completedInWindow + capacity.completedAfterWindow + capacity.failed,
    );
    expect(capacity.failed).toBeGreaterThan(0);
    expect(observations.failures[0]).toMatchObject({
      kind: "subscription-capacity",
      case: "subscriptions/shared/capacity-1",
    });
  });
});
