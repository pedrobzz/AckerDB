import { MAX_TIMER_DELAY_MS, positiveSafeInteger } from "../shared/numbers.ts";

const KiB = 1024;
const MiB = 1024 * KiB;
const GiB = 1024 * MiB;

export interface CapacityLimits {
  readonly maxItems: number;
  readonly maxBytes: number;
}

export interface QueueLimits extends CapacityLimits {
  readonly maxAgeMs: number;
}

export interface ServiceLimits {
  readonly maxConnections: number;
  readonly maxOperations: number;
  /** One HTTP source or authenticated caller cannot consume the global operation pool. */
  readonly maxOperationsPerCaller: number;
  readonly maxOperationsPerConnection: number;
  readonly readQueue: QueueLimits;
  readonly writeQueue: QueueLimits;
  readonly maxSubscriptionsPerConnection: number;
  readonly maxSubscriptions: number;
  readonly maxSharedSubscriptions: number;
  readonly maxSharedResultBytes: number;
  readonly revalidationConcurrency: number;
  readonly revalidationQueue: QueueLimits;
  readonly webSocket: {
    readonly maxBytesPerConnection: number;
    readonly maxBytes: number;
    readonly maxStallMs: number;
  };
  readonly sse: {
    readonly maxBytesPerStream: number;
    readonly maxBytes: number;
    readonly maxStallMs: number;
  };
  readonly maxRequestBytes: number;
  readonly maxFrameBytes: number;
  readonly resume: {
    readonly maxTransitionsPerStream: number;
    readonly maxBytesPerStream: number;
    readonly maxAgeMs: number;
    readonly maxBytes: number;
  };
  readonly jobs: {
    /** Max simultaneously running job handlers across every definition. */
    readonly maxRunning: number;
    /** Max rows claimed by one runner wake. */
    readonly claimBatchSize: number;
    /** How long one claimed attempt owns its row before recovery re-runs it. */
    readonly leaseMs: number;
  };
  readonly publication: CapacityLimits;
  readonly mutationReplay: {
    readonly maxAgeMs: number;
    readonly maxResultBytes: number;
    readonly maxRecords: number;
    readonly maxBytes: number;
  };
  readonly auth: {
    readonly revocationDeadlineMs: number;
  };
  readonly credentials: {
    /** Credentials one Identity may hold as children, and root ones as a set. */
    readonly maxPerIdentity: number;
    readonly maxNameBytes: number;
    readonly maxMetadataBytes: number;
  };
  readonly gracefulShutdownMs: number;
}

export function validateCapacityLimits(limits: CapacityLimits, path = "capacity"): CapacityLimits {
  positiveSafeInteger(limits.maxItems, `${path}.maxItems`);
  positiveSafeInteger(limits.maxBytes, `${path}.maxBytes`);
  return Object.freeze({ maxItems: limits.maxItems, maxBytes: limits.maxBytes });
}

export function validateQueueLimits(limits: QueueLimits, path = "queue"): QueueLimits {
  const capacity = validateCapacityLimits(limits, path);
  positiveSafeInteger(limits.maxAgeMs, `${path}.maxAgeMs`);
  return Object.freeze({ ...capacity, maxAgeMs: limits.maxAgeMs });
}

