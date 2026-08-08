import type { TelemetryLimits } from "../../runtime/limits.ts";
import type {
  TelemetryEventName,
  TelemetryLevel,
  TelemetryLifecycleState,
  TelemetryMetricUnit,
  TelemetryOperation,
  TelemetryOutcome,
  TelemetryResource,
  TelemetryStage,
} from "./schema.ts";

export interface TelemetryTraceContext {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly requestId?: string;
  readonly connectionId?: string;
  readonly mutationId?: string;
  readonly commitId?: string;
  readonly subscriptionId?: string;
}

export declare const PREPARED_TRACE_CONTEXT: unique symbol;

/** Package-authentic context whose identifiers were sanitized once at creation. */
export type PreparedTelemetryTraceContext = TelemetryTraceContext & {
  readonly [PREPARED_TRACE_CONTEXT]: true;
};

export interface TelemetryLink {
  readonly traceId: string;
  readonly spanId: string;
}

export interface TelemetrySpanInput {
  readonly timestampMs?: number;
  readonly context?: TelemetryTraceContext;
  readonly links?: readonly TelemetryLink[];
  readonly operation: TelemetryOperation;
  readonly stage: TelemetryStage;
  readonly outcome: TelemetryOutcome;
  readonly functionName?: string;
  /** Sanitized operation summary such as `messages.collect`; never literal SQL. */
  readonly statement?: string;
  readonly resource?: TelemetryResource;
  readonly durationMs: number;
  readonly sizeBytes?: number;
  readonly rowCount?: number;
  readonly resultCount?: number;
  readonly replayed?: boolean;
  readonly dependencyCount?: number;
  readonly postCommit?: boolean;
}

/** Package-internal span input; the context carries the runtime authenticity boundary. */
export interface PreparedTelemetrySpanInput extends Omit<
  TelemetrySpanInput,
  "context" | "links"
> {
  readonly context: PreparedTelemetryTraceContext;
}

export interface TelemetryEventInput {
  readonly timestampMs?: number;
  readonly name: TelemetryEventName;
  readonly level: TelemetryLevel;
  readonly context?: TelemetryTraceContext;
  readonly links?: readonly TelemetryLink[];
  readonly operation?: TelemetryOperation;
  readonly stage?: TelemetryStage;
  readonly outcome?: TelemetryOutcome;
  readonly functionName?: string;
  readonly resource?: TelemetryResource;
  readonly lifecycleState?: TelemetryLifecycleState;
  readonly errorClass?: string;
}

export interface TelemetryMetricLabels {
  readonly operation?: TelemetryOperation;
  readonly stage?: TelemetryStage;
  readonly functionName?: string;
  readonly outcome?: TelemetryOutcome;
  readonly resource?: TelemetryResource;
}

export interface TelemetryMetricInput {
  readonly timestampMs?: number;
  readonly name: string;
  readonly value: number;
  readonly unit: TelemetryMetricUnit;
  readonly labels?: TelemetryMetricLabels;
  /**
   * Also deliver this metric through the local sink. Metrics stay off the
   * local output by default so periodic samples cannot flood the console;
   * rare diagnostic summaries opt in to remain observable without an
   * exporter.
   */
  readonly local?: boolean;
}

export interface TelemetryRecordContext {
  readonly traceId?: string;
  readonly spanId?: string;
  readonly parentSpanId?: string;
  readonly requestId?: string;
  readonly connectionId?: string;
  readonly mutationId?: string;
  readonly commitId?: string;
  readonly subscriptionId?: string;
}

export interface TelemetrySpanRecord extends TelemetryRecordContext {
  readonly schemaVersion: 1;
  readonly kind: "span";
  readonly timestampMs: number;
  readonly links?: readonly TelemetryLink[];
  readonly operation: TelemetryOperation;
  readonly stage: TelemetryStage;
  readonly outcome: TelemetryOutcome;
  readonly function?: string;
  readonly statement?: string;
  readonly resource?: TelemetryResource;
  readonly durationMs: number;
  readonly sizeBytes?: number;
  readonly rowCount?: number;
  readonly resultCount?: number;
  readonly replayed?: boolean;
  readonly dependencyCount?: number;
  readonly postCommit?: boolean;
}

export interface TelemetryEventRecord extends TelemetryRecordContext {
  readonly schemaVersion: 1;
  readonly kind: "event";
  readonly timestampMs: number;
  readonly name: TelemetryEventName;
  readonly level: TelemetryLevel;
  readonly links?: readonly TelemetryLink[];
  readonly operation?: TelemetryOperation;
  readonly stage?: TelemetryStage;
  readonly outcome?: TelemetryOutcome;
  readonly function?: string;
  readonly resource?: TelemetryResource;
  readonly lifecycleState?: TelemetryLifecycleState;
  readonly errorClass?: string;
}

