export type SystemName = "ackerdb";
export type OperationName = "query" | "mutation-uncontended" | "mutation-contended" | "procedure";
export type SubscriptionPattern = "shared" | "partitioned";

export const OPERATION_NAMES = Object.freeze([
  "query",
  "mutation-uncontended",
  "mutation-contended",
  "procedure",
] as const satisfies readonly OperationName[]);

export const DOCUMENT_PARTITIONS = 64;
export const DOCUMENTS_PER_PARTITION = 128;
export const DOCUMENT_COUNT = DOCUMENT_PARTITIONS * DOCUMENTS_PER_PARTITION;
export const ACCOUNT_COUNT = 2_048;
export const ACCOUNT_BALANCE = 1_000_000;
export const ACCOUNT_PAIRS = ACCOUNT_COUNT / 2;
export const PAYLOAD_BYTES = 128;
export const PROCEDURE_PAYLOAD_BYTES = 1_024;
export const FNV_OFFSET = 2_166_136_261;
export const FNV_PRIME = 16_777_619;

export interface OperationProfile {
  name: "latency" | "pipeline" | "concurrent" | "saturation";
  connections: number;
  inFlightPerConnection: number;
}

export interface BenchmarkConfig {
  profile: "quick" | "default" | "stress";
  seed: number;
  operation: {
    warmupMs: number;
    steadyMs: number;
    trials: number;
    drainTimeoutMs: number;
    profiles: OperationProfile[];
  };
  connections: {
    levels: number[];
    batchSize: number;
    workMs: number;
    timeoutMs: number;
  };
  subscriptions: {
    users: number;
    queriesPerUser: number;
    durationMs: number;
    sharedUpdatesPerSec: number;
    partitionedUpdatesPerSec: number;
    capacityDurationMs: number;
    capacitySlots: number[];
    setupTimeoutMs: number;
    drainTimeoutMs: number;
    patterns: SubscriptionPattern[];
  };
  resources: {
    idleMs: number;
  };
  seedBatchSize: number;
}

export interface SearchRow {
  rank: number;
  score: number;
  payload: string;
}

export interface SearchResult {
  nonce: number;
  checksum: number;
  rows: SearchRow[];
}

export interface AccountState {
  nonce: number;
  count: number;
  totalBalance: number;
  totalVersion: number;
  checksum: number;
}

export interface ComputeResult {
  nonce: number;
  checksum: number;
}

export interface ChannelRow {
  channel: number;
  version: number;
  checksum: number;
  payload: string;
}

export interface ProbeResult {
  nonce: number;
  account: number;
  balance: number;
  version: number;
  checksum: number;
}

export interface BenchConnection {
  search(partition: number, nonce: number): Promise<SearchResult>;
  transfer(pair: number, direction: number, amount: number, nonce: number): Promise<void>;
  accountState(nonce: number): Promise<AccountState>;
  compute(nonce: number, seed: number, payload: string, rounds: number): Promise<ComputeResult>;
  updateChannel(channel: number, nonce: number): Promise<void>;
  subscribeChannels(channels: number[], onUpdate: (row: ChannelRow) => void): Promise<() => Promise<void>>;
  seedDocuments(start: number, count: number): Promise<void>;
  seedAccounts(start: number, count: number): Promise<void>;
  seedChannels(start: number, count: number): Promise<void>;
  close(): Promise<void>;
}

export interface BenchAdapter {
  system: SystemName;
  connect(nonce: number, seeded: boolean): Promise<BenchConnection>;
}

