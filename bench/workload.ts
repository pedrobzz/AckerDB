import {
  ACCOUNT_BALANCE,
  ACCOUNT_COUNT,
  ACCOUNT_PAIRS,
  DOCUMENT_COUNT,
  DOCUMENT_PARTITIONS,
  DOCUMENTS_PER_PARTITION,
  FNV_OFFSET,
  OPERATION_NAMES,
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
  type BenchmarkCaseFailure,
  type BenchConnection,
  type BenchmarkConfig,
  type ChannelRow,
  type ConnectionLevelResult,
  type OperationCaseResult,
  type OperationName,
  type OperationProfile,
  type SearchResult,
  type SubscriptionCapacityResult,
  type SubscriptionPattern,
  type SubscriptionResult,
  type TrialResult,
} from "./benchmark.ts";
import {
  latencyStats,
  median,
  runClosedLoop,
  withTimeout,
  type ClosedLoopReleaseResult,
} from "./load-engine.ts";
import { capacityMetricName, type BenchUnit, type UnitMetric } from "./units.ts";

const COMPUTE_ROUNDS = 8;
const TRANSFER_AMOUNT = 1;

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

async function releaseResources(
  label: string,
  timeoutMs: number,
  releases: readonly (() => Promise<void>)[],
): Promise<ClosedLoopReleaseResult> {
  try {
    const results = await withTimeout(
      Promise.allSettled(releases.map((release) => release())),
      Math.max(1, Math.min(timeoutMs, 5_000)),
      label,
    );
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [errorMessage(result.reason)] : []
    );
    return { released: errors.length === 0, errors };
  } catch (error) {
    return { released: false, errors: [errorMessage(error)] };
  }
}

function connectionReleases(connections: readonly BenchConnection[]): Array<() => Promise<void>> {
  return connections.map((connection) => () => connection.close());
}

function failureDetails(
  stage: BenchmarkCaseFailure["stage"],
  message: string,
  terminal = false,
  partial?: BenchmarkCaseFailure["partial"],
): Pick<BenchmarkCaseFailure, "stage" | "message" | "terminal" | "partial"> {
  return {
    stage,
    message,
    terminal,
    ...(partial === undefined ? {} : { partial }),
  };
}

function operationFailure(
  operation: OperationName,
  profile: OperationProfile,
  details: ReturnType<typeof failureDetails>,
  completedTrials: TrialResult[] = [],
): BenchmarkCaseFailure {
  return { kind: "operation", operation, profile, completedTrials, ...details };
}

function connectionFailure(
  targetConnections: number,
  details: ReturnType<typeof failureDetails>,
): BenchmarkCaseFailure {
  return { kind: "connection", targetConnections, ...details };
}

function subscriptionCapacityFailure(
  pattern: SubscriptionPattern,
  slots: number,
  details: ReturnType<typeof failureDetails>,
): BenchmarkCaseFailure {
  return { kind: "subscription-capacity", pattern, slots, ...details };
}

function subscriptionFailure(
  pattern: SubscriptionPattern,
  details: ReturnType<typeof failureDetails>,
): BenchmarkCaseFailure {
  return { kind: "subscription", pattern, ...details };
}