export function defineServiceLimits(limits: ServiceLimits): ServiceLimits {
  const readQueue = validateQueueLimits(limits.readQueue, "readQueue");
  const writeQueue = validateQueueLimits(limits.writeQueue, "writeQueue");
  const revalidationQueue = validateQueueLimits(limits.revalidationQueue, "revalidationQueue");
  const publication = validateCapacityLimits(limits.publication, "publication");

  const scalarLimits: ReadonlyArray<readonly [string, number]> = [
    ["maxConnections", limits.maxConnections],
    ["maxOperations", limits.maxOperations],
    ["maxOperationsPerCaller", limits.maxOperationsPerCaller],
    ["maxOperationsPerConnection", limits.maxOperationsPerConnection],
    ["maxSubscriptionsPerConnection", limits.maxSubscriptionsPerConnection],
    ["maxSubscriptions", limits.maxSubscriptions],
    ["maxSharedSubscriptions", limits.maxSharedSubscriptions],
    ["maxSharedResultBytes", limits.maxSharedResultBytes],
    ["revalidationConcurrency", limits.revalidationConcurrency],
    ["webSocket.maxBytesPerConnection", limits.webSocket.maxBytesPerConnection],
    ["webSocket.maxBytes", limits.webSocket.maxBytes],
    ["webSocket.maxStallMs", limits.webSocket.maxStallMs],
    ["sse.maxBytesPerStream", limits.sse.maxBytesPerStream],
    ["sse.maxBytes", limits.sse.maxBytes],
    ["sse.maxStallMs", limits.sse.maxStallMs],
    ["maxRequestBytes", limits.maxRequestBytes],
    ["maxFrameBytes", limits.maxFrameBytes],
    ["resume.maxTransitionsPerStream", limits.resume.maxTransitionsPerStream],
    ["resume.maxBytesPerStream", limits.resume.maxBytesPerStream],
    ["resume.maxAgeMs", limits.resume.maxAgeMs],
    ["resume.maxBytes", limits.resume.maxBytes],
    ["jobs.maxRunning", limits.jobs.maxRunning],
    ["jobs.claimBatchSize", limits.jobs.claimBatchSize],
    ["jobs.leaseMs", limits.jobs.leaseMs],
    ["mutationReplay.maxAgeMs", limits.mutationReplay.maxAgeMs],
    ["mutationReplay.maxResultBytes", limits.mutationReplay.maxResultBytes],
    ["mutationReplay.maxRecords", limits.mutationReplay.maxRecords],
    ["mutationReplay.maxBytes", limits.mutationReplay.maxBytes],
    ["auth.revocationDeadlineMs", limits.auth.revocationDeadlineMs],
    ["credentials.maxPerIdentity", limits.credentials.maxPerIdentity],
    ["credentials.maxNameBytes", limits.credentials.maxNameBytes],
    ["credentials.maxMetadataBytes", limits.credentials.maxMetadataBytes],
    ["gracefulShutdownMs", limits.gracefulShutdownMs],
  ];
  for (const [path, value] of scalarLimits) positiveSafeInteger(value, path);

  if (limits.maxOperationsPerCaller > limits.maxOperations) {
    throw new RangeError("maxOperationsPerCaller cannot exceed maxOperations");
  }
  if (limits.maxOperationsPerConnection > limits.maxOperations) {
    throw new RangeError("maxOperationsPerConnection cannot exceed maxOperations");
  }
  if (limits.maxSubscriptionsPerConnection > limits.maxSubscriptions) {
    throw new RangeError("maxSubscriptionsPerConnection cannot exceed maxSubscriptions");
  }
  if (limits.webSocket.maxBytesPerConnection > limits.webSocket.maxBytes) {
    throw new RangeError("webSocket.maxBytesPerConnection cannot exceed webSocket.maxBytes");
  }
  if (limits.maxFrameBytes >= limits.webSocket.maxBytesPerConnection) {
    throw new RangeError("maxFrameBytes must be smaller than webSocket.maxBytesPerConnection");
  }
  if (limits.sse.maxBytesPerStream > limits.sse.maxBytes) {
    throw new RangeError("sse.maxBytesPerStream cannot exceed sse.maxBytes");
  }
  if (limits.maxFrameBytes > limits.sse.maxBytesPerStream) {
    throw new RangeError("maxFrameBytes cannot exceed sse.maxBytesPerStream");
  }
  if (limits.resume.maxBytesPerStream > limits.resume.maxBytes) {
    throw new RangeError("resume.maxBytesPerStream cannot exceed resume.maxBytes");
  }
  if (limits.gracefulShutdownMs > MAX_TIMER_DELAY_MS) {
    throw new RangeError("gracefulShutdownMs cannot exceed the platform timer limit");
  }

  return Object.freeze({
    ...limits,
    readQueue,
    writeQueue,
    revalidationQueue,
    publication,
    webSocket: Object.freeze({ ...limits.webSocket }),
    sse: Object.freeze({ ...limits.sse }),
    resume: Object.freeze({ ...limits.resume }),
    mutationReplay: Object.freeze({ ...limits.mutationReplay }),
    auth: Object.freeze({ ...limits.auth }),
    credentials: Object.freeze({ ...limits.credentials }),
    jobs: Object.freeze({ ...limits.jobs }),
  });
}

export const PRODUCTION_LIMITS = defineServiceLimits({
  maxConnections: 4_096,
  maxOperations: 4_096,
  maxOperationsPerCaller: 128,
  maxOperationsPerConnection: 128,
  readQueue: { maxItems: 4_096, maxBytes: 32 * MiB, maxAgeMs: 30_000 },
  writeQueue: { maxItems: 4_096, maxBytes: 32 * MiB, maxAgeMs: 30_000 },
  maxSubscriptionsPerConnection: 1_024,
  maxSubscriptions: 100_000,
  maxSharedSubscriptions: 100_000,
  maxSharedResultBytes: 128 * MiB,
  revalidationConcurrency: 4,
  revalidationQueue: { maxItems: 100_000, maxBytes: 32 * MiB, maxAgeMs: 30_000 },
  webSocket: { maxBytesPerConnection: 4 * MiB, maxBytes: 64 * MiB, maxStallMs: 5_000 },
  sse: { maxBytesPerStream: MiB, maxBytes: 32 * MiB, maxStallMs: 5_000 },
  maxRequestBytes: MiB,
  maxFrameBytes: MiB,
  resume: {
    maxTransitionsPerStream: 64,
    maxBytesPerStream: 2 * MiB,
    maxAgeMs: 30_000,
    maxBytes: 128 * MiB,
  },
  jobs: { maxRunning: 64, claimBatchSize: 100, leaseMs: 60_000 },
  publication: { maxItems: 4_096, maxBytes: 32 * MiB },
  mutationReplay: {
    maxAgeMs: 24 * 60 * 60 * 1_000,
    maxResultBytes: MiB,
    maxRecords: 1_000_000,
    maxBytes: 4 * GiB,
  },
  auth: { revocationDeadlineMs: 5_000 },
  credentials: {
    maxPerIdentity: 64,
    maxNameBytes: 128,
    maxMetadataBytes: 16 * KiB,
  },
  gracefulShutdownMs: 10_000,
});
