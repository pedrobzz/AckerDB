import {
  ACCOUNT_BALANCE,
  ACCOUNT_COUNT,
  ACCOUNT_PAIRS,
  DOCUMENT_COUNT,
  DOCUMENT_PARTITIONS,
  DOCUMENTS_PER_PARTITION,
  FNV_OFFSET,
  PROCEDURE_PAYLOAD_BYTES,
  benchmarkConfigFromEnv,
  channelChecksum,
  channelPayload,
  computeChecksum,
  documentPayload,
  documentScore,
  emitBenchEvent,
  fixedPayload,
  mix,
  offeredFixedRateUpdates,
  searchChecksum,
  subscriptionCapacitySlots,
  type AccountState,
  type BenchAdapter,
  type BenchConnection,
  type BenchmarkConfig,
  type ChannelRow,
  type ConnectionLevelResult,
  type DriverResult,
  type OperationCaseResult,
  type OperationName,
  type OperationProfile,
  type SearchResult,
  type SubscriptionPattern,
  type SubscriptionResult,
  type TrialResult,
} from "./benchmark.ts";
import { latencyStats, median, runClosedLoop, withTimeout } from "./load-engine.ts";

const COMPUTE_ROUNDS = 8;
const TRANSFER_AMOUNT = 1;
export const READINESS_SAMPLES = 20;

interface AccountModel {
  balances: number[];
  versions: number[];
}

function phaseStartAt(id: string, timestampMs: number): void {
  emitBenchEvent({ type: "phase-start", id, timestampMs });
}

function phaseStart(id: string): number {
  const timestampMs = performance.now();
  phaseStartAt(id, performance.timeOrigin + timestampMs);
  return timestampMs;
}

function phaseEndAt(id: string, timestampMs: number): void {
  emitBenchEvent({ type: "phase-end", id, timestampMs });
}

function phaseEnd(id: string): number {
  const timestampMs = performance.now();
  phaseEndAt(id, performance.timeOrigin + timestampMs);
  return timestampMs;
}

