import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  channelChecksum,
  channelPayload,
  documentPayload,
  documentScore,
  searchChecksum,
  type BenchAdapter,
  type BenchConnection,
  type BenchmarkConfig,
  type DriverResult,
  type SearchRow,
} from "./benchmark.ts";
import { validateBenchmarkResults } from "./result-validation.ts";
import { persistBenchmarkOutcome } from "./result-persistence.ts";
import { runConnectionScale, runSubscriptionCase } from "./workload.ts";

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

function subscriptionWorkload(config: BenchmarkConfig, subscription: Awaited<ReturnType<typeof runSubscriptionCase>>): DriverResult {
  return {
    system: "dbzz",
    config,
    snapshots: {
      seededIdle: "seeded",
      seededIdlePhaseId: "seeded-idle",
      connectionBaselineIdlePhaseId: "connection-baseline-idle",
    },
    operations: [],
    connections: [],
    subscriptions: [subscription],
  };
}

function subscriptionAdapter(mode: "corrupt-fixed" | "drop-capacity" | "slow-drop-capacity"): BenchAdapter {
  const listeners = new Set<{ channels: Set<number>; onUpdate: Parameters<BenchConnection["subscribeChannels"]>[1] }>();
  const versions = new Map<number, number>();
  let updates = 0;
  return {
    system: "dbzz",
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
      system: "dbzz",
      connect: async () => {
        if (attempts++ === 0) throw new Error("connection refused");
        return connection();
      },
    };
    let nonce = 0;

    const connections = await runConnectionScale(adapter, benchmarkConfig, () => nonce++);
    const workload: DriverResult = {
      system: "dbzz",
      config: benchmarkConfig,
      snapshots: {
        seededIdle: "seeded",
        seededIdlePhaseId: "seeded-idle",
        connectionBaselineIdlePhaseId: "connection-baseline-idle",
      },
      operations: [],
      connections,
      subscriptions: [],
    };
    const validation = validateBenchmarkResults([{ label: "dbzz", system: "dbzz", workload }]);

    expect(connections.map((result) => result.targetConnections)).toEqual([1, 3]);
    expect(connections[0]).toMatchObject({ connected: 0, errors: ["connection refused"] });
    expect(connections[1]).toMatchObject({ connected: 3, errors: [] });
    expect(connections[1]!.work.windowStartedAtMs).toBeGreaterThanOrEqual(
      connections[0]!.work.windowEndedAtMs,
    );
    expect(validation.status).toBe("failed");
    expect(validation.failures[0]).toMatchObject({
      kind: "connection",
      case: "connections/1",
      errors: ["connected 0/1", "connection refused"],
    });
  });

  test("records connection-attempt timeout and closes a connection that resolves late", async () => {
    const benchmarkConfig = config();
    benchmarkConfig.connections.levels = [1];
    benchmarkConfig.connections.timeoutMs = 1;
    let closed = 0;
    const adapter: BenchAdapter = {
      system: "dbzz",
      connect: async () => {
        await Bun.sleep(10);
        return connection({ close: async () => { closed++; } });
      },
    };

    const results = await runConnectionScale(adapter, benchmarkConfig, () => 1);
    await Bun.sleep(15);

    expect(results[0]).toMatchObject({ connected: 0 });
    expect(results[0]!.errors[0]).toContain("opening 1 connections timed out after 1ms");
    expect(closed).toBe(1);
  });

  test("persists corrupt fixed-rate delivery before returning a failing outcome", async () => {
    const benchmarkConfig = config();
    benchmarkConfig.subscriptions.patterns = ["shared"];
    let nonce = 1;

    const subscription = await runSubscriptionCase(
      subscriptionAdapter("corrupt-fixed"),
      "shared",
      benchmarkConfig,
      () => nonce++,
    );
    const validation = validateBenchmarkResults([{
      label: "dbzz",
      system: "dbzz",
      workload: subscriptionWorkload(benchmarkConfig, subscription),
    }]);

    expect(subscription).toMatchObject({ corruptDeliveries: 1, missingDeliveries: 1 });
    expect(validation.status).toBe("failed");
    expect(validation.failures[0]).toMatchObject({ kind: "subscription", case: "subscriptions/shared" });

    const directory = mkdtempSync(join(tmpdir(), "dbzz-workload-failure-"));
    const path = join(directory, "result.json");
    try {
      const outcome = await persistBenchmarkOutcome(path, {
        schemaVersion: 6,
        validation,
        performanceAcceptance: { status: "not-evaluated", reason: "correctness-failed" },
      });
      const saved = JSON.parse(readFileSync(path, "utf8")) as {
        schemaVersion: number;
        validation: { status: string; failures: Array<{ kind: string }> };
      };

      expect(outcome.status).toBe("failed");
      expect(saved).toMatchObject({
        schemaVersion: 6,
        validation: { status: "failed", failures: [{ kind: "subscription" }] },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("returns slow-ack capacity delivery timeout before the outer phase deadline", async () => {
    const benchmarkConfig = config();
    benchmarkConfig.subscriptions.patterns = ["shared"];
    benchmarkConfig.subscriptions.capacityDurationMs = 10;
    benchmarkConfig.subscriptions.drainTimeoutMs = 30;
    let nonce = 1;

    const subscription = await runSubscriptionCase(
      subscriptionAdapter("slow-drop-capacity"),
      "shared",
      benchmarkConfig,
      () => nonce++,
    );
    const validation = validateBenchmarkResults([{
      label: "dbzz",
      system: "dbzz",
      workload: subscriptionWorkload(benchmarkConfig, subscription),
    }]);

    expect(subscription.capacity[0]!.attempted).toBe(
      subscription.capacity[0]!.completedInWindow +
        subscription.capacity[0]!.completedAfterWindow +
        subscription.capacity[0]!.failed,
    );
    expect(subscription.capacity[0]!.failed).toBeGreaterThan(0);
    expect(validation.status).toBe("failed");
    expect(validation.failures[0]).toMatchObject({
      kind: "subscription-capacity",
      case: "subscriptions/shared/capacity-1",
    });
  });
});