interface SubscriptionCaseOutcome {
  measurement?: SubscriptionResult;
  failures: BenchmarkCaseFailure[];
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
): Promise<{ connections: BenchConnection[]; latencies: number[]; errors: string[]; timedOut: boolean }> {
  const connections: BenchConnection[] = [];
  const latencies: number[] = [];
  const errors: string[] = [];
  let timedOut = false;
  let accepting = true;
  const attempts = Array.from({ length: count }, async () => {
    const startedAt = performance.now();
    try {
      const connection = await adapter.connect(nonce(), true);
      if (!accepting) {
        await connection.close();
        return;
      }
      latencies.push(performance.now() - startedAt);
      connections.push(connection);
    } catch (error) {
      if (accepting && errors.length < 8) errors.push(errorMessage(error));
    }
  });
  try {
    await withTimeout(Promise.all(attempts), timeoutMs, `opening ${count} connections`);
  } catch (error) {
    timedOut = true;
    if (errors.length < 8) errors.push(errorMessage(error));
  } finally {
    accepting = false;
  }
  return { connections, latencies, errors, timedOut };
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
    cancel: () => releaseResources(
      `${phaseId} connection release`,
      config.operation.drainTimeoutMs,
      connectionReleases(connections),
    ),
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
  if (operation.startsWith("mutation") && result.interruption === null) {
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
): Promise<OperationCaseResult | BenchmarkCaseFailure> {
  const opened = await openConnections(adapter, profile.connections, nextNonce, config.connections.timeoutMs);
  if (opened.connections.length !== profile.connections) {
    const released = await releaseResources(
      `${operation}/${profile.name} setup connection release`,
      config.operation.drainTimeoutMs,
      connectionReleases(opened.connections),
    );
    const errors = [...opened.errors, ...released.errors];
    const message = `opened ${opened.connections.length}/${profile.connections} clients: ${errors.join("; ")}`;
    return operationFailure(
      operation,
      profile,
      failureDetails("setup", message, opened.timedOut || !released.released),
    );
  }
  const trials: TrialResult[] = [];
  try {
    const warmup = await runClosedLoop({
      phaseId: `operation:${operation}:${profile.name}:warmup`,
      durationMs: config.operation.warmupMs,
      slots: profile.connections * profile.inFlightPerConnection,
      drainTimeoutMs: config.operation.drainTimeoutMs,
      cancel: () => releaseResources(
        `${operation}/${profile.name} warmup connection release`,
        config.operation.drainTimeoutMs,
        connectionReleases(opened.connections),
      ),
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
    if (warmup.failed > 0 || warmup.errors.length > 0) {
      if (warmup.interruption !== null) opened.connections.length = 0;
      return operationFailure(
        operation,
        profile,
        failureDetails(
          "warmup",
          warmup.errors.join("; ") || `${warmup.failed} warmup request(s) failed`,
          warmup.interruption?.resourcesReleased === false,
          warmup,
        ),
      );
    }

    for (let trial = 0; trial < config.operation.trials; trial++) {
      try {
        const result = await runOperationTrial(
          operation,
          profile,
          trial,
          opened.connections,
          config,
          nextNonce,
          accountModel,
        );
        trials.push(result);
        if (result.interruption !== null) {
          opened.connections.length = 0;
          return operationFailure(
            operation,
            profile,
            failureDetails(
              "phase",
              result.interruption.reason,
              !result.interruption.resourcesReleased,
              result,
            ),
            trials,
          );
        }
      } catch (error) {
        return operationFailure(
          operation,
          profile,
          failureDetails("phase", errorMessage(error)),
          trials,
        );
      }
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
    const released = await releaseResources(
      `${operation}/${profile.name} connection release`,
      config.operation.drainTimeoutMs,
      connectionReleases(opened.connections),
    );
    if (!released.released) {
      return operationFailure(
        operation,
        profile,
        failureDetails("cleanup", released.errors.join("; "), true),
        trials,
      );
    }
  }
}

export interface ConnectionLevelOptions {
  /**
   * Whether to hold the connected fleet idle for a resource window. That window
   * is a second of deliberate sleeping which measures resident cost rather than
   * work, so the pair driver asks for it once per side and reads it as context
   * beside the comparison rather than through it.
   */
  readonly measureIdle: boolean;
}

export interface ConnectionLevelOutcome {
  measurement?: ConnectionLevelResult;
  failures: BenchmarkCaseFailure[];
}

/**
 * One connection level, on a cohort it opens and releases itself. The levels
 * used to share one growing cohort, which made each level's cost depend on
 * every level before it and made a single level impossible to repeat. A unit
 * the pair driver alternates has to start from the same place every time, so a
 * level now pays for its own connections and the ladder is a set of independent
 * levels rather than one sequence.
 *
 * Connect readiness used to be sampled twenty times inside the one-client
 * level, each draw preceded by a full idle second so it measured post-idle
 * readiness — nineteen seconds of deliberate sleeping per side. Interleaving
 * supplies that idle for free: while the other side holds the machine, this one
 * has no traffic in flight, so a single draw per repetition is already a
 * post-idle draw and the repetitions are the distribution.
 */
export async function runConnectionLevel(
  adapter: BenchAdapter,
  config: BenchmarkConfig,
  target: number,
  nextNonce: () => number,
  options: ConnectionLevelOptions,
): Promise<ConnectionLevelOutcome> {
  const cohort: BenchConnection[] = [];
  const connectLatencies: number[] = [];
  const errors: string[] = [];
  let setupFailure: BenchmarkCaseFailure | undefined;
  let interrupted: BenchmarkCaseFailure | undefined;
  let measurement: ConnectionLevelResult | undefined;
  let released: ClosedLoopReleaseResult = { released: true, errors: [] };
  const rampPhaseId = `connections:${target}:ramp`;
  const setupStartedAt = phaseStart(rampPhaseId);
  try {
    let setupTerminal = false;
    for (let remaining = target; remaining > 0; remaining -= config.connections.batchSize) {
      const count = Math.min(config.connections.batchSize, remaining);
      const opened = await openConnections(adapter, count, nextNonce, config.connections.timeoutMs);
      cohort.push(...opened.connections);
      connectLatencies.push(...opened.latencies);
      errors.push(...opened.errors);
      if (opened.connections.length !== count) {
        setupTerminal = opened.timedOut;
        break;
      }
    }
    const setupMs = phaseEnd(rampPhaseId) - setupStartedAt;
    if (cohort.length !== target) {
      setupFailure = connectionFailure(
        target,
        failureDetails(
          "setup",
          [`connected ${cohort.length}/${target}`, ...errors].join("; "),
          setupTerminal,
        ),
      );
    } else {
      let connectedSnapshotId: string | undefined;
      let connectedIdlePhaseId: string | undefined;
      if (options.measureIdle) {
        connectedSnapshotId = `connections:${target}:connected`;
        connectedIdlePhaseId = `connections:${target}:idle`;
        phaseStart(connectedIdlePhaseId);
        await Bun.sleep(config.resources.idleMs);
        snapshot(connectedSnapshotId);
        phaseEnd(connectedIdlePhaseId);
      }

      const phaseId = `connections:${target}:work`;
      const work = await runClosedLoop({
        phaseId,
        durationMs: config.connections.workMs,
        slots: cohort.length,
        drainTimeoutMs: config.operation.drainTimeoutMs,
        onWindowStart: (timestampMs) => phaseStartAt(phaseId, timestampMs),
        cancel: () => releaseResources(
          `${phaseId} connection release`,
          config.operation.drainTimeoutMs,
          connectionReleases(cohort),
        ),
        operation: async (slot) => {
          const nonce = nextNonce();
          const partition = nonce % DOCUMENT_PARTITIONS;
          const value = await cohort[slot]!.search(partition, nonce);
          return { nonce, partition, value };
        },
        validate: ({ nonce, partition, value }) => validateSearch(value, partition, nonce),
      });
      phaseEndAt(phaseId, work.windowEndedAtMs);
      if (work.interruption === null) {
        measurement = {
          targetConnections: target,
          connected: cohort.length,
          setupMs,
          readyConnectionsPerSec: connectLatencies.length / (setupMs / 1_000),
          readyLatency: latencyStats(connectLatencies),
          connectedSnapshotId,
          connectedIdlePhaseId,
          work: { ...work, phaseId },
          errors,
        };
      } else {
        interrupted = connectionFailure(
          target,
          failureDetails(
            work.interruption.resourcesReleased ? "phase" : "cleanup",
            work.interruption.reason,
            !work.interruption.resourcesReleased,
            work,
          ),
        );
        // The closed loop's own cancellation already closed this cohort; leaving
        // it in the list would close every connection a second time.
        if (work.interruption.resourcesReleased) cohort.length = 0;
      }
    }
  } finally {
    released = await releaseResources(
      `connections:${target} release`,
      config.operation.drainTimeoutMs,
      connectionReleases(cohort),
    );
  }
  const failure = setupFailure ?? interrupted;
  if (!released.released) {
    return {
      failures: [connectionFailure(
        target,
        failureDetails(
          "cleanup",
          [...(failure === undefined ? [] : [failure.message]), ...released.errors].join("; "),
          true,
          failure?.partial ?? measurement?.work,
        ),
      )],
    };
  }
  return { measurement, failures: failure === undefined ? [] : [failure] };
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

async function waitForDeliveryDrain(probes: readonly PendingDelivery[], timeoutMs: number): Promise<boolean> {
  const incomplete = probes.filter((probe) => probe.observedCount !== probe.expectedCount);
  if (incomplete.length === 0) return true;
  const remainingMs = Math.max(...incomplete.map((probe) => probe.sentAt + timeoutMs)) - performance.now();
  if (remainingMs <= 0) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.all(incomplete.map((probe) => probe.done)).then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), remainingMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function expectedChannels(pattern: SubscriptionPattern, user: number, users: number, queries: number): number[] {
  if (pattern === "shared") return Array.from({ length: queries }, (_, channel) => channel);
  return Array.from({ length: queries }, (_, query) => queries + user * queries + query).filter(
    (channel) => channel < (users + 1) * queries,
  );
}

export async function runSubscriptionCase(
  adapter: BenchAdapter,
  pattern: SubscriptionPattern,
  config: BenchmarkConfig,
  nextNonce: () => number,
  options: ConnectionLevelOptions,
): Promise<SubscriptionCaseOutcome> {
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
  let baselineIdlePhaseId: string | undefined;
  if (options.measureIdle) {
    baselineIdlePhaseId = `subscriptions:${pattern}:baseline-idle`;
    phaseStart(baselineIdlePhaseId);
    await Bun.sleep(config.resources.idleMs);
    phaseEnd(baselineIdlePhaseId);
  }
  const setupPhaseId = `subscriptions:${pattern}:setup`;
  const setupStartedAt = phaseStart(setupPhaseId);
  let acceptingSubscribers = true;

  const onUpdate = (user: number, row: ChannelRow) => {
    // A channel keeps its version in the database, so a second run of this unit
    // does not start again at one. Every subscriber's first row carries the
    // version the server is actually on, and that is the only place the writer
    // can learn it — predict the wrong next version and every delivery looks
    // unexpected, every probe waits out its drain, and the unit reports a
    // fabricated delivery failure instead of a measurement.
    if (row.version > (versions.get(row.channel) ?? 0)) versions.set(row.channel, row.version);
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
    const readiness = (async () => {
      for (let start = 0; start < users && acceptingSubscribers; start += Math.min(25, config.connections.batchSize)) {
        const count = Math.min(25, users - start);
        const batch = await Promise.allSettled(
          Array.from({ length: count }, async (_, offset) => {
            const user = start + offset;
            const connection = await adapter.connect(nextNonce(), true);
            if (!acceptingSubscribers) {
              await connection.close();
              return;
            }
            try {
              const unsubscribe = await connection.subscribeChannels(
                expectedChannels(pattern, user, users, queriesPerUser),
                (row) => onUpdate(user, row),
              );
              if (!acceptingSubscribers) {
                await Promise.allSettled([unsubscribe(), connection.close()]);
                return;
              }
              subscribers.push(connection);
              unsubscribes.push(unsubscribe);
            } catch (error) {
              await connection.close().catch(() => {});
              throw error;
            }
          }),
        );
        const failures = batch.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
        if (failures.length > 0) {
          throw new AggregateError(
            failures,
            `${failures.length} subscription connection(s) failed: ${failures.map(errorMessage).join("; ")}`,
          );
        }
      }
    })();
    let readinessSettled = false;
    void readiness.then(
      () => { readinessSettled = true; },
      () => { readinessSettled = true; },
    );
    try {
      await withTimeout(readiness, setupTimeoutMs, `${pattern} subscription readiness`);
    } catch (error) {
      acceptingSubscribers = false;
      phaseEnd(setupPhaseId);
      return {
        failures: [subscriptionFailure(
          pattern,
          failureDetails("setup", errorMessage(error), !readinessSettled),
        )],
      };
    }

    const openedWriter = await openConnections(adapter, 1, nextNonce, config.connections.timeoutMs);
    if (openedWriter.connections.length !== 1) {
      const released = await releaseResources(
        `${pattern} writer setup release`,
        drainTimeoutMs,
        connectionReleases(openedWriter.connections),
      );
      acceptingSubscribers = false;
      phaseEnd(setupPhaseId);
      return {
        failures: [subscriptionFailure(
          pattern,
          failureDetails(
            "setup",
            `opened ${openedWriter.connections.length}/1 subscription writers: ${[
              ...openedWriter.errors,
              ...released.errors,
            ].join("; ")}`,
            openedWriter.timedOut || !released.released,
          ),
        )],
      };
    }
    writers.push(...openedWriter.connections);
    const setupEndedAt = phaseEnd(setupPhaseId);
    let subscribedSnapshotId: string | undefined;
    let subscribedIdlePhaseId: string | undefined;
    if (options.measureIdle) {
      subscribedSnapshotId = `subscriptions:${pattern}:subscribed`;
      subscribedIdlePhaseId = `subscriptions:${pattern}:idle`;
      phaseStart(subscribedIdlePhaseId);
      await Bun.sleep(config.resources.idleMs);
      snapshot(subscribedSnapshotId);
      phaseEnd(subscribedIdlePhaseId);
    }

    const phaseId = `subscriptions:${pattern}:updates`;
    const phaseStartedAt = phaseStart(phaseId);
    measuring = true;
    const rate = pattern === "shared" ? config.subscriptions.sharedUpdatesPerSec : config.subscriptions.partitionedUpdatesPerSec;
    const updateCount = offeredFixedRateUpdates(config.subscriptions.durationMs, rate);
    const ackLatencies: number[] = [];
    const probes: PendingDelivery[] = [];
    const errors: string[] = [];
    for (let update = 0; update < updateCount; update++) {
      const scheduledAt = phaseStartedAt + (update * 1_000) / rate;
      const delay = scheduledAt - performance.now();
      if (delay > 0) await Bun.sleep(delay);
      const channel =
        pattern === "shared" ? update % queriesPerUser : queriesPerUser + (update % (users * queriesPerUser));
      const previousVersion = versions.get(channel) ?? 0;
      if (previousVersion > 0) {
        const previous = pending.get(`${channel}:${previousVersion}`);
        if (previous) await waitForDeliveryDrain([previous], drainTimeoutMs);
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
      try {
        await writers[0]!.updateChannel(channel, nonce);
        ackLatencies.push(performance.now() - ackStartedAt);
      } catch (error) {
        if (errors.length < 8) {
          errors.push(`channel ${channel} version ${version} update: ${errorMessage(error)}`);
        }
      }
    }
    const sendEndedAt = performance.now();
    const remainingWindowMs = phaseStartedAt + config.subscriptions.durationMs - performance.now();
    if (remainingWindowMs > 0) await Bun.sleep(remainingWindowMs);
    await waitForDeliveryDrain(probes, drainTimeoutMs);
    measuring = false;
    const phaseEndedAt = phaseEnd(phaseId);
    const deliveryLatencies = probes.flatMap((probe) => probe.latencies);
    const timeToAll = probes.flatMap((probe) =>
      probe.observedCount === probe.expectedCount ? [Math.max(...probe.latencies)] : []
    );
    const expectedDeliveries = probes.reduce((total, probe) => total + probe.expectedCount, 0);
    const observedDeliveries = probes.reduce((total, probe) => total + probe.observedCount, 0);
    const missingDeliveries = expectedDeliveries - observedDeliveries;
    if (subscribers.length !== users) errors.push(`ready users ${subscribers.length}/${users}`);
    if (missingDeliveries !== 0) errors.push(`missing ${missingDeliveries}/${expectedDeliveries} deliveries`);
    if (duplicates !== 0) errors.push(`${duplicates} duplicate deliveries`);
    if (unexpected !== 0) errors.push(`${unexpected} unexpected deliveries`);
    if (corrupt !== 0) errors.push(`${corrupt} corrupt deliveries`);

    pending.clear();
    const levels = subscriptionCapacitySlots(config.subscriptions, pattern);
    const capacity: SubscriptionCapacityResult[] = [];
    const failures: BenchmarkCaseFailure[] = [];
    let capacityTerminalFailure: ReturnType<typeof failureDetails> | undefined;
    for (const slots of levels) {
      if (capacityTerminalFailure !== undefined) {
        failures.push(subscriptionCapacityFailure(pattern, slots, capacityTerminalFailure));
        continue;
      }
      let writerSetupFailure: ReturnType<typeof failureDetails> | undefined;
      for (let remaining = slots - writers.length; remaining > 0; remaining -= config.connections.batchSize) {
        const count = Math.min(config.connections.batchSize, remaining);
        const opened = await openConnections(adapter, count, nextNonce, config.connections.timeoutMs);
        if (opened.connections.length !== count) {
          const released = await releaseResources(
            `${pattern} capacity-${slots} partial writer release`,
            drainTimeoutMs,
            connectionReleases(opened.connections),
          );
          writerSetupFailure = failureDetails(
            "setup",
            `opened ${opened.connections.length}/${count} capacity writers: ${[
              ...opened.errors,
              ...released.errors,
            ].join("; ")}`,
            opened.timedOut || !released.released,
          );
          break;
        }
        writers.push(...opened.connections);
      }
      if (writerSetupFailure !== undefined) {
        failures.push(subscriptionCapacityFailure(pattern, slots, writerSetupFailure));
        if (writerSetupFailure.terminal) {
          capacityTerminalFailure = writerSetupFailure;
        }
        continue;
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
        cancel: () => releaseResources(
          `${capacityPhaseId} writer release`,
          drainTimeoutMs,
          connectionReleases(writers),
        ),
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
          const delivered = await cancellation.wait(waitForDeliveryDrain([probe], drainTimeoutMs));
          if (!delivered) {
            throw new Error(`channel ${channel} version ${version} delivery timed out after ${drainTimeoutMs}ms`);
          }
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
      const capacityMeasurement: SubscriptionCapacityResult = {
        ...result,
        slots,
        phaseId: capacityPhaseId,
        deliveriesPerUpdate: pattern === "shared" ? users : 1,
        deliveryThroughputPerSec: result.throughputPerSec * (pattern === "shared" ? users : 1),
        updateAckLatency: latencyStats(capacityAckLatencies),
        deliveryLatency: latencyStats(capacityDeliveryLatencies),
        correctness: { ok: result.failed === 0 && capacityErrors.length === 0, errors: capacityErrors },
      };
      pending.clear();
      if (result.interruption !== null) {
        const details = failureDetails(
          result.interruption.resourcesReleased ? "phase" : "cleanup",
          result.interruption.reason,
          !result.interruption.resourcesReleased,
          result,
        );
        failures.push(subscriptionCapacityFailure(pattern, slots, details));
        writers.length = 0;
        if (!result.interruption.resourcesReleased) {
          capacityTerminalFailure = details;
        }
      } else {
        capacity.push(capacityMeasurement);
      }
    }

    return { measurement: {
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
    }, failures };
  } finally {
    acceptingSubscribers = false;
    measuring = false;
    const released = await releaseResources(
      `${pattern} subscription release`,
      drainTimeoutMs,
      [
        ...unsubscribes,
        ...connectionReleases(subscribers),
        ...connectionReleases(writers),
      ],
    );
    if (!released.released) {
      return {
        failures: [subscriptionFailure(
          pattern,
          failureDetails("cleanup", released.errors.join("; "), true),
        )],
      };
    }
  }
}

function operationMetrics(result: OperationCaseResult): UnitMetric[] {
  return [
    { name: "throughput/s", value: result.medianThroughputPerSec },
    { name: "p50 ms", value: result.medianLatencyP50Ms },
    { name: "p95 ms", value: result.medianLatencyP95Ms },
    { name: "p99 ms", value: result.medianLatencyP99Ms },
  ];
}

function connectionMetrics(result: ConnectionLevelResult): UnitMetric[] {
  return [
    { name: "ready/s", value: result.readyConnectionsPerSec },
    { name: "ready p50 ms", value: result.readyLatency.p50Ms },
    { name: "ready p95 ms", value: result.readyLatency.p95Ms },
    { name: "throughput/s", value: result.work.throughputPerSec },
    { name: "p50 ms", value: result.work.latency.p50Ms },
    { name: "p95 ms", value: result.work.latency.p95Ms },
    { name: "p99 ms", value: result.work.latency.p99Ms },
  ];
}

function subscriptionMetrics(result: SubscriptionResult): UnitMetric[] {
  return [
    { name: "updates/s", value: result.updateThroughputPerSec },
    { name: "deliveries/s", value: result.deliveryThroughputPerSec },
    { name: "delivery p50 ms", value: result.deliveryLatency.p50Ms },
    { name: "delivery p95 ms", value: result.deliveryLatency.p95Ms },
    { name: "delivery p99 ms", value: result.deliveryLatency.p99Ms },
    ...result.capacity.flatMap((capacity) => [
      { name: capacityMetricName(capacity.slots, "updates/s"), value: capacity.throughputPerSec },
      { name: capacityMetricName(capacity.slots, "deliveries/s"), value: capacity.deliveryThroughputPerSec },
      { name: capacityMetricName(capacity.slots, "ack p50 ms"), value: capacity.updateAckLatency.p50Ms },
      { name: capacityMetricName(capacity.slots, "ack p95 ms"), value: capacity.updateAckLatency.p95Ms },
      { name: capacityMetricName(capacity.slots, "all p50 ms"), value: capacity.latency.p50Ms },
      { name: capacityMetricName(capacity.slots, "all p95 ms"), value: capacity.latency.p95Ms },
      { name: capacityMetricName(capacity.slots, "all p99 ms"), value: capacity.latency.p99Ms },
    ]),
  ];
}

/** One unit's slice of a repetition: its comparable numbers and its full record. */
export interface WorkloadUnitResult {
  readonly metrics: readonly UnitMetric[];
  readonly operations: readonly OperationCaseResult[];
  readonly connections: readonly ConnectionLevelResult[];
  readonly subscriptions: readonly SubscriptionResult[];
  readonly failures: readonly BenchmarkCaseFailure[];
}

export interface WorkloadSession {
  readonly config: BenchmarkConfig;
  readonly seededIdle: { readonly snapshotId: string; readonly phaseId: string };
  runUnit(unit: BenchUnit, options: ConnectionLevelOptions): Promise<WorkloadUnitResult>;
}

/**
 * A seeded server and the state that must survive between units, held open so a
 * caller outside this process can ask for one unit at a time. The workload used
 * to run itself start to finish in a single call, which forced the comparison
 * to be one side's whole pass against the other's. The pair driver instead
 * keeps a session on each side and alternates units between them, so every
 * number head reports has a base number measured seconds away from it under the
 * same conditions.
 *
 * The nonce stream and the account model are per session, so each side stays
 * consistent with its own server. The two sides drift apart in how many
 * operations they complete — that difference is the measurement — and nothing
 * in the validation depends on them agreeing.
 */
export async function openWorkloadSession(adapter: BenchAdapter): Promise<WorkloadSession> {
  const config = benchmarkConfigFromEnv();
  let nonce = config.seed;
  const nextNonce = () => nonce++ >>> 0;
  const accountModel: AccountModel = {
    balances: Array<number>(ACCOUNT_COUNT).fill(ACCOUNT_BALANCE),
    versions: Array<number>(ACCOUNT_COUNT).fill(0),
  };

  const seeder = await adapter.connect(nextNonce(), false);
  try {
    await seed(seeder, config);
  } finally {
    const released = await releaseResources(
      "seeder connection release",
      config.operation.drainTimeoutMs,
      [() => seeder.close()],
    );
    if (!released.released) throw new Error(released.errors.join("; "));
  }

  const seededIdle = { snapshotId: "server:seeded-idle", phaseId: "server:seeded-idle-window" } as const;
  phaseStart(seededIdle.phaseId);
  await Bun.sleep(config.resources.idleMs);
  snapshot(seededIdle.snapshotId);
  phaseEnd(seededIdle.phaseId);

  return {
    config,
    seededIdle,
    async runUnit(unit, options) {
      const empty = { metrics: [], operations: [], connections: [], subscriptions: [] };
      if (unit.kind === "operation") {
        const result = await runOperationCase(
          adapter,
          unit.operation,
          unit.profile,
          config,
          nextNonce,
          accountModel,
        );
        return "kind" in result
          ? { ...empty, failures: [result] }
          : { ...empty, metrics: operationMetrics(result), operations: [result], failures: [] };
      }
      if (unit.kind === "connection") {
        const outcome = await runConnectionLevel(adapter, config, unit.targetConnections, nextNonce, options);
        const measurement = outcome.measurement;
        return measurement === undefined
          ? { ...empty, failures: outcome.failures }
          : {
              ...empty,
              metrics: connectionMetrics(measurement),
              connections: [measurement],
              failures: outcome.failures,
            };
      }
      const outcome = await runSubscriptionCase(adapter, unit.pattern, config, nextNonce, options);
      const measurement = outcome.measurement;
      return measurement === undefined
        ? { ...empty, failures: outcome.failures }
        : {
            ...empty,
            metrics: subscriptionMetrics(measurement),
            subscriptions: [measurement],
            failures: outcome.failures,
          };
    },
  };
}