export interface LatencyStats {
  count: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

export interface ClosedLoopResult {
  windowStartedAtMs: number;
  windowEndedAtMs: number;
  wallMs: number;
  attempted: number;
  completedInWindow: number;
  completedAfterWindow: number;
  failed: number;
  throughputPerSec: number;
  latency: LatencyStats;
  errors: string[];
  interruption: null | {
    reason: string;
    resourcesReleased: boolean;
  };
}

export interface TrialResult extends ClosedLoopResult {
  phaseId: string;
  correctness: { ok: boolean; errors: string[] };
}

interface BenchmarkCaseFailureDetails {
  stage: "setup" | "warmup" | "phase" | "cleanup";
  message: string;
  terminal: boolean;
  partial?: ClosedLoopResult;
}

export type BenchmarkCaseFailure = BenchmarkCaseFailureDetails & (
  | {
      kind: "operation";
      operation: OperationName;
      profile: OperationProfile;
      completedTrials: TrialResult[];
    }
  | { kind: "connection"; targetConnections: number }
  | { kind: "subscription"; pattern: SubscriptionPattern }
  | { kind: "subscription-capacity"; pattern: SubscriptionPattern; slots: number }
);

export interface OperationCaseResult {
  operation: OperationName;
  profile: OperationProfile;
  trials: TrialResult[];
  medianThroughputPerSec: number;
  medianLatencyP50Ms: number;
  medianLatencyP95Ms: number;
  medianLatencyP99Ms: number;
}

export interface ConnectionLevelResult {
  targetConnections: number;
  connected: number;
  setupMs: number;
  readyConnectionsPerSec: number;
  readyLatency: LatencyStats;
  /** Present only on the repetition that paid for an idle resource window. */
  connectedSnapshotId?: string;
  connectedIdlePhaseId?: string;
  work: ClosedLoopResult & { phaseId: string };
  errors: string[];
}

export interface SubscriptionResult {
  pattern: SubscriptionPattern;
  users: number;
  queriesPerUser: number;
  logicalSubscriptions: number;
  distinctQueryArguments: number;
  /** Present only on the repetition that paid for an idle resource window. */
  baselineIdlePhaseId?: string;
  setupMs: number;
  setupConnectionsPerSec: number;
  subscribedSnapshotId?: string;
  subscribedIdlePhaseId?: string;
  phaseId: string;
  updates: number;
  updateThroughputPerSec: number;
  expectedDeliveries: number;
  observedDeliveries: number;
  duplicateDeliveries: number;
  unexpectedDeliveries: number;
  corruptDeliveries: number;
  missingDeliveries: number;
  deliveryThroughputPerSec: number;
  updateAckLatency: LatencyStats;
  deliveryLatency: LatencyStats;
  timeToAll: LatencyStats;
  capacity: SubscriptionCapacityResult[];
  correctness: { ok: boolean; errors: string[] };
}

export interface SubscriptionCapacityResult extends ClosedLoopResult {
  slots: number;
  phaseId: string;
  deliveriesPerUpdate: number;
  deliveryThroughputPerSec: number;
  updateAckLatency: LatencyStats;
  deliveryLatency: LatencyStats;
  correctness: { ok: boolean; errors: string[] };
}

/** One side's full record for one repetition of every unit. */
export interface DriverResult {
  system: SystemName;
  config: BenchmarkConfig;
  operations: OperationCaseResult[];
  connections: ConnectionLevelResult[];
  subscriptions: SubscriptionResult[];
  failures: BenchmarkCaseFailure[];
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function integerList(name: string, fallback: number[]): number[] {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const values = raw.split(",").map((value) => Number(value.trim()));
  if (values.length === 0 || values.some((value) => !Number.isInteger(value) || value <= 0)) {
    throw new Error(`${name} must be a comma-separated list of positive integers`);
  }
  return [...new Set(values)].sort((a, b) => a - b);
}

export function benchmarkConfigFromEnv(): BenchmarkConfig {
  const profile = (process.env.BENCH_PROFILE ?? "default") as BenchmarkConfig["profile"];
  if (profile !== "quick" && profile !== "default" && profile !== "stress") {
    throw new Error(`BENCH_PROFILE must be quick, default, or stress`);
  }

  const quick = profile === "quick";
  // The default workload measures the two points a decision rests on: the
  // single-user floor (latency) and the throughput ceiling (saturation). The
  // intermediate rungs live in the stress profile — they cost minutes and
  // change no verdicts.
  const profiles: OperationProfile[] = quick
    ? [
        { name: "latency", connections: 1, inFlightPerConnection: 1 },
        { name: "concurrent", connections: 4, inFlightPerConnection: 4 },
      ]
    : profile === "stress"
      ? [
          { name: "latency", connections: 1, inFlightPerConnection: 1 },
          { name: "pipeline", connections: 1, inFlightPerConnection: 8 },
          { name: "concurrent", connections: 8, inFlightPerConnection: 4 },
          { name: "saturation", connections: 32, inFlightPerConnection: 4 },
        ]
      : [
          { name: "latency", connections: 1, inFlightPerConnection: 1 },
          { name: "saturation", connections: 32, inFlightPerConnection: 4 },
        ];
  const defaultConnectionLevels = quick ? [1, 25] : profile === "stress" ? [1, 100, 500, 1_000, 5_000, 10_000] : [1, 1_000];

  return {
    profile,
    seed: positiveInt("BENCH_SEED", 0xdb22),
    // The default windows are short because the comparison repeats them. One
    // two-second window per side yields a single number whose error is the
    // machine's; sixteen interleaved three-hundred-millisecond windows yield
    // sixteen paired ratios whose spread is measurable and whose median is not
    // moved by one stalled window. What changes is that there is now something
    // to take a median of, and enough of them to bound it.
    operation: {
      warmupMs: positiveInt("BENCH_WARMUP_MS", quick ? 250 : 100),
      steadyMs: positiveInt("BENCH_STEADY_MS", quick ? 500 : 300),
      trials: positiveInt("BENCH_TRIALS", 1),
      drainTimeoutMs: positiveInt("BENCH_DRAIN_TIMEOUT_MS", 30_000),
      profiles,
    },
    connections: {
      levels: integerList("BENCH_CONNECTION_LEVELS", defaultConnectionLevels),
      batchSize: positiveInt("BENCH_CONNECTION_BATCH", quick ? 25 : 100),
      workMs: positiveInt("BENCH_CONNECTION_WORK_MS", quick ? 500 : 300),
      timeoutMs: positiveInt("BENCH_CONNECTION_TIMEOUT_MS", 120_000),
    },
    subscriptions: {
      users: positiveInt("BENCH_SUB_USERS", quick ? 10 : 500),
      queriesPerUser: positiveInt("BENCH_SUB_QUERIES", quick ? 5 : 10),
      // The fixed-rate window keeps more of its length than the others: it
      // offers whole updates at a fixed rate, so a window too short to contain
      // a decent count of them measures rounding rather than delivery.
      durationMs: positiveInt("BENCH_SUB_DURATION_MS", quick ? 500 : 600),
      sharedUpdatesPerSec: positiveInt("BENCH_SUB_SHARED_UPDATES_PER_SEC", quick ? 5 : 20),
      partitionedUpdatesPerSec: positiveInt("BENCH_SUB_PARTITIONED_UPDATES_PER_SEC", quick ? 10 : 100),
      capacityDurationMs: positiveInt("BENCH_SUB_CAPACITY_DURATION_MS", quick ? 500 : 250),
      capacitySlots: integerList("BENCH_SUB_CAPACITY_SLOTS", quick ? [1, 4] : [1, 32, 512]),
      setupTimeoutMs: positiveInt("BENCH_SUB_SETUP_TIMEOUT_MS", 120_000),
      drainTimeoutMs: positiveInt("BENCH_SUB_DRAIN_TIMEOUT_MS", 30_000),
      patterns: quick ? ["shared"] : ["shared", "partitioned"],
    },
    resources: {
      idleMs: positiveInt("BENCH_IDLE_MS", quick ? 500 : 1_000),
    },
    seedBatchSize: positiveInt("BENCH_SEED_BATCH", 256),
  };
}

/**
 * Discrete offered fixed-rate update count for one measurement window. The
 * workload emits exactly this many updates and acceptance requires exactly
 * this many back, so the offered-work contract has a single source of truth
 * even when durationMs is not a whole number of seconds.
 */
export function offeredFixedRateUpdates(durationMs: number, updatesPerSec: number): number {
  return Math.max(1, Math.floor((durationMs / 1_000) * updatesPerSec));
}

export function subscriptionCapacitySlots(
  config: BenchmarkConfig["subscriptions"],
  pattern: SubscriptionPattern,
): number[] {
  const availableChannels = pattern === "shared" ? config.queriesPerUser : config.users;
  const maximum = Math.min(availableChannels, config.capacitySlots[config.capacitySlots.length - 1]!);
  const levels = config.capacitySlots.filter((slots) => slots <= maximum);
  if (levels[levels.length - 1] !== maximum) levels.push(maximum);
  return levels;
}

export function mix(checksum: number, value: number): number {
  return Math.imul(checksum ^ (value >>> 0), FNV_PRIME) >>> 0;
}

export function mixText(checksum: number, value: string): number {
  for (let i = 0; i < value.length; i++) checksum = mix(checksum, value.charCodeAt(i));
  return checksum;
}

export function fixedPayload(prefix: string, bytes = PAYLOAD_BYTES): string {
  return prefix.padEnd(bytes, "x").slice(0, bytes);
}

export function documentPayload(partition: number, rank: number): string {
  return fixedPayload(`document:${partition}:rank:${rank}:`);
}

export function documentScore(partition: number, rank: number): number {
  return ((partition + 1) * 1_009 + rank * 9_176) % 1_000_003;
}

export function searchChecksum(nonce: number, rows: SearchRow[]): number {
  let checksum = mix(FNV_OFFSET, nonce);
  for (const row of rows) {
    checksum = mix(checksum, row.rank);
    checksum = mix(checksum, row.score);
    checksum = mixText(checksum, row.payload);
  }
  return checksum;
}

export function computeChecksum(nonce: number, seed: number, payload: string, rounds: number): number {
  let checksum = mix(mix(FNV_OFFSET, nonce), seed);
  for (let round = 0; round < rounds; round++) checksum = mixText(mix(checksum, round), payload);
  return checksum;
}

export function channelPayload(channel: number, version: number, nonce: number): string {
  return fixedPayload(`channel:${channel}:version:${version}:nonce:${nonce}:`);
}

export function channelChecksum(channel: number, version: number, nonce: number, payload: string): number {
  return mixText(mix(mix(mix(FNV_OFFSET, channel), version), nonce), payload);
}

export function probeChecksum(nonce: number, account: number, balance: number, version: number): number {
  return mix(mix(mix(mix(FNV_OFFSET, nonce), account), balance), version);
}

export function emitBenchEvent(event: Record<string, unknown>): void {
  console.log(`@@bench ${JSON.stringify(event)}`);
}