export interface TelemetryMetricRecord {
  readonly schemaVersion: 1;
  readonly kind: "metric";
  readonly timestampMs: number;
  readonly name: string;
  readonly value: number;
  readonly unit: TelemetryMetricUnit;
  readonly labels: Readonly<{
    operation?: TelemetryOperation;
    stage?: TelemetryStage;
    function?: string;
    outcome?: TelemetryOutcome;
    resource?: TelemetryResource;
    overflow?: true;
  }>;
}

export type TelemetryRecord = TelemetrySpanRecord | TelemetryEventRecord | TelemetryMetricRecord;

export interface TelemetryExporter {
  export(
    records: readonly TelemetryRecord[],
    aggregates?: TelemetryAggregateSnapshot,
  ): Promise<void> | void;
}

export interface TelemetryScheduler {
  setInterval(callback: () => void, delayMs: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

/**
 * Durable capture of every observable record, independent of the in-memory
 * retention and export decisions — the sink is what "no sampling" means. A sink
 * failure never escapes into the recording path.
 */
export interface TelemetryDurableSink {
  span?(record: TelemetrySpanRecord): void;
  event?(record: TelemetryEventRecord): void;
}

export interface TelemetryOptions {
  readonly enabled?: boolean;
  readonly limits?: Partial<TelemetryLimits>;
  readonly exporter?: TelemetryExporter;
  readonly localSink?: ((safeJsonLine: string) => void) | false;
  readonly now?: () => number;
  readonly scheduler?: TelemetryScheduler;
}

export interface TelemetryDropSnapshot {
  readonly overflow: number;
  readonly expired: number;
  readonly oversized: number;
  readonly invalid: number;
  readonly exporter: number;
  readonly cardinality: number;
  readonly drain: number;
}

export interface TelemetryLocalSinkDropSnapshot {
  readonly overflow: number;
  readonly expired: number;
  readonly failure: number;
  readonly drain: number;
}

export interface TelemetryLocalSinkSnapshot {
  readonly configured: boolean;
  readonly inFlight: boolean;
  readonly pendingRecords: number;
  readonly pendingBytes: number;
  readonly oldestAgeMs: number;
  readonly deliveredRecords: number;
  readonly failures: number;
  readonly timeouts: number;
  readonly dropped: TelemetryLocalSinkDropSnapshot;
}

export interface TelemetryExportSnapshot {
  readonly configured: boolean;
  readonly inFlight: boolean;
  readonly attempts: number;
  readonly failures: number;
  readonly timeouts: number;
  readonly exportedRecords: number;
  readonly failedRecords: number;
  readonly aggregateSnapshotPending: boolean;
  readonly exportedAggregateSnapshots: number;
  readonly failedAggregateSnapshots: number;
  readonly lastSuccessAtMs?: number;
  readonly lastFailureAtMs?: number;
  readonly lastDurationMs?: number;
}

export interface TelemetryTraceRetentionDropSnapshot {
  /** Trace lifecycles rejected because every bounded trace slot was active. */
  readonly activeOverflow: number;
  /** Sanitized spans omitted because the bounded staging buffer was full. */
  readonly stagedOverflow: number;
  /** Completed decisions evicted early to admit newer trace lifecycles. */
  readonly decisionOverflow: number;
  /** Completed decisions removed after the finite decision-retention window. */
  readonly expiredDecisions: number;
  /** Trace states released by the terminal telemetry drain. */
  readonly drain: number;
  /** Invalid or conflicting lifecycle calls. */
  readonly invalid: number;
}

export interface TelemetryTraceRetentionSnapshot {
  readonly maxTraces: number;
  readonly maxStagedRecords: number;
  readonly maxStagedBytes: number;
  readonly decisionRetentionMs: number;
  readonly activeTraces: number;
  readonly completedDecisions: number;
  readonly stagedRecords: number;
  readonly stagedBytes: number;
  readonly promotedTraces: number;
  readonly discardedTraces: number;
  readonly discardedRecords: number;
  readonly dropped: TelemetryTraceRetentionDropSnapshot;
}

export interface TelemetrySnapshot {
  readonly enabled: boolean;
  readonly queuedRecords: number;
  readonly queuedBytes: number;
  readonly oldestAgeMs: number;
  readonly metricSeries: number;
  readonly traceRetention: TelemetryTraceRetentionSnapshot;
  readonly localSink: TelemetryLocalSinkSnapshot;
  readonly dropped: TelemetryDropSnapshot;
  readonly exporter: TelemetryExportSnapshot;
}

export interface TelemetryAggregateSeries {
  readonly operation?: TelemetryOperation;
  readonly stage?: TelemetryStage;
  readonly outcome?: TelemetryOutcome;
  readonly function?: string;
  readonly resource?: TelemetryResource;
  readonly overflow?: true;
  readonly count: number;
  readonly durationMs: number;
  readonly sizeBytes?: number;
  readonly rowCount?: number;
  readonly resultCount?: number;
  readonly dependencyCount?: number;
}

export interface TelemetryAggregateSnapshot {
  readonly maxSeries: number;
  readonly overflowedRecords: number;
  readonly series: readonly TelemetryAggregateSeries[];
}
