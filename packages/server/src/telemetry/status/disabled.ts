import type { TelemetryAggregateSnapshot, TelemetrySnapshot, TelemetryTraceRetentionSnapshot } from "../contracts/types.ts";

export const DISABLED_TRACE_RETENTION: TelemetryTraceRetentionSnapshot = Object.freeze({
  maxTraces: 0,
  maxStagedRecords: 0,
  maxStagedBytes: 0,
  decisionRetentionMs: 0,
  activeTraces: 0,
  completedDecisions: 0,
  stagedRecords: 0,
  stagedBytes: 0,
  promotedTraces: 0,
  discardedTraces: 0,
  discardedRecords: 0,
  dropped: Object.freeze({
    activeOverflow: 0,
    stagedOverflow: 0,
    decisionOverflow: 0,
    expiredDecisions: 0,
    drain: 0,
    invalid: 0,
  }),
});

export const DISABLED_SNAPSHOT: TelemetrySnapshot = Object.freeze({
  enabled: false,
  queuedRecords: 0,
  queuedBytes: 0,
  oldestAgeMs: 0,
  metricSeries: 0,
  traceRetention: DISABLED_TRACE_RETENTION,
  localSink: Object.freeze({
    configured: false,
    inFlight: false,
    pendingRecords: 0,
    pendingBytes: 0,
    oldestAgeMs: 0,
    deliveredRecords: 0,
    failures: 0,
    timeouts: 0,
    dropped: Object.freeze({ overflow: 0, expired: 0, failure: 0, drain: 0 }),
  }),
  dropped: Object.freeze({
    overflow: 0,
    expired: 0,
    oversized: 0,
    invalid: 0,
    exporter: 0,
    cardinality: 0,
    drain: 0,
  }),
  exporter: Object.freeze({
    configured: false,
    inFlight: false,
    attempts: 0,
    failures: 0,
    timeouts: 0,
    exportedRecords: 0,
    failedRecords: 0,
    aggregateSnapshotPending: false,
    exportedAggregateSnapshots: 0,
    failedAggregateSnapshots: 0,
  }),
});

export const DISABLED_AGGREGATES: TelemetryAggregateSnapshot = Object.freeze({
  maxSeries: 0,
  overflowedRecords: 0,
  series: Object.freeze([]),
});