function snapshot(id: string): void {
  emitBenchEvent({ type: "snapshot", id, timestampMs: performance.timeOrigin + performance.now() });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function closeAll(connections: BenchConnection[]): Promise<void> {
  await Promise.allSettled(connections.map((connection) => connection.close()));
}

async function seed(connection: BenchConnection, config: BenchmarkConfig): Promise<void> {
  const channelCount = (config.subscriptions.users + 1) * config.subscriptions.queriesPerUser;
  for (let start = 0; start < DOCUMENT_COUNT; start += config.seedBatchSize) {
    await connection.seedDocuments(start, Math.min(config.seedBatchSize, DOCUMENT_COUNT - start));
  }
  for (let start = 0; start < ACCOUNT_COUNT; start += config.seedBatchSize) {
    await connection.seedAccounts(start, Math.min(config.seedBatchSize, ACCOUNT_COUNT - start));
  }
  for (let start = 0; start < channelCount; start += config.seedBatchSize) {
    await connection.seedChannels(start, Math.min(config.seedBatchSize, channelCount - start));
  }
}

function validateSearch(result: SearchResult, partition: number, nonce: number): void {
  if (result.nonce !== nonce) throw new Error(`query nonce ${result.nonce} != ${nonce}`);
  if (result.rows.length !== 20) throw new Error(`query returned ${result.rows.length} rows, expected 20`);
  for (let index = 0; index < result.rows.length; index++) {
    const row = result.rows[index]!;
    const rank = index;
    if (row.rank !== rank) throw new Error(`query rank ${row.rank} != ${rank}`);
    if (row.score !== documentScore(partition, rank)) throw new Error(`query score mismatch at rank ${rank}`);
    if (row.payload !== documentPayload(partition, rank)) throw new Error(`query payload mismatch at rank ${rank}`);
  }
  const checksum = searchChecksum(nonce, result.rows);
  if (result.checksum !== checksum) throw new Error(`query checksum ${result.checksum} != ${checksum}`);
}

function expectedAccountState(model: AccountModel, nonce: number): AccountState {
  let totalBalance = 0;
  let totalVersion = 0;
  let checksum = mix(FNV_OFFSET, nonce);
  for (let account = 0; account < ACCOUNT_COUNT; account++) {
    const balance = model.balances[account]!;
    const version = model.versions[account]!;
    totalBalance += balance;
    totalVersion += version;
    checksum = mix(checksum, account);
    checksum = mix(checksum, balance);
    checksum = mix(checksum, version);
  }
  return { nonce, count: ACCOUNT_COUNT, totalBalance, totalVersion, checksum };
}

function validateAccountState(actual: AccountState, expected: AccountState, label: string): string[] {
  const errors: string[] = [];
  for (const key of ["nonce", "count", "totalBalance", "totalVersion", "checksum"] as const) {
    if (actual[key] !== expected[key]) errors.push(`${label} ${key} ${actual[key]}, expected ${expected[key]}`);
  }
  return errors;
}

function applyTransfer(model: AccountModel, pair: number, direction: number, amount: number): void {
  const left = pair * 2;
  const right = left + 1;
  const from = direction === 0 ? left : right;
  const to = direction === 0 ? right : left;
  model.balances[from]! -= amount;
  model.balances[to]! += amount;
  model.versions[from]!++;
  model.versions[to]!++;
}

async function openConnections(
  adapter: BenchAdapter,
  count: number,
  nonce: () => number,
  timeoutMs: number,
): Promise<{ connections: BenchConnection[]; latencies: number[]; errors: string[] }> {
  const connections: BenchConnection[] = [];
  const latencies: number[] = [];
  const errors: string[] = [];
  await withTimeout(
    Promise.all(
      Array.from({ length: count }, async () => {
        const startedAt = performance.now();
        try {
          const connection = await adapter.connect(nonce(), true);
          latencies.push(performance.now() - startedAt);
          connections.push(connection);
        } catch (error) {
          if (errors.length < 8) errors.push(errorMessage(error));
        }
      }),
    ),
    timeoutMs,
    `opening ${count} connections`,
  );
  return { connections, latencies, errors };
}

async function runOperationTrial(
  operation: OperationName,
  profile: OperationProfile,
  trial: number,
  connections: BenchConnection[],
  config: BenchmarkConfig,
  nextNonce: () => number,
  accountModel: AccountModel,
): Promise<TrialResult> {
  const phaseId = `operation:${operation}:${profile.name}:trial-${trial}`;
  const slots = profile.connections * profile.inFlightPerConnection;
  const correctnessErrors: string[] = [];
  if (operation.startsWith("mutation")) {
    const nonce = nextNonce();
    const stateBefore = await connections[0]!.accountState(nonce);
    correctnessErrors.push(...validateAccountState(stateBefore, expectedAccountState(accountModel, nonce), "before"));
  }
  const computePayload = fixedPayload("procedure-payload:", PROCEDURE_PAYLOAD_BYTES);

  const result = await runClosedLoop({
    phaseId,
    durationMs: config.operation.steadyMs,
    slots,
    drainTimeoutMs: config.operation.drainTimeoutMs,
    onWindowStart: (timestampMs) => phaseStartAt(phaseId, timestampMs),
    cancel: () => closeAll(connections),
    operation: async (slot) => {
      const connection = connections[Math.floor(slot / profile.inFlightPerConnection)]!;
      const nonce = nextNonce();
      switch (operation) {
        case "query": {
          const partition = nonce % DOCUMENT_PARTITIONS;
          const value = await connection.search(partition, nonce);
          return { kind: operation, nonce, partition, value } as const;
        }
        case "mutation-uncontended": {
          const pair = slot % Math.min(ACCOUNT_PAIRS, slots);
          await connection.transfer(pair, nonce & 1, TRANSFER_AMOUNT, nonce);
          applyTransfer(accountModel, pair, nonce & 1, TRANSFER_AMOUNT);
          return { kind: operation, nonce } as const;
        }
        case "mutation-contended": {
          await connection.transfer(0, nonce & 1, TRANSFER_AMOUNT, nonce);
          applyTransfer(accountModel, 0, nonce & 1, TRANSFER_AMOUNT);
          return { kind: operation, nonce } as const;
        }
        case "procedure": {
          const seed = Math.imul(nonce, 2_654_435_761) >>> 0;
          const value = await connection.compute(nonce, seed, computePayload, COMPUTE_ROUNDS);
          return { kind: operation, nonce, seed, value } as const;
        }
      }
    },
    validate: (result) => {
      if (result.kind === "query") validateSearch(result.value, result.partition, result.nonce);
      if (result.kind === "procedure") {
        if (result.value.nonce !== result.nonce) throw new Error(`procedure nonce mismatch`);
        const expected = computeChecksum(result.nonce, result.seed, computePayload, COMPUTE_ROUNDS);
        if (result.value.checksum !== expected) throw new Error(`procedure checksum mismatch`);
      }
    },
  });
  phaseEndAt(phaseId, result.windowEndedAtMs);

  correctnessErrors.push(...result.errors);
  if (operation.startsWith("mutation")) {
    const nonce = nextNonce();
    const stateAfter = await connections[0]!.accountState(nonce);
    correctnessErrors.push(...validateAccountState(stateAfter, expectedAccountState(accountModel, nonce), "after"));
  }
  return {
    ...result,
    phaseId,
    correctness: { ok: result.failed === 0 && correctnessErrors.length === 0, errors: correctnessErrors },
  };
}

async function runOperationCase(
  adapter: BenchAdapter,
  operation: OperationName,
  profile: OperationProfile,
  config: BenchmarkConfig,
  nextNonce: () => number,
  accountModel: AccountModel,
): Promise<OperationCaseResult> {
  const opened = await openConnections(adapter, profile.connections, nextNonce, config.connections.timeoutMs);
  if (opened.connections.length !== profile.connections) {
    await closeAll(opened.connections);
    throw new Error(`opened ${opened.connections.length}/${profile.connections} clients: ${opened.errors.join("; ")}`);
  }
  try {
    const warmup = await runClosedLoop({
      phaseId: `operation:${operation}:${profile.name}:warmup`,
      durationMs: config.operation.warmupMs,
      slots: profile.connections * profile.inFlightPerConnection,
      drainTimeoutMs: config.operation.drainTimeoutMs,
      cancel: () => closeAll(opened.connections),
      operation: async (slot) => {
        const connection = opened.connections[Math.floor(slot / profile.inFlightPerConnection)]!;
        const nonce = nextNonce();
        if (operation === "query") return connection.search(nonce % DOCUMENT_PARTITIONS, nonce);
        if (operation === "procedure") {
          return connection.compute(
            nonce,
            Math.imul(nonce, 2_654_435_761) >>> 0,
            fixedPayload("procedure-payload:", PROCEDURE_PAYLOAD_BYTES),
            COMPUTE_ROUNDS,
          );
        }
        const pair = operation === "mutation-contended" ? 0 : slot % Math.min(ACCOUNT_PAIRS, profile.connections * profile.inFlightPerConnection);
        await connection.transfer(pair, nonce & 1, TRANSFER_AMOUNT, nonce);
        applyTransfer(accountModel, pair, nonce & 1, TRANSFER_AMOUNT);
      },
    });
    if (warmup.failed > 0) throw new Error(`warmup failed: ${warmup.errors.join("; ")}`);

    const trials: TrialResult[] = [];
    for (let trial = 0; trial < config.operation.trials; trial++) {
      trials.push(await runOperationTrial(operation, profile, trial, opened.connections, config, nextNonce, accountModel));
    }
    return {
      operation,
      profile,
      trials,
      medianThroughputPerSec: median(trials.map((trial) => trial.throughputPerSec)),
      medianLatencyP50Ms: median(trials.map((trial) => trial.latency.p50Ms)),
      medianLatencyP95Ms: median(trials.map((trial) => trial.latency.p95Ms)),
      medianLatencyP99Ms: median(trials.map((trial) => trial.latency.p99Ms)),
    };
  } finally {
    await closeAll(opened.connections);
  }
}

export async function runConnectionScale(
  adapter: BenchAdapter,
  config: BenchmarkConfig,
  nextNonce: () => number,
): Promise<ConnectionLevelResult[]> {
  const cohort: BenchConnection[] = [];
  const results: ConnectionLevelResult[] = [];
  try {
    for (const target of config.connections.levels) {
      const needed = target - cohort.length;
      const cohortBefore = cohort.length;
      const setupStartedAt = performance.now();
      const connectLatencies: number[] = [];
      const errors: string[] = [];
      const rampPhaseId = `connections:${target}:ramp`;
      phaseStart(rampPhaseId);
      if (needed === 1) {
        // A level that adds one connection would otherwise report a single connect draw as its
        // whole readiness distribution, and one post-idle draw has a heavy scheduling tail on
        // macOS. Sample connect → ready → close sequentially instead, with an idle gap before
        // every draw (at the standard 1-client first level, the caller's baseline idle covers
        // the first sample), so each draw still measures post-idle readiness with no benchmark
        // traffic in flight during the gap. The last sample's connection is kept as the cohort
        // member, leaving the earlier gaps free of extra live connections. This is shared
        // workload code: the protocol is identical for every benchmarked system.
        for (let sample = 0; sample < READINESS_SAMPLES; sample++) {
          if (sample > 0) await Bun.sleep(config.resources.idleMs);
          const opened = await openConnections(adapter, 1, nextNonce, config.connections.timeoutMs);
          connectLatencies.push(...opened.latencies);
          errors.push(...opened.errors);
          if (opened.connections.length !== 1) break;
          if (sample === READINESS_SAMPLES - 1) cohort.push(...opened.connections);
          else await closeAll(opened.connections);
        }
      } else {
        for (let remaining = needed; remaining > 0; remaining -= config.connections.batchSize) {
          const count = Math.min(config.connections.batchSize, remaining);
          const opened = await openConnections(adapter, count, nextNonce, config.connections.timeoutMs);
          cohort.push(...opened.connections);
          connectLatencies.push(...opened.latencies);
          errors.push(...opened.errors);
          if (opened.connections.length !== count) break;
        }
      }
      phaseEnd(rampPhaseId);
      // Sampled levels report aggregate measured connect time; the deliberate idle gaps and
      // closes are sampling protocol, not setup work. Batched levels keep ramp wall time,
      // which contains no deliberate gaps.
      const setupMs = needed === 1 && connectLatencies.length > 0
        ? connectLatencies.reduce((total, latency) => total + latency, 0)
        : performance.now() - setupStartedAt;
      const connectedSnapshotId = `connections:${target}:connected`;
      const connectedIdlePhaseId = `connections:${target}:idle`;
      phaseStart(connectedIdlePhaseId);
      await Bun.sleep(config.resources.idleMs);
      snapshot(connectedSnapshotId);
      phaseEnd(connectedIdlePhaseId);

      const phaseId = `connections:${target}:work`;
      const work = await runClosedLoop({
        phaseId,
        durationMs: config.connections.workMs,
        slots: cohort.length,
        drainTimeoutMs: config.operation.drainTimeoutMs,
        onWindowStart: (timestampMs) => phaseStartAt(phaseId, timestampMs),
        cancel: () => closeAll(cohort),
        operation: async (slot) => {
          const nonce = nextNonce();
          const partition = nonce % DOCUMENT_PARTITIONS;
          const value = await cohort[slot]!.search(partition, nonce);
          return { nonce, partition, value };
        },
        validate: ({ nonce, partition, value }) => validateSearch(value, partition, nonce),
      });
      phaseEndAt(phaseId, work.windowEndedAtMs);
      results.push({
        targetConnections: target,
        connected: cohort.length,
        addedConnections: cohort.length - cohortBefore,
        setupMs,
        readyConnectionsPerSec: connectLatencies.length / (setupMs / 1_000),
        readyLatency: latencyStats(connectLatencies),
        connectedSnapshotId,
        connectedIdlePhaseId,
        work: { ...work, phaseId },
        errors,
      });
      if (cohort.length !== target) break;
    }
  } finally {
    await closeAll(cohort);
  }
  return results;
}

interface PendingDelivery {
  channel: number;
  version: number;
  nonce: number;
  sentAt: number;
  expectedUsers: Uint8Array;
  observedUsers: Uint8Array;
  expectedCount: number;
  observedCount: number;
  latencies: number[];
  resolve: () => void;
  done: Promise<void>;
}

function expectedChannels(pattern: SubscriptionPattern, user: number, users: number, queries: number): number[] {
  if (pattern === "shared") return Array.from({ length: queries }, (_, channel) => channel);
  return Array.from({ length: queries }, (_, query) => queries + user * queries + query).filter(
    (channel) => channel < (users + 1) * queries,
  );
}

async function runSubscriptionCase(
  adapter: BenchAdapter,
  pattern: SubscriptionPattern,
  config: BenchmarkConfig,
  nextNonce: () => number,
): Promise<SubscriptionResult> {
  const { users, queriesPerUser, setupTimeoutMs, drainTimeoutMs } = config.subscriptions;
  const subscribers: BenchConnection[] = [];
  const writers: BenchConnection[] = [];
  const unsubscribes: Array<() => Promise<void>> = [];
  const pending = new Map<string, PendingDelivery>();
  const versions = new Map<number, number>();
  let duplicates = 0;
  let unexpected = 0;
  let corrupt = 0;
  let measuring = false;
  const baselineIdlePhaseId = `subscriptions:${pattern}:baseline-idle`;
  phaseStart(baselineIdlePhaseId);
  await Bun.sleep(config.resources.idleMs);
  phaseEnd(baselineIdlePhaseId);
  const setupPhaseId = `subscriptions:${pattern}:setup`;
  const setupStartedAt = phaseStart(setupPhaseId);

  const onUpdate = (user: number, row: ChannelRow) => {
    if (!measuring) return;
    const probe = pending.get(`${row.channel}:${row.version}`);
    if (!probe || probe.expectedUsers[user] !== 1) {
      unexpected++;
      return;
    }
    const expectedPayload = channelPayload(row.channel, row.version, probe.nonce);
    const expectedChecksum = channelChecksum(row.channel, row.version, probe.nonce, expectedPayload);
    if (row.payload !== expectedPayload || row.checksum !== expectedChecksum) {
      corrupt++;
      return;
    }
    if (probe.observedUsers[user] === 1) {
      duplicates++;
      return;
    }
    probe.observedUsers[user] = 1;
    probe.observedCount++;
    const latency = performance.now() - probe.sentAt;
    probe.latencies.push(latency);
    if (probe.observedCount === probe.expectedCount) {
      probe.resolve();
    }
  };

  try {
    await withTimeout(
      (async () => {
        for (let start = 0; start < users; start += Math.min(25, config.connections.batchSize)) {
          const count = Math.min(25, users - start);
          const batch = await Promise.all(
            Array.from({ length: count }, async (_, offset) => {
              const user = start + offset;
              const connection = await adapter.connect(nextNonce(), true);
              const unsubscribe = await connection.subscribeChannels(
                expectedChannels(pattern, user, users, queriesPerUser),
                (row) => onUpdate(user, row),
              );
              return { connection, unsubscribe };
            }),
          );
          for (const item of batch) {
            subscribers.push(item.connection);
            unsubscribes.push(item.unsubscribe);
          }
        }
      })(),
      setupTimeoutMs,
      `${pattern} subscription readiness`,
    );
    writers.push(await adapter.connect(nextNonce(), true));
    const setupEndedAt = phaseEnd(setupPhaseId);
    const subscribedSnapshotId = `subscriptions:${pattern}:subscribed`;
    const subscribedIdlePhaseId = `subscriptions:${pattern}:idle`;
    phaseStart(subscribedIdlePhaseId);
    await Bun.sleep(config.resources.idleMs);
    snapshot(subscribedSnapshotId);
    phaseEnd(subscribedIdlePhaseId);

    const phaseId = `subscriptions:${pattern}:updates`;
    const phaseStartedAt = phaseStart(phaseId);
    measuring = true;
    const rate = pattern === "shared" ? config.subscriptions.sharedUpdatesPerSec : config.subscriptions.partitionedUpdatesPerSec;
    const updateCount = offeredFixedRateUpdates(config.subscriptions.durationMs, rate);
    const ackLatencies: number[] = [];
    const probes: PendingDelivery[] = [];
    for (let update = 0; update < updateCount; update++) {
      const scheduledAt = phaseStartedAt + (update * 1_000) / rate;
      const delay = scheduledAt - performance.now();
      if (delay > 0) await Bun.sleep(delay);
      const channel =
        pattern === "shared" ? update % queriesPerUser : queriesPerUser + (update % (users * queriesPerUser));
      const previousVersion = versions.get(channel) ?? 0;
      if (previousVersion > 0) {
        const previous = pending.get(`${channel}:${previousVersion}`);
        if (previous) await withTimeout(previous.done, drainTimeoutMs, `channel ${channel} delivery`);
      }
      const version = previousVersion + 1;
      versions.set(channel, version);
      const nonce = nextNonce();
      let resolve!: () => void;
      const done = new Promise<void>((doneResolve) => {
        resolve = doneResolve;
      });
      const expectedUsers = new Uint8Array(users);
      if (pattern === "shared") expectedUsers.fill(1);
      else expectedUsers[Math.floor((channel - queriesPerUser) / queriesPerUser)] = 1;
      const probe: PendingDelivery = {
        channel,
        version,
        nonce,
        sentAt: performance.now(),
        expectedUsers,
        observedUsers: new Uint8Array(users),
        expectedCount: pattern === "shared" ? users : 1,
        observedCount: 0,
        latencies: [],
        resolve,
        done,
      };
      pending.set(`${channel}:${version}`, probe);
      probes.push(probe);
      const ackStartedAt = performance.now();
      await writers[0]!.updateChannel(channel, nonce);
      ackLatencies.push(performance.now() - ackStartedAt);
    }
    const sendEndedAt = performance.now();
    const remainingWindowMs = phaseStartedAt + config.subscriptions.durationMs - performance.now();
    if (remainingWindowMs > 0) await Bun.sleep(remainingWindowMs);
    await withTimeout(Promise.all(probes.map((probe) => probe.done)), drainTimeoutMs, `${pattern} delivery drain`);
    measuring = false;
    const phaseEndedAt = phaseEnd(phaseId);
    const deliveryLatencies = probes.flatMap((probe) => probe.latencies);
    const timeToAll = probes.map((probe) => Math.max(...probe.latencies));
    const expectedDeliveries = probes.reduce((total, probe) => total + probe.expectedCount, 0);
    const observedDeliveries = probes.reduce((total, probe) => total + probe.observedCount, 0);
    const missingDeliveries = expectedDeliveries - observedDeliveries;
    const errors: string[] = [];
    if (subscribers.length !== users) errors.push(`ready users ${subscribers.length}/${users}`);
    if (missingDeliveries !== 0) errors.push(`missing ${missingDeliveries}/${expectedDeliveries} deliveries`);
    if (duplicates !== 0) errors.push(`${duplicates} duplicate deliveries`);
    if (unexpected !== 0) errors.push(`${unexpected} unexpected deliveries`);
    if (corrupt !== 0) errors.push(`${corrupt} corrupt deliveries`);

    pending.clear();
    const levels = subscriptionCapacitySlots(config.subscriptions, pattern);
    const capacity = [];
    for (const slots of levels) {
      for (let remaining = slots - writers.length; remaining > 0; remaining -= config.connections.batchSize) {
        const count = Math.min(config.connections.batchSize, remaining);
        const opened = await openConnections(adapter, count, nextNonce, config.connections.timeoutMs);
        if (opened.connections.length !== count) {
          await closeAll(opened.connections);
          throw new Error(`opened ${opened.connections.length}/${count} capacity writers: ${opened.errors.join("; ")}`);
        }
        writers.push(...opened.connections);
      }
      const capacityPhaseId = `subscriptions:${pattern}:capacity-${slots}`;
      const before = { duplicates, unexpected, corrupt };
      const capacityAckLatencies: number[] = [];
      const capacityDeliveryLatencies: number[] = [];
      measuring = true;
      const result = await runClosedLoop({
        phaseId: capacityPhaseId,
        durationMs: config.subscriptions.capacityDurationMs,
        slots,
        drainTimeoutMs,
        onWindowStart: (timestampMs) => phaseStartAt(capacityPhaseId, timestampMs),
        cancel: () => closeAll(writers),
        operation: async (slot, _sequence, cancellation) => {
          const channel = pattern === "shared" ? slot : queriesPerUser + slot * queriesPerUser;
          const version = (versions.get(channel) ?? 0) + 1;
          versions.set(channel, version);
          const nonce = nextNonce();
          let resolve!: () => void;
          const done = new Promise<void>((doneResolve) => {
            resolve = doneResolve;
          });
          const expectedUsers = new Uint8Array(users);
          if (pattern === "shared") expectedUsers.fill(1);
          else expectedUsers[slot] = 1;
          const probe: PendingDelivery = {
            channel,
            version,
            nonce,
            sentAt: performance.now(),
            expectedUsers,
            observedUsers: new Uint8Array(users),
            expectedCount: pattern === "shared" ? users : 1,
            observedCount: 0,
            latencies: [],
            resolve,
            done,
          };
          pending.set(`${channel}:${version}`, probe);
          const ackStartedAt = performance.now();
          await writers[slot]!.updateChannel(channel, nonce);
          const ackLatency = performance.now() - ackStartedAt;
          await cancellation.wait(probe.done);
          return { probe, ackLatency };
        },
        validate: ({ probe, ackLatency }) => {
          capacityAckLatencies.push(ackLatency);
          capacityDeliveryLatencies.push(...probe.latencies);
        },
      });
      measuring = false;
      phaseEndAt(capacityPhaseId, result.windowEndedAtMs);
      const capacityErrors = [...result.errors];
      const duplicateDelta = duplicates - before.duplicates;
      const unexpectedDelta = unexpected - before.unexpected;
      const corruptDelta = corrupt - before.corrupt;
      if (duplicateDelta !== 0) capacityErrors.push(`${duplicateDelta} duplicate deliveries`);
      if (unexpectedDelta !== 0) capacityErrors.push(`${unexpectedDelta} unexpected deliveries`);
      if (corruptDelta !== 0) capacityErrors.push(`${corruptDelta} corrupt deliveries`);
      capacity.push({
        ...result,
        slots,
        phaseId: capacityPhaseId,
        deliveriesPerUpdate: pattern === "shared" ? users : 1,
        deliveryThroughputPerSec: result.throughputPerSec * (pattern === "shared" ? users : 1),
        updateAckLatency: latencyStats(capacityAckLatencies),
        deliveryLatency: latencyStats(capacityDeliveryLatencies),
        correctness: { ok: result.failed === 0 && capacityErrors.length === 0, errors: capacityErrors },
      });
      pending.clear();
    }

    return {
      pattern,
      users,
      queriesPerUser,
      logicalSubscriptions: users * queriesPerUser,
      distinctQueryArguments: pattern === "shared" ? queriesPerUser : users * queriesPerUser,
      baselineIdlePhaseId,
      setupMs: setupEndedAt - setupStartedAt,
      setupConnectionsPerSec: users / ((setupEndedAt - setupStartedAt) / 1_000),
      subscribedSnapshotId,
      subscribedIdlePhaseId,
      phaseId,
      updates: probes.length,
      updateThroughputPerSec:
        probes.length / (Math.max(config.subscriptions.durationMs, sendEndedAt - phaseStartedAt) / 1_000),
      expectedDeliveries,
      observedDeliveries,
      duplicateDeliveries: duplicates,
      unexpectedDeliveries: unexpected,
      corruptDeliveries: corrupt,
      missingDeliveries,
      deliveryThroughputPerSec: observedDeliveries / ((phaseEndedAt - phaseStartedAt) / 1_000),
      updateAckLatency: latencyStats(ackLatencies),
      deliveryLatency: latencyStats(deliveryLatencies),
      timeToAll: latencyStats(timeToAll),
      capacity,
      correctness: { ok: errors.length === 0, errors },
    };
  } finally {
    measuring = false;
    await Promise.allSettled(unsubscribes.map((unsubscribe) => unsubscribe()));
    await closeAll(subscribers);
    await closeAll(writers);
  }
}

export async function runWorkload(adapter: BenchAdapter): Promise<DriverResult> {
  const config = benchmarkConfigFromEnv();
  let nonce = config.seed;
  const nextNonce = () => nonce++ >>> 0;

  const seeder = await adapter.connect(nextNonce(), false);
  try {
    await seed(seeder, config);
  } finally {
    await seeder.close();
  }
  const seededIdle = "server:seeded-idle";
  const seededIdlePhaseId = "server:seeded-idle-window";
  phaseStart(seededIdlePhaseId);
  await Bun.sleep(config.resources.idleMs);
  snapshot(seededIdle);
  phaseEnd(seededIdlePhaseId);

  const operations: OperationCaseResult[] = [];
  const accountModel: AccountModel = {
    balances: Array<number>(ACCOUNT_COUNT).fill(ACCOUNT_BALANCE),
    versions: Array<number>(ACCOUNT_COUNT).fill(0),
  };
  const operationNames: OperationName[] = ["query", "mutation-uncontended", "mutation-contended", "procedure"];
  for (const operation of operationNames) {
    for (const profile of config.operation.profiles) {
      operations.push(await runOperationCase(adapter, operation, profile, config, nextNonce, accountModel));
    }
  }

  const connectionBaselineIdlePhaseId = "connections:baseline-idle";
  phaseStart(connectionBaselineIdlePhaseId);
  await Bun.sleep(config.resources.idleMs);
  phaseEnd(connectionBaselineIdlePhaseId);
  const connections = await runConnectionScale(adapter, config, nextNonce);
  const subscriptions: SubscriptionResult[] = [];
  for (const pattern of config.subscriptions.patterns) {
    subscriptions.push(await runSubscriptionCase(adapter, pattern, config, nextNonce));
  }

  return {
    system: adapter.system,
    config,
    snapshots: { seededIdle, seededIdlePhaseId, connectionBaselineIdlePhaseId },
    operations,
    connections,
    subscriptions,
  };
}
