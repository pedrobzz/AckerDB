import type { TelemetryLimits } from "../../runtime/limits.ts";
import type { TraceJournal } from "../journal.ts";
import type { TelemetryAggregation } from "../aggregation/series.ts";
import type { TelemetryAggregateBuckets } from "../aggregation/buckets.ts";
import type { ExemplarVerdict } from "../policy.ts";
import type { TelemetrySpanRecord } from "../contracts/types.ts";
import type {
  TelemetryExporter,
  TelemetryScheduler,
} from "../contracts/types.ts";
import type {
  BufferedLocalLine,
  BufferedRecord,
  SanitizedTelemetrySpan,
} from "../records/types.ts";
import type { AuthenticTelemetryTraceContext } from "../tracing/context.ts";
import type { OperationTrace } from "../tracing/operation-trace.ts";
import type {
  TelemetryOperation,
  TelemetryOutcome,
  TelemetryResource,
  TelemetryStage,
} from "../contracts/schema.ts";

export interface MutableTraceRetention {
  traceId?: string;
  startedAtMs: number;
  /** Latest span end seen; with `startedAtMs` this is the trace's duration. */
  endedAtMs: number;
  /** Spans this trace saw, including any the staging bounds refused. */
  observedSpans: number;
  /** Spans the bounds refused, so the exemplar can disclose what it omits. */
  omittedSpans: number;
  errorSpans: number;
  /** The root span's identity, for the cohort a slow verdict is measured in. */
  rootFunction?: string;
  rootOperation?: TelemetryOperation;
  /** Set once, when the trace completes and the policy has judged it. */
  verdict?: ExemplarVerdict;
  /**
   * Materialized spans an exemplar will carry. References to the same records
   * the export pipeline already holds, not copies, and allocated only for the
   * retained minority — the alternative, a second component staging every
   * trace's spans in parallel, is what this replaced.
   */
  exemplarSpans?: TelemetrySpanRecord[];
  owner?: TelemetryState;
  rootContext?: AuthenticTelemetryTraceContext;
  operationTrace?: OperationTrace;
  phase: "active" | "completed" | "settled";
  previous?: MutableTraceRetention;
  next?: MutableTraceRetention;
  completedAtMs?: number;
  pendingDeliveries?: number;
  retained: boolean;
  stagedHead: number;
  stagedTail: number;
  stagedRecords: number;
  stagedBytes: number;
}

export interface MutableTraceList {
  head?: MutableTraceRetention;
  tail?: MutableTraceRetention;
  size: number;
}

export interface TelemetryState {
  readonly limits: TelemetryLimits;
  readonly now: () => number;
  readonly scheduler: TelemetryScheduler;
  readonly exporter?: TelemetryExporter;
  readonly localSink?: (safeJsonLine: string) => void;
  readonly metricSeries: Set<string>;
  readonly aggregation: TelemetryAggregation;
  /**
   * The time-bucketed distribution every valid observation reaches, before any
   * retention decision. Counts and totals here are exact for covered buckets;
   * the trace store beside it keeps a tail-sampled minority.
   */
  readonly aggregateBuckets: TelemetryAggregateBuckets;
  publicTraceIndex: Map<string, MutableTraceRetention>;
  publicTraceDeletions: number;
  readonly activeTraces: MutableTraceList;
  readonly completedTraces: MutableTraceList;
  readonly traceJournal: TraceJournal<SanitizedTelemetrySpan>;
  completedTracesWithStaging: number;
  records: Array<BufferedRecord | undefined>;
  head: number;
  queuedBytes: number;
  stagedTraceRecords: number;
  stagedTraceBytes: number;
  localLines: Array<BufferedLocalLine | undefined>;
  localHead: number;
  localBytes: number;
  stopped: boolean;
  lastNowMs?: number;
  intervalHandle?: unknown;
  localPumpHandle?: unknown;
  localPumpScheduled: boolean;
  exportPumpScheduled: boolean;
  exportPumpSuspended: boolean;
  exporting?: Promise<void>;
  localInFlight?: Promise<void>;
  draining?: Promise<void>;
  traceHealth: {
    promotedTraces: number;
    discardedTraces: number;
    discardedRecords: number;
    dropped: {
      activeOverflow: number;
      stagedOverflow: number;
      decisionOverflow: number;
      expiredDecisions: number;
      drain: number;
      invalid: number;
    };
  };
  localHealth: {
    deliveredRecords: number;
    failures: number;
    timeouts: number;
    dropped: {
      overflow: number;
      expired: number;
      failure: number;
      drain: number;
    };
  };
  drops: {
    overflow: number;
    expired: number;
    oversized: number;
    invalid: number;
    exporter: number;
    cardinality: number;
    drain: number;
  };
  exportHealth: {
    attempts: number;
    failures: number;
    timeouts: number;
    exportedRecords: number;
    failedRecords: number;
    exportedAggregateSnapshots: number;
    failedAggregateSnapshots: number;
    lastSuccessAtMs?: number;
    lastFailureAtMs?: number;
    lastDurationMs?: number;
  };
}
