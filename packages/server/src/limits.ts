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

export interface TelemetryLimits {
  readonly maxRecords: number;
  readonly maxBytes: number;
  readonly maxMetricSeries: number;
  readonly maxBatchRecords: number;
  readonly batchIntervalMs: number;
  readonly exportTimeoutMs: number;
  readonly retentionMs: number;
  readonly slowOperationMs: number;
  readonly sampleIntervalMs: number;
}

export interface ServiceLimits {
  readonly maxConnections: number;
  readonly maxOperations: number;
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
  readonly schedulerBatchSize: number;
  readonly publication: CapacityLimits;
  readonly clientPending: QueueLimits;
  readonly mutationReplay: {
    readonly maxAgeMs: number;
    readonly maxResultBytes: number;
    readonly maxRecords: number;
    readonly maxBytes: number;
  };
  readonly auth: {
    readonly maxTokenBytes: number;
    readonly maxJwksBytes: number;
    readonly revocationDeadlineMs: number;
  };
  readonly telemetry: TelemetryLimits;
  readonly recoveryBusyMs: number;
  readonly gracefulShutdownMs: number;
}

function positiveInteger(value: number, path: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${path} must be a positive safe integer`);
  }
}

export function validateCapacityLimits(limits: CapacityLimits, path = "capacity"): CapacityLimits {
  positiveInteger(limits.maxItems, `${path}.maxItems`);
  positiveInteger(limits.maxBytes, `${path}.maxBytes`);
  return Object.freeze({ maxItems: limits.maxItems, maxBytes: limits.maxBytes });
}

export function validateQueueLimits(limits: QueueLimits, path = "queue"): QueueLimits {
  const capacity = validateCapacityLimits(limits, path);
  positiveInteger(limits.maxAgeMs, `${path}.maxAgeMs`);
  return Object.freeze({ ...capacity, maxAgeMs: limits.maxAgeMs });
}

export function validateTelemetryLimits(limits: TelemetryLimits): TelemetryLimits {
  for (const [path, value] of Object.entries(limits)) {
    positiveInteger(value, `telemetry.${path}`);
  }
  if (limits.maxBatchRecords > limits.maxRecords) {
    throw new RangeError("telemetry.maxBatchRecords cannot exceed telemetry.maxRecords");
  }
  return Object.freeze({ ...limits });
}

export function defineServiceLimits(limits: ServiceLimits): ServiceLimits {
  const readQueue = validateQueueLimits(limits.readQueue, "readQueue");
  const writeQueue = validateQueueLimits(limits.writeQueue, "writeQueue");
  const revalidationQueue = validateQueueLimits(limits.revalidationQueue, "revalidationQueue");
  const publication = validateCapacityLimits(limits.publication, "publication");
  const clientPending = validateQueueLimits(limits.clientPending, "clientPending");
  const telemetry = validateTelemetryLimits(limits.telemetry);

  const scalarLimits: ReadonlyArray<readonly [string, number]> = [
    ["maxConnections", limits.maxConnections],
    ["maxOperations", limits.maxOperations],
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
    ["schedulerBatchSize", limits.schedulerBatchSize],
    ["mutationReplay.maxAgeMs", limits.mutationReplay.maxAgeMs],
    ["mutationReplay.maxResultBytes", limits.mutationReplay.maxResultBytes],
    ["mutationReplay.maxRecords", limits.mutationReplay.maxRecords],
    ["mutationReplay.maxBytes", limits.mutationReplay.maxBytes],
    ["auth.maxTokenBytes", limits.auth.maxTokenBytes],
    ["auth.maxJwksBytes", limits.auth.maxJwksBytes],
    ["auth.revocationDeadlineMs", limits.auth.revocationDeadlineMs],
    ["recoveryBusyMs", limits.recoveryBusyMs],
    ["gracefulShutdownMs", limits.gracefulShutdownMs],
  ];
  for (const [path, value] of scalarLimits) positiveInteger(value, path);

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

  return Object.freeze({
    ...limits,
    readQueue,
    writeQueue,
    revalidationQueue,
    publication,
    clientPending,
    telemetry,
    webSocket: Object.freeze({ ...limits.webSocket }),
    sse: Object.freeze({ ...limits.sse }),
    resume: Object.freeze({ ...limits.resume }),
    mutationReplay: Object.freeze({ ...limits.mutationReplay }),
    auth: Object.freeze({ ...limits.auth }),
  });
}

export const PRODUCTION_LIMITS = defineServiceLimits({
  maxConnections: 4_096,
  maxOperations: 4_096,
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
  schedulerBatchSize: 100,
  publication: { maxItems: 4_096, maxBytes: 32 * MiB },
  clientPending: { maxItems: 4_096, maxBytes: 16 * MiB, maxAgeMs: 30_000 },
  mutationReplay: {
    maxAgeMs: 24 * 60 * 60 * 1_000,
    maxResultBytes: MiB,
    maxRecords: 1_000_000,
    maxBytes: 4 * GiB,
  },
  auth: { maxTokenBytes: 16 * KiB, maxJwksBytes: MiB, revocationDeadlineMs: 5_000 },
  telemetry: {
    maxRecords: 2_048,
    maxBytes: 4 * MiB,
    maxMetricSeries: 2_000,
    maxBatchRecords: 512,
    batchIntervalMs: 1_000,
    exportTimeoutMs: 5_000,
    retentionMs: 5 * 60 * 1_000,
    slowOperationMs: 100,
    sampleIntervalMs: 1_000,
  },
  recoveryBusyMs: 5_000,
  gracefulShutdownMs: 10_000,
});
