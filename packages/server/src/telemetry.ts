import {
  PRODUCTION_LIMITS,
  validateTelemetryLimits,
  type TelemetryLimits,
} from "./limits.ts";

export const TELEMETRY_SCHEMA_VERSION = 1 as const;

export const TELEMETRY_OPERATIONS = [
  "query",
  "mutation",
  "procedure",
  "sse",
  "transaction",
  "scheduled",
  "subscription",
  "backup",
  "restore",
  "lifecycle",
] as const;
export type TelemetryOperation = (typeof TELEMETRY_OPERATIONS)[number];

export const TELEMETRY_STAGES = [
  "admission",
  "auth",
  "policy",
  "handler",
  "fetch",
  "statement",
  "storage",
  "commit",
  "rollback",
  "publication",
  "match",
  "evaluation",
  "changed",
  "unchanged",
  "encoding",
  "fanout",
  "queue",
  "delivery",
  "export",
] as const;
export type TelemetryStage = (typeof TELEMETRY_STAGES)[number];

export const TELEMETRY_OUTCOMES = [
  "ok",
  "malformed",
  "validation",
  "unsupported_protocol",
  "unauthenticated",
  "auth_unavailable",
  "auth_stale",
  "unauthorized",
  "not_found",
  "conflict",
  "overloaded",
  "slow_consumer",
  "deadline_exceeded",
  "draining",
  "unavailable",
  "convergence_unavailable",
  "indeterminate",
  "internal",
] as const;
export type TelemetryOutcome = (typeof TELEMETRY_OUTCOMES)[number];

export const TELEMETRY_RESOURCES = [
  "connection",
  "operation",
  "reader",
  "writer",
  "subscription",
  "revalidation",
  "publication",
  "outbound",
  "sse",
  "history",
  "idempotency",
  "telemetry",
] as const;
export type TelemetryResource = (typeof TELEMETRY_RESOURCES)[number];

function labelCodes<Label extends string>(labels: readonly Label[]): Readonly<Record<Label, number>> {
  const codes = Object.create(null) as Record<Label, number>;
  for (let index = 0; index < labels.length; index++) codes[labels[index]!] = index;
  return codes;
}

const AGGREGATE_OPERATION_CODES = labelCodes(TELEMETRY_OPERATIONS);
const AGGREGATE_STAGE_CODES = labelCodes(TELEMETRY_STAGES);
const AGGREGATE_OUTCOME_CODES = labelCodes(TELEMETRY_OUTCOMES);
const AGGREGATE_RESOURCE_CODES = labelCodes(TELEMETRY_RESOURCES);
const AGGREGATE_RESOURCE_CARDINALITY = TELEMETRY_RESOURCES.length + 1;

export const TELEMETRY_EVENT_NAMES = [
  "lifecycle",
  "overload",
  "exporter_degraded",
  "failure",
] as const;
export type TelemetryEventName = (typeof TELEMETRY_EVENT_NAMES)[number];
export type TelemetryLevel = "info" | "warn" | "error";
export type TelemetryLifecycleState = "starting" | "ready" | "draining" | "stopped" | "failed";
export type TelemetryMetricUnit = "count" | "milliseconds" | "bytes" | "ratio" | "gauge";

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

declare const PREPARED_TRACE_CONTEXT: unique symbol;

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
}

interface TelemetryRecordContext {
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
    function?: string;
    outcome?: TelemetryOutcome;
    resource?: TelemetryResource;
    overflow?: true;
  }>;
}

export type TelemetryRecord = TelemetrySpanRecord | TelemetryEventRecord | TelemetryMetricRecord;

export interface TelemetryExporter {
  export(records: readonly TelemetryRecord[]): Promise<void> | void;
}

export interface TelemetryScheduler {
  setInterval(callback: () => void, delayMs: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
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

interface BufferedRecord {
  readonly record: TelemetryRecord;
  readonly bytes: number;
  readonly retainedAtMs: number;
}

interface BufferedLocalLine {
  readonly line: string;
  readonly bytes: number;
  readonly retainedAtMs: number;
}

interface BufferedTraceSpan {
  readonly span: SanitizedTelemetrySpan;
  readonly bytes: number;
}

interface EncodedRecord {
  readonly line: string;
  readonly bytes: number;
}

type JsonSpanPrimitive = string | number | boolean;

interface SanitizedTelemetrySpan {
  readonly timestampMs: number;
  readonly context: TelemetryRecordContext;
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

interface MutableTraceRetention {
  readonly traceId: string;
  readonly startedAtMs: number;
  completedAtMs?: number;
  observedDurationMs: number;
  retained: boolean;
  staged: BufferedTraceSpan[];
}

interface MutableAggregate {
  readonly operation?: TelemetryOperation;
  readonly stage?: TelemetryStage;
  readonly outcome?: TelemetryOutcome;
  readonly function?: string;
  readonly resource?: TelemetryResource;
  readonly overflow?: true;
  count: number;
  durationMs: number;
  sizeBytes?: number;
  rowCount?: number;
  resultCount?: number;
  dependencyCount?: number;
}

interface TelemetryState {
  readonly limits: TelemetryLimits;
  readonly now: () => number;
  readonly scheduler: TelemetryScheduler;
  readonly exporter?: TelemetryExporter;
  readonly localSink?: (safeJsonLine: string) => void;
  readonly encoder: TextEncoder;
  readonly metricSeries: Set<string>;
  readonly aggregateSeries: Map<number, Map<string | undefined, MutableAggregate>>;
  readonly aggregateOrder: MutableAggregate[];
  readonly aggregateOverflow: MutableAggregate;
  readonly activeTraces: Map<string, MutableTraceRetention>;
  readonly completedTraces: Map<string, MutableTraceRetention>;
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
  exporting?: Promise<void>;
  localInFlight?: Promise<void>;
  draining?: Promise<void>;
  aggregateOverflowedRecords: number;
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
    lastSuccessAtMs?: number;
    lastFailureAtMs?: number;
    lastDurationMs?: number;
  };
}

const MAX_LINKS = 32;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const SAFE_ERROR_CLASS = /^[A-Za-z][A-Za-z0-9_.]{0,79}$/;
const OVERFLOW_METRIC_NAME = "telemetry.cardinality_overflow";
const OVERFLOW_SERIES = `${OVERFLOW_METRIC_NAME}|count|telemetry|overflow`;
const TASK_OK = Symbol("task-ok");
const TASK_FAILED = Symbol("task-failed");
const TASK_TIMED_OUT = Symbol("task-timed-out");
const TASK_DEADLINE = Symbol("task-deadline");
const PREPARED_TRACE_CONTEXTS = new WeakSet<TelemetryTraceContext>();

/** Package-private entry point for spans carrying an authenticated prepared context. */
export const RECORD_PREPARED_SPAN = Symbol("dbzz.recordPreparedTelemetrySpan");

const SYSTEM_SCHEDULER: TelemetryScheduler = {
  setInterval: (callback, delayMs) => setInterval(callback, delayMs),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const DISABLED_TRACE_RETENTION: TelemetryTraceRetentionSnapshot = Object.freeze({
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

const DISABLED_SNAPSHOT: TelemetrySnapshot = Object.freeze({
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
  }),
});

const DISABLED_AGGREGATES: TelemetryAggregateSnapshot = Object.freeze({
  maxSeries: 0,
  overflowedRecords: 0,
  series: Object.freeze([]),
});

function safeId(value: string | undefined): string | undefined {
  return typeof value === "string" && SAFE_ID.test(value) ? value : undefined;
}

function safeName(value: string | undefined): string | undefined {
  return typeof value === "string" && SAFE_NAME.test(value) ? value : undefined;
}

function safeCount(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Create or authenticate one package-owned context, sanitizing identifiers once. */
export function prepareTelemetryTraceContext(
  context: Partial<TelemetryTraceContext> = {},
): PreparedTelemetryTraceContext {
  if (PREPARED_TRACE_CONTEXTS.has(context as TelemetryTraceContext)) {
    return context as PreparedTelemetryTraceContext;
  }
  const sanitized = sanitizeContext({
    ...context,
    traceId: context.traceId ?? crypto.randomUUID(),
    spanId: context.spanId ?? crypto.randomUUID(),
  });
  if (sanitized.traceId === undefined || sanitized.spanId === undefined) {
    throw new TypeError("prepared telemetry contexts require safe traceId and spanId values");
  }
  const prepared = Object.freeze(sanitized) as PreparedTelemetryTraceContext;
  PREPARED_TRACE_CONTEXTS.add(prepared);
  return prepared;
}

/** Derive one authenticated child while inheriting already-sanitized operation identifiers. */
export function deriveTelemetryTraceContext(
  parent: PreparedTelemetryTraceContext,
  identifiers: Partial<Pick<
    TelemetryTraceContext,
    "requestId" | "connectionId" | "mutationId" | "commitId" | "subscriptionId"
  >> = {},
): PreparedTelemetryTraceContext {
  if (!PREPARED_TRACE_CONTEXTS.has(parent)) {
    throw new TypeError("telemetry child contexts require an authentic prepared parent");
  }
  const prepared = Object.freeze({
    traceId: parent.traceId,
    spanId: crypto.randomUUID(),
    parentSpanId: parent.spanId,
    requestId: identifiers.requestId === undefined
      ? parent.requestId
      : safeId(identifiers.requestId),
    connectionId: identifiers.connectionId === undefined
      ? parent.connectionId
      : safeId(identifiers.connectionId),
    mutationId: identifiers.mutationId === undefined
      ? parent.mutationId
      : safeId(identifiers.mutationId),
    commitId: identifiers.commitId === undefined ? parent.commitId : safeId(identifiers.commitId),
    subscriptionId: identifiers.subscriptionId === undefined
      ? parent.subscriptionId
      : safeId(identifiers.subscriptionId),
  }) as PreparedTelemetryTraceContext;
  PREPARED_TRACE_CONTEXTS.add(prepared);
  return prepared;
}

function isMember<const T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === "string" && values.includes(value);
}

function sanitizeContext(context: TelemetryTraceContext | undefined): TelemetryRecordContext {
  return {
    traceId: safeId(context?.traceId),
    spanId: safeId(context?.spanId),
    parentSpanId: safeId(context?.parentSpanId),
    requestId: safeId(context?.requestId),
    connectionId: safeId(context?.connectionId),
    mutationId: safeId(context?.mutationId),
    commitId: safeId(context?.commitId),
    subscriptionId: safeId(context?.subscriptionId),
  };
}

function sanitizeLinks(links: readonly TelemetryLink[] | undefined): readonly TelemetryLink[] | undefined {
  if (!links?.length) return undefined;
  const safe: TelemetryLink[] = [];
  for (let index = 0; index < links.length && safe.length < MAX_LINKS; index++) {
    const traceId = safeId(links[index]?.traceId);
    const spanId = safeId(links[index]?.spanId);
    if (traceId && spanId) safe.push(Object.freeze({ traceId, spanId }));
  }
  return safe.length ? Object.freeze(safe) : undefined;
}

function sanitizeSpan(
  input: TelemetrySpanInput,
  timestampMs: number,
): SanitizedTelemetrySpan {
  return {
    timestampMs,
    context: sanitizeContext(input.context),
    links: sanitizeLinks(input.links),
    operation: input.operation,
    stage: input.stage,
    outcome: input.outcome,
    function: safeName(input.functionName),
    statement: safeName(input.statement),
    resource: isMember(TELEMETRY_RESOURCES, input.resource) ? input.resource : undefined,
    durationMs: input.durationMs,
    sizeBytes: safeCount(input.sizeBytes),
    rowCount: safeCount(input.rowCount),
    resultCount: safeCount(input.resultCount),
    replayed: typeof input.replayed === "boolean" ? input.replayed : undefined,
    dependencyCount: safeCount(input.dependencyCount),
    postCommit: typeof input.postCommit === "boolean" ? input.postCommit : undefined,
  };
}

function materializeSpan(span: SanitizedTelemetrySpan): TelemetrySpanRecord {
  return Object.freeze({
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    kind: "span",
    timestampMs: span.timestampMs,
    ...span.context,
    links: span.links,
    operation: span.operation,
    stage: span.stage,
    outcome: span.outcome,
    function: span.function,
    statement: span.statement,
    resource: span.resource,
    durationMs: span.durationMs,
    sizeBytes: span.sizeBytes,
    rowCount: span.rowCount,
    resultCount: span.resultCount,
    replayed: span.replayed,
    dependencyCount: span.dependencyCount,
    postCommit: span.postCommit,
  });
}

function readTimestamp(state: TelemetryState, timestampMs: number | undefined): number | undefined {
  if (timestampMs !== undefined) return Number.isFinite(timestampMs) ? timestampMs : undefined;
  return readClock(state);
}

function readClock(state: TelemetryState): number | undefined {
  try {
    const now = state.now();
    if (!Number.isFinite(now)) return undefined;
    state.lastNowMs = now;
    return now;
  } catch {
    return undefined;
  }
}

function fallbackNow(state: TelemetryState): number {
  return state.lastNowMs ?? state.records[state.head]?.retainedAtMs ??
    state.localLines[state.localHead]?.retainedAtMs ?? 0;
}

function boundedSum(left: number, right: number): number {
  const sum = left + right;
  return Number.isFinite(sum) ? sum : Number.MAX_VALUE;
}

function boundedCount(value: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, value + 1);
}

function jsonPrimitiveBytes(value: JsonSpanPrimitive): number {
  if (typeof value === "string") return value.length + 2;
  if (typeof value === "boolean") return value ? 4 : 5;
  return String(value).length;
}

function jsonPropertyPrefixBytes(name: string, leadingComma = true): number {
  return (leadingComma ? 1 : 0) + name.length + 3;
}

function jsonPropertyBytes(
  name: string,
  value: JsonSpanPrimitive | undefined,
  leadingComma = true,
): number {
  return value === undefined
    ? 0
    : jsonPropertyPrefixBytes(name, leadingComma) + jsonPrimitiveBytes(value);
}

/** Exact JSON/UTF-8 size of the public record represented by one sanitized span. */
function stagedSpanBytes(span: SanitizedTelemetrySpan): number {
  let bytes = 2 + jsonPropertyBytes("schemaVersion", TELEMETRY_SCHEMA_VERSION, false);
  bytes += jsonPropertyBytes("kind", "span");
  bytes += jsonPropertyBytes("timestampMs", span.timestampMs);
  bytes += jsonPropertyBytes("traceId", span.context.traceId);
  bytes += jsonPropertyBytes("spanId", span.context.spanId);
  bytes += jsonPropertyBytes("parentSpanId", span.context.parentSpanId);
  bytes += jsonPropertyBytes("requestId", span.context.requestId);
  bytes += jsonPropertyBytes("connectionId", span.context.connectionId);
  bytes += jsonPropertyBytes("mutationId", span.context.mutationId);
  bytes += jsonPropertyBytes("commitId", span.context.commitId);
  bytes += jsonPropertyBytes("subscriptionId", span.context.subscriptionId);
  if (span.links !== undefined) {
    let linkBytes = 2;
    for (let index = 0; index < span.links.length; index++) {
      const link = span.links[index]!;
      linkBytes += (index === 0 ? 0 : 1) + 2;
      linkBytes += jsonPropertyBytes("traceId", link.traceId, false);
      linkBytes += jsonPropertyBytes("spanId", link.spanId);
    }
    // The property prefix is followed by the already-counted raw JSON array.
    bytes += jsonPropertyPrefixBytes("links") + linkBytes;
  }
  bytes += jsonPropertyBytes("operation", span.operation);
  bytes += jsonPropertyBytes("stage", span.stage);
  bytes += jsonPropertyBytes("outcome", span.outcome);
  bytes += jsonPropertyBytes("function", span.function);
  bytes += jsonPropertyBytes("statement", span.statement);
  bytes += jsonPropertyBytes("resource", span.resource);
  bytes += jsonPropertyBytes("durationMs", span.durationMs);
  bytes += jsonPropertyBytes("sizeBytes", span.sizeBytes);
  bytes += jsonPropertyBytes("rowCount", span.rowCount);
  bytes += jsonPropertyBytes("resultCount", span.resultCount);
  bytes += jsonPropertyBytes("replayed", span.replayed);
  bytes += jsonPropertyBytes("dependencyCount", span.dependencyCount);
  bytes += jsonPropertyBytes("postCommit", span.postCommit);
  return bytes;
}

interface AbsoluteDeadline {
  readonly reached: Promise<void>;
  readonly expired: () => boolean;
  close(): void;
}

export function captureTelemetryLink(context: Pick<TelemetryTraceContext, "traceId" | "spanId">): TelemetryLink {
  const traceId = safeId(context.traceId);
  const spanId = safeId(context.spanId);
  if (!traceId || !spanId) throw new TypeError("telemetry links require safe traceId and spanId values");
  return Object.freeze({ traceId, spanId });
}

export class Telemetry {
  readonly enabled: boolean;
  readonly sampleIntervalMs: number;
  private readonly state?: TelemetryState;

  constructor(options: TelemetryOptions = {}) {
    this.enabled = options.enabled !== false;
    if (!this.enabled) {
      this.sampleIntervalMs = 0;
      return;
    }

    const limits = validateTelemetryLimits({
      ...PRODUCTION_LIMITS.telemetry,
      ...options.limits,
    });
    this.sampleIntervalMs = limits.sampleIntervalMs;
    const scheduler = options.scheduler ?? SYSTEM_SCHEDULER;
    const state: TelemetryState = {
      limits,
      now: options.now ?? Date.now,
      scheduler,
      exporter: options.exporter,
      localSink: options.localSink === false ? undefined : options.localSink ?? console.log,
      encoder: new TextEncoder(),
      metricSeries: new Set(),
      aggregateSeries: new Map(),
      aggregateOrder: [],
      aggregateOverflow: {
        overflow: true,
        count: 0,
        durationMs: 0,
      },
      activeTraces: new Map(),
      completedTraces: new Map(),
      records: [],
      head: 0,
      queuedBytes: 0,
      stagedTraceRecords: 0,
      stagedTraceBytes: 0,
      localLines: [],
      localHead: 0,
      localBytes: 0,
      localPumpScheduled: false,
      stopped: false,
      aggregateOverflowedRecords: 0,
      traceHealth: {
        promotedTraces: 0,
        discardedTraces: 0,
        discardedRecords: 0,
        dropped: {
          activeOverflow: 0,
          stagedOverflow: 0,
          decisionOverflow: 0,
          expiredDecisions: 0,
          drain: 0,
          invalid: 0,
        },
      },
      localHealth: {
        deliveredRecords: 0,
        failures: 0,
        timeouts: 0,
        dropped: { overflow: 0, expired: 0, failure: 0, drain: 0 },
      },
      drops: {
        overflow: 0,
        expired: 0,
        oversized: 0,
        invalid: 0,
        exporter: 0,
        cardinality: 0,
        drain: 0,
      },
      exportHealth: {
        attempts: 0,
        failures: 0,
        timeouts: 0,
        exportedRecords: 0,
        failedRecords: 0,
      },
    };
    this.state = state;
    if (state.exporter) {
      try {
        state.intervalHandle = scheduler.setInterval(() => {
          if (state.stopped) return;
          try {
            void this.flush();
          } catch {
            this.observeExportFailure(state);
          }
        }, limits.batchIntervalMs);
      } catch {
        this.observeExportFailure(state);
      }
    }
  }

  /**
   * Open a bounded tail-sampling lifecycle for one operation trace. Spans with
   * this trace id remain aggregate-visible immediately while their individual
   * records await the whole-operation retention decision.
   */
  beginTrace(
    context: Pick<TelemetryTraceContext, "traceId">,
    timestampMs?: number,
  ): boolean {
    const state = this.state;
    if (!state) return false;
    const traceId = safeId(context.traceId);
    const startedAtMs = readTimestamp(state, timestampMs);
    if (!traceId || startedAtMs === undefined) {
      this.observeInvalidTraceLifecycle(state);
      return false;
    }
    if (state.limits.slowOperationMs === 0) return true;
    this.pruneCompletedTraces(state, startedAtMs);
    if (state.activeTraces.has(traceId) || state.completedTraces.has(traceId)) {
      this.observeInvalidTraceLifecycle(state);
      return false;
    }
    while (
      state.activeTraces.size + state.completedTraces.size >= state.limits.maxRecords &&
      state.completedTraces.size > 0
    ) {
      this.evictOldestCompletedTrace(state);
    }
    if (state.activeTraces.size + state.completedTraces.size >= state.limits.maxRecords) {
      state.traceHealth.dropped.activeOverflow = boundedCount(
        state.traceHealth.dropped.activeOverflow,
      );
      return false;
    }
    state.activeTraces.set(traceId, {
      traceId,
      startedAtMs,
      observedDurationMs: 0,
      retained: false,
      staged: [],
    });
    return true;
  }

  /** Finish a trace and preserve its bounded decision for delayed delivery spans. */
  finishTrace(
    context: Pick<TelemetryTraceContext, "traceId">,
    timestampMs?: number,
  ): boolean {
    const state = this.state;
    if (!state) return false;
    const traceId = safeId(context.traceId);
    if (!traceId) {
      this.observeInvalidTraceLifecycle(state);
      return false;
    }
    const completedAtMs = readTimestamp(state, timestampMs);
    if (completedAtMs === undefined) {
      this.observeInvalidTraceLifecycle(state);
      const trace = state.activeTraces.get(traceId);
      if (trace) {
        state.activeTraces.delete(traceId);
        this.discardTrace(state, trace);
      }
      return false;
    }
    if (state.limits.slowOperationMs === 0) return true;
    this.pruneCompletedTraces(state, completedAtMs);
    const trace = state.activeTraces.get(traceId);
    if (!trace) {
      if (state.completedTraces.has(traceId)) return true;
      this.observeInvalidTraceLifecycle(state);
      return false;
    }
    state.activeTraces.delete(traceId);
    if (
      !trace.retained &&
      Math.max(completedAtMs - trace.startedAtMs, trace.observedDurationMs) >=
        state.limits.slowOperationMs
    ) {
      this.promoteTrace(state, trace, completedAtMs);
    }
    trace.completedAtMs = completedAtMs;
    state.completedTraces.set(traceId, trace);
    return true;
  }

  recordSpan(input: TelemetrySpanInput): boolean {
    const state = this.state;
    if (!state) return false;
    const timestampMs = readTimestamp(state, input.timestampMs);
    if (
      timestampMs === undefined ||
      !isMember(TELEMETRY_OPERATIONS, input.operation) ||
      !isMember(TELEMETRY_STAGES, input.stage) ||
      !isMember(TELEMETRY_OUTCOMES, input.outcome) ||
      !Number.isFinite(input.durationMs) ||
      input.durationMs < 0
    ) {
      state.drops.invalid++;
      return false;
    }
    const span = sanitizeSpan(input, timestampMs);
    return this.recordSanitizedSpan(state, span);
  }

  [RECORD_PREPARED_SPAN](input: PreparedTelemetrySpanInput): boolean {
    const state = this.state;
    if (!state) return false;
    const timestampMs = readTimestamp(state, input.timestampMs);
    if (
      timestampMs === undefined ||
      !PREPARED_TRACE_CONTEXTS.has(input.context) ||
      !Number.isFinite(input.durationMs) ||
      input.durationMs < 0
    ) {
      state.drops.invalid++;
      return false;
    }
    return this.recordSanitizedSpan(state, {
      timestampMs,
      context: input.context,
      operation: input.operation,
      stage: input.stage,
      outcome: input.outcome,
      function: safeName(input.functionName),
      statement: safeName(input.statement),
      resource: input.resource,
      durationMs: input.durationMs,
      sizeBytes: safeCount(input.sizeBytes),
      rowCount: safeCount(input.rowCount),
      resultCount: safeCount(input.resultCount),
      replayed: input.replayed,
      dependencyCount: safeCount(input.dependencyCount),
      postCommit: input.postCommit,
    });
  }

  private recordSanitizedSpan(state: TelemetryState, span: SanitizedTelemetrySpan): boolean {
    this.aggregateSpan(state, span);
    const retain = span.durationMs >= state.limits.slowOperationMs || span.outcome !== "ok";
    if (state.limits.slowOperationMs === 0) return this.retain(materializeSpan(span), true);

    const traceId = span.context.traceId;
    if (traceId) {
      this.pruneCompletedTraces(state, span.timestampMs);
      const trace = state.activeTraces.get(traceId) ?? state.completedTraces.get(traceId);
      if (trace) {
        trace.observedDurationMs = boundedSum(trace.observedDurationMs, span.durationMs);
        if (trace.retained) return this.retain(materializeSpan(span), true);
        if (retain || trace.observedDurationMs >= state.limits.slowOperationMs) {
          this.promoteTrace(state, trace, span.timestampMs);
          return this.retain(materializeSpan(span), true);
        }
        this.stageTraceSpan(state, trace, span);
        return true;
      }
    }
    return retain ? this.retain(materializeSpan(span), true) : true;
  }

  recordEvent(input: TelemetryEventInput): boolean {
    const state = this.state;
    if (!state) return false;
    const timestampMs = readTimestamp(state, input.timestampMs);
    if (
      timestampMs === undefined ||
      !isMember(TELEMETRY_EVENT_NAMES, input.name) ||
      (input.level !== "info" && input.level !== "warn" && input.level !== "error")
    ) {
      state.drops.invalid++;
      return false;
    }
    const record: TelemetryEventRecord = Object.freeze({
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      kind: "event",
      timestampMs,
      name: input.name,
      level: input.level,
      ...sanitizeContext(input.context),
      links: sanitizeLinks(input.links),
      operation: isMember(TELEMETRY_OPERATIONS, input.operation) ? input.operation : undefined,
      stage: isMember(TELEMETRY_STAGES, input.stage) ? input.stage : undefined,
      outcome: isMember(TELEMETRY_OUTCOMES, input.outcome) ? input.outcome : undefined,
      function: safeName(input.functionName),
      resource: isMember(TELEMETRY_RESOURCES, input.resource) ? input.resource : undefined,
      lifecycleState:
        input.lifecycleState === "starting" ||
        input.lifecycleState === "ready" ||
        input.lifecycleState === "draining" ||
        input.lifecycleState === "stopped" ||
        input.lifecycleState === "failed"
          ? input.lifecycleState
          : undefined,
      errorClass:
        typeof input.errorClass === "string" && SAFE_ERROR_CLASS.test(input.errorClass)
          ? input.errorClass
          : undefined,
    });
    if (
      state.limits.slowOperationMs > 0 &&
      record.traceId &&
      (record.name === "failure" ||
        record.level !== "info" ||
        (record.outcome !== undefined && record.outcome !== "ok") ||
        record.lifecycleState === "failed")
    ) {
      this.pruneCompletedTraces(state, timestampMs);
      const trace = state.activeTraces.get(record.traceId) ??
        state.completedTraces.get(record.traceId);
      if (trace && !trace.retained) this.promoteTrace(state, trace, timestampMs);
    }
    return this.retain(record, true);
  }

  recordMetric(input: TelemetryMetricInput): boolean {
    const state = this.state;
    if (!state) return false;
    const timestampMs = readTimestamp(state, input.timestampMs);
    const name = safeName(input.name);
    if (
      timestampMs === undefined ||
      !name ||
      !Number.isFinite(input.value) ||
      (input.unit !== "count" &&
        input.unit !== "milliseconds" &&
        input.unit !== "bytes" &&
        input.unit !== "ratio" &&
        input.unit !== "gauge")
    ) {
      state.drops.invalid++;
      return false;
    }

    const labels = Object.freeze({
      operation: isMember(TELEMETRY_OPERATIONS, input.labels?.operation)
        ? input.labels.operation
        : undefined,
      function: safeName(input.labels?.functionName),
      outcome: isMember(TELEMETRY_OUTCOMES, input.labels?.outcome) ? input.labels.outcome : undefined,
      resource: isMember(TELEMETRY_RESOURCES, input.labels?.resource)
        ? input.labels.resource
        : undefined,
    });
    const seriesKey = `${name}|${input.unit}|${labels.operation ?? ""}|${labels.function ?? ""}|${labels.outcome ?? ""}|${labels.resource ?? ""}`;
    if (
      !state.metricSeries.has(seriesKey) &&
      (state.metricSeries.has(OVERFLOW_SERIES) ||
        state.metricSeries.size >= state.limits.maxMetricSeries - 1)
    ) {
      state.drops.cardinality++;
      const overflow: TelemetryMetricRecord = Object.freeze({
        schemaVersion: TELEMETRY_SCHEMA_VERSION,
        kind: "metric",
        timestampMs,
        name: OVERFLOW_METRIC_NAME,
        value: 1,
        unit: "count",
        labels: Object.freeze({ resource: "telemetry", overflow: true }),
      });
      const retained = this.retain(overflow, false);
      if (retained) state.metricSeries.add(OVERFLOW_SERIES);
      return retained;
    }
    const record: TelemetryMetricRecord = Object.freeze({
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      kind: "metric",
      timestampMs,
      name,
      value: input.value,
      unit: input.unit,
      labels,
    });
    const retained = this.retain(record, false);
    if (retained) state.metricSeries.add(seriesKey);
    return retained;
  }

  flush(): Promise<void> {
    const state = this.state;
    if (!state?.exporter) return Promise.resolve();
    if (state.draining) return state.draining;
    if (state.exporting) return state.exporting;
    let attempt!: Promise<void>;
    attempt = this.exportNext(state)
      .catch(() => this.observeExportFailure(state))
      .then(() => {
        if (state.exporting === attempt) state.exporting = undefined;
      });
    state.exporting = attempt;
    return attempt;
  }

  /**
   * Stop periodic work and export every record queued when this call starts.
   * The absolute deadline uses the configured telemetry clock and is shared by
   * every exporter batch and deferred local line.
   */
  drain(deadlineAtMs: number): Promise<void> {
    const state = this.state;
    if (!state) return Promise.resolve();
    if (state.draining) return state.draining;
    this.stop();
    this.discardAllTraceState(state);
    const records = this.takeRecords(state, state.records.length - state.head);
    const localLines = this.takeLocalLines(state, state.localLines.length - state.localHead);
    let draining!: Promise<void>;
    draining = this.performDrain(state, records, localLines, deadlineAtMs)
      .catch(() => undefined)
      .then(() => {
        if (state.draining === draining) state.draining = undefined;
      });
    state.draining = draining;
    return draining;
  }

  aggregateSnapshot(): TelemetryAggregateSnapshot {
    const state = this.state;
    if (!state) return DISABLED_AGGREGATES;
    const series = state.aggregateOrder.map((aggregate) => this.freezeAggregate(aggregate));
    if (state.aggregateOverflow.count > 0) {
      series.push(this.freezeAggregate(state.aggregateOverflow));
    }
    return Object.freeze({
      maxSeries: state.limits.maxMetricSeries,
      overflowedRecords: state.aggregateOverflowedRecords,
      series: Object.freeze(series),
    });
  }

  snapshot(): TelemetrySnapshot {
    const state = this.state;
    if (!state) return DISABLED_SNAPSHOT;
    const observedNow = readClock(state);
    if (observedNow === undefined) state.drops.invalid++;
    else {
      this.pruneExpired(state, observedNow);
      this.pruneLocalExpired(state, observedNow);
      this.pruneCompletedTraces(state, observedNow);
    }
    const now = observedNow ?? fallbackNow(state);
    const oldest = state.records[state.head];
    const oldestLocal = state.localLines[state.localHead];
    return Object.freeze({
      enabled: true,
      queuedRecords: state.records.length - state.head,
      queuedBytes: state.queuedBytes,
      oldestAgeMs: oldest ? Math.max(0, now - oldest.retainedAtMs) : 0,
      metricSeries: state.metricSeries.size,
      traceRetention: Object.freeze({
        maxTraces: state.limits.maxRecords,
        maxStagedRecords: state.limits.maxRecords,
        maxStagedBytes: state.limits.maxBytes,
        decisionRetentionMs: state.limits.retentionMs,
        activeTraces: state.activeTraces.size,
        completedDecisions: state.completedTraces.size,
        stagedRecords: state.stagedTraceRecords,
        stagedBytes: state.stagedTraceBytes,
        promotedTraces: state.traceHealth.promotedTraces,
        discardedTraces: state.traceHealth.discardedTraces,
        discardedRecords: state.traceHealth.discardedRecords,
        dropped: Object.freeze({ ...state.traceHealth.dropped }),
      }),
      localSink: Object.freeze({
        configured: state.localSink !== undefined,
        inFlight: state.localInFlight !== undefined,
        pendingRecords: state.localLines.length - state.localHead,
        pendingBytes: state.localBytes,
        oldestAgeMs: oldestLocal ? Math.max(0, now - oldestLocal.retainedAtMs) : 0,
        deliveredRecords: state.localHealth.deliveredRecords,
        failures: state.localHealth.failures,
        timeouts: state.localHealth.timeouts,
        dropped: Object.freeze({ ...state.localHealth.dropped }),
      }),
      dropped: Object.freeze({ ...state.drops }),
      exporter: Object.freeze({
        configured: state.exporter !== undefined,
        inFlight: state.exporting !== undefined,
        ...state.exportHealth,
      }),
    });
  }

  stop(): void {
    const state = this.state;
    if (!state) return;
    state.stopped = true;
    if (state.intervalHandle !== undefined) {
      const handle = state.intervalHandle;
      state.intervalHandle = undefined;
      try {
        state.scheduler.clearInterval(handle);
      } catch {
        this.observeExportFailure(state);
      }
    }
    if (state.localPumpScheduled) {
      const handle = state.localPumpHandle;
      state.localPumpScheduled = false;
      state.localPumpHandle = undefined;
      try {
        state.scheduler.clearTimeout(handle);
      } catch {
        state.localHealth.failures++;
      }
    }
  }

  private observeInvalidTraceLifecycle(state: TelemetryState): void {
    state.drops.invalid = boundedCount(state.drops.invalid);
    state.traceHealth.dropped.invalid = boundedCount(state.traceHealth.dropped.invalid);
  }

  private stageTraceSpan(
    state: TelemetryState,
    trace: MutableTraceRetention,
    span: SanitizedTelemetrySpan,
  ): void {
    const bytes = stagedSpanBytes(span);
    while (
      (state.stagedTraceRecords >= state.limits.maxRecords ||
        bytes > state.limits.maxBytes - state.stagedTraceBytes) &&
      this.evictOldestCompletedTrace(state, trace.traceId, true)
    ) {
      // Prefer a current active trace over an older completed tail decision.
    }
    if (
      bytes > state.limits.maxBytes ||
      state.stagedTraceRecords >= state.limits.maxRecords ||
      bytes > state.limits.maxBytes - state.stagedTraceBytes
    ) {
      state.traceHealth.dropped.stagedOverflow = boundedCount(
        state.traceHealth.dropped.stagedOverflow,
      );
      return;
    }
    trace.staged.push({ span, bytes });
    state.stagedTraceRecords++;
    state.stagedTraceBytes += bytes;
  }

  private promoteTrace(
    state: TelemetryState,
    trace: MutableTraceRetention,
    retainedAtMs: number,
  ): void {
    if (trace.retained) return;
    trace.retained = true;
    state.traceHealth.promotedTraces = boundedCount(state.traceHealth.promotedTraces);
    const staged = this.releaseTraceSpans(state, trace);
    for (const span of staged) {
      const record = materializeSpan(span.span);
      const encoded = this.encodeRecord(state, record);
      if (encoded) {
        this.retainEncoded(state, record, encoded.line, encoded.bytes, true, retainedAtMs);
      }
    }
  }

  private releaseTraceSpans(
    state: TelemetryState,
    trace: MutableTraceRetention,
  ): BufferedTraceSpan[] {
    const staged = trace.staged;
    trace.staged = [];
    state.stagedTraceRecords -= staged.length;
    for (const span of staged) state.stagedTraceBytes -= span.bytes;
    return staged;
  }

  private discardTrace(state: TelemetryState, trace: MutableTraceRetention): void {
    const discardedRecords = this.releaseTraceSpans(state, trace).length;
    if (trace.retained) return;
    state.traceHealth.discardedTraces = boundedCount(state.traceHealth.discardedTraces);
    state.traceHealth.discardedRecords = Math.min(
      Number.MAX_SAFE_INTEGER,
      state.traceHealth.discardedRecords + discardedRecords,
    );
  }

  private discardAllTraceState(state: TelemetryState): void {
    const traces = state.activeTraces.size + state.completedTraces.size;
    for (const trace of state.activeTraces.values()) this.discardTrace(state, trace);
    for (const trace of state.completedTraces.values()) this.discardTrace(state, trace);
    state.activeTraces.clear();
    state.completedTraces.clear();
    state.traceHealth.dropped.drain = Math.min(
      Number.MAX_SAFE_INTEGER,
      state.traceHealth.dropped.drain + traces,
    );
  }

  private pruneCompletedTraces(state: TelemetryState, now: number): void {
    while (state.completedTraces.size > 0) {
      const oldest = state.completedTraces.entries().next().value as
        | [string, MutableTraceRetention]
        | undefined;
      if (
        !oldest ||
        oldest[1].completedAtMs === undefined ||
        now - oldest[1].completedAtMs < state.limits.retentionMs
      ) return;
      this.removeCompletedTrace(state, oldest[0], "expiredDecisions");
    }
  }

  private evictOldestCompletedTrace(
    state: TelemetryState,
    excludedTraceId?: string,
    requireStaged = false,
  ): boolean {
    for (const [traceId, trace] of state.completedTraces) {
      if (traceId === excludedTraceId || (requireStaged && trace.staged.length === 0)) continue;
      this.removeCompletedTrace(state, traceId, "decisionOverflow");
      return true;
    }
    return false;
  }

  private removeCompletedTrace(
    state: TelemetryState,
    traceId: string,
    reason: "decisionOverflow" | "expiredDecisions",
  ): void {
    const trace = state.completedTraces.get(traceId);
    if (!trace) return;
    state.completedTraces.delete(traceId);
    state.traceHealth.dropped[reason] = boundedCount(state.traceHealth.dropped[reason]);
    this.discardTrace(state, trace);
  }

  private encodeRecord(
    state: TelemetryState,
    record: TelemetryRecord,
  ): EncodedRecord | undefined {
    try {
      const line = JSON.stringify(record);
      return { line, bytes: state.encoder.encode(line).byteLength };
    } catch {
      state.drops.invalid = boundedCount(state.drops.invalid);
      return undefined;
    }
  }

  private retain(record: TelemetryRecord, emitLocally: boolean): boolean {
    const state = this.state!;
    const now = readClock(state);
    if (now === undefined) {
      state.drops.invalid++;
      return false;
    }
    const encoded = this.encodeRecord(state, record);
    if (!encoded) return false;
    return this.retainEncoded(state, record, encoded.line, encoded.bytes, emitLocally, now);
  }

  private retainEncoded(
    state: TelemetryState,
    record: TelemetryRecord,
    line: string,
    bytes: number,
    emitLocally: boolean,
    now: number,
  ): boolean {
    if (emitLocally && state.localSink) this.enqueueLocal(state, line, bytes, now);
    if (bytes > state.limits.maxBytes) {
      state.drops.oversized++;
      return false;
    }
    this.pruneExpired(state, now);
    while (
      state.records.length - state.head >= state.limits.maxRecords ||
      bytes > state.limits.maxBytes - state.queuedBytes
    ) {
      this.removeOldest(state, "overflow");
    }
    state.records.push({ record, bytes, retainedAtMs: now });
    state.queuedBytes += bytes;
    return true;
  }

  private aggregateSpan(state: TelemetryState, span: SanitizedTelemetrySpan): void {
    const code = (((AGGREGATE_OPERATION_CODES[span.operation] * TELEMETRY_STAGES.length +
      AGGREGATE_STAGE_CODES[span.stage]) * TELEMETRY_OUTCOMES.length +
      AGGREGATE_OUTCOME_CODES[span.outcome]) * AGGREGATE_RESOURCE_CARDINALITY) +
      (span.resource === undefined ? 0 : AGGREGATE_RESOURCE_CODES[span.resource] + 1);
    let functions = state.aggregateSeries.get(code);
    let aggregate = functions?.get(span.function);
    if (!aggregate) {
      if (state.aggregateOrder.length >= state.limits.maxMetricSeries - 1) {
        aggregate = state.aggregateOverflow;
        state.aggregateOverflowedRecords = boundedCount(state.aggregateOverflowedRecords);
      } else {
        aggregate = {
          operation: span.operation,
          stage: span.stage,
          outcome: span.outcome,
          function: span.function,
          resource: span.resource,
          count: 0,
          durationMs: 0,
        };
        if (!functions) {
          functions = new Map();
          state.aggregateSeries.set(code, functions);
        }
        functions.set(span.function, aggregate);
        state.aggregateOrder.push(aggregate);
      }
    }
    aggregate.count = boundedCount(aggregate.count);
    aggregate.durationMs = boundedSum(aggregate.durationMs, span.durationMs);
    this.addAggregateValue(aggregate, "sizeBytes", span.sizeBytes);
    this.addAggregateValue(aggregate, "rowCount", span.rowCount);
    this.addAggregateValue(aggregate, "resultCount", span.resultCount);
    this.addAggregateValue(aggregate, "dependencyCount", span.dependencyCount);
  }

  private addAggregateValue(
    aggregate: MutableAggregate,
    key: "sizeBytes" | "rowCount" | "resultCount" | "dependencyCount",
    value: number | undefined,
  ): void {
    if (value === undefined) return;
    aggregate[key] = Math.min(Number.MAX_SAFE_INTEGER, (aggregate[key] ?? 0) + value);
  }

  private freezeAggregate(aggregate: MutableAggregate): TelemetryAggregateSeries {
    return Object.freeze({
      operation: aggregate.operation,
      stage: aggregate.stage,
      outcome: aggregate.outcome,
      function: aggregate.function,
      resource: aggregate.resource,
      overflow: aggregate.overflow,
      count: aggregate.count,
      durationMs: aggregate.durationMs,
      sizeBytes: aggregate.sizeBytes,
      rowCount: aggregate.rowCount,
      resultCount: aggregate.resultCount,
      dependencyCount: aggregate.dependencyCount,
    });
  }

  private enqueueLocal(
    state: TelemetryState,
    line: string,
    bytes: number,
    retainedAtMs: number,
  ): void {
    if (bytes > state.limits.maxBytes) {
      state.localHealth.dropped.overflow++;
      return;
    }
    this.pruneLocalExpired(state, retainedAtMs);
    while (
      state.localLines.length - state.localHead >= state.limits.maxRecords ||
      bytes > state.limits.maxBytes - state.localBytes
    ) {
      this.removeOldestLocal(state, "overflow");
    }
    state.localLines.push({ line, bytes, retainedAtMs });
    state.localBytes += bytes;
    this.scheduleLocal(state);
  }

  private scheduleLocal(state: TelemetryState): void {
    if (
      state.stopped ||
      state.localPumpScheduled ||
      state.localInFlight ||
      state.localLines.length === state.localHead
    ) {
      return;
    }
    state.localPumpScheduled = true;
    try {
      state.localPumpHandle = state.scheduler.setTimeout(() => {
        queueMicrotask(() => {
          state.localPumpScheduled = false;
          state.localPumpHandle = undefined;
          if (!state.stopped) this.startLocalDelivery(state);
        });
      }, 0);
    } catch {
      state.localPumpScheduled = false;
      state.localPumpHandle = undefined;
      state.localHealth.failures++;
    }
  }

  private startLocalDelivery(state: TelemetryState): void {
    if (state.stopped || state.localInFlight) return;
    const now = readClock(state);
    if (now === undefined) state.drops.invalid++;
    else this.pruneLocalExpired(state, now);
    const line = this.takeLocalLines(state, 1)[0];
    if (line === undefined) return;

    let delivery!: Promise<void>;
    delivery = this.deliverLocalLine(state, line)
      .catch(() => {
        state.localHealth.failures++;
        state.localHealth.dropped.failure++;
      })
      .then(() => {
        if (state.localInFlight === delivery) state.localInFlight = undefined;
        this.scheduleLocal(state);
      });
    state.localInFlight = delivery;
  }

  private async deliverLocalLine(state: TelemetryState, line: string): Promise<void> {
    const delivery = await this.runBoundedTask(state, () => state.localSink!(line));
    if (delivery.result === TASK_OK) {
      state.localHealth.deliveredRecords = boundedCount(state.localHealth.deliveredRecords);
      if (delivery.schedulerFailed) state.localHealth.failures++;
      return;
    }
    state.localHealth.failures++;
    state.localHealth.dropped.failure++;
    if (delivery.result === TASK_TIMED_OUT) state.localHealth.timeouts++;
  }

  private async exportNext(state: TelemetryState): Promise<void> {
    const observedStart = readClock(state);
    if (observedStart === undefined) state.drops.invalid++;
    else this.pruneExpired(state, observedStart);
    const count = Math.min(state.limits.maxBatchRecords, state.records.length - state.head);
    if (count === 0) return;
    await this.exportBatch(state, Object.freeze(this.takeRecords(state, count)), observedStart, true);
  }

  private async exportBatch(
    state: TelemetryState,
    batch: readonly TelemetryRecord[],
    observedStart: number | undefined,
    reportDegraded: boolean,
    deadline?: AbsoluteDeadline,
  ): Promise<
    typeof TASK_OK | typeof TASK_FAILED | typeof TASK_TIMED_OUT | typeof TASK_DEADLINE
  > {
    const startedAtMs = observedStart ?? fallbackNow(state);
    state.exportHealth.attempts++;
    const exported = await this.runBoundedTask(state, () => state.exporter!.export(batch), deadline);
    const observedFinish = readClock(state);
    if (observedFinish === undefined) state.drops.invalid++;
    const finishedAtMs = observedFinish ?? startedAtMs;
    state.exportHealth.lastDurationMs = Math.max(0, finishedAtMs - startedAtMs);

    if (exported.result === TASK_OK) {
      state.exportHealth.exportedRecords += batch.length;
      if (observedFinish !== undefined) state.exportHealth.lastSuccessAtMs = observedFinish;
      if (exported.schedulerFailed) {
        state.exportHealth.failures++;
        if (observedFinish !== undefined) state.exportHealth.lastFailureAtMs = observedFinish;
        if (reportDegraded && !state.stopped) this.recordExporterDegraded(finishedAtMs);
      }
      return TASK_OK;
    }

    state.exportHealth.failures++;
    state.exportHealth.failedRecords += batch.length;
    if (observedFinish !== undefined) state.exportHealth.lastFailureAtMs = observedFinish;
    if (exported.result === TASK_DEADLINE) {
      state.exportHealth.timeouts++;
      return TASK_DEADLINE;
    }
    state.drops.exporter += batch.length;
    if (exported.result === TASK_TIMED_OUT) state.exportHealth.timeouts++;
    if (reportDegraded && !state.stopped) this.recordExporterDegraded(finishedAtMs);
    return exported.result;
  }

  private async runBoundedTask(
    state: TelemetryState,
    task: () => Promise<void> | void,
    deadline?: AbsoluteDeadline,
  ): Promise<{
    readonly result:
      | typeof TASK_OK
      | typeof TASK_FAILED
      | typeof TASK_TIMED_OUT
      | typeof TASK_DEADLINE;
    readonly schedulerFailed: boolean;
  }> {
    if (deadline?.expired()) return { result: TASK_DEADLINE, schedulerFailed: false };
    let taskResult: Promise<typeof TASK_OK | typeof TASK_FAILED>;
    try {
      taskResult = Promise.resolve(task()).then(
        () => TASK_OK,
        () => TASK_FAILED,
      );
    } catch {
      taskResult = Promise.resolve(TASK_FAILED);
    }

    let timeoutHandle: unknown;
    let timeoutScheduled = false;
    let schedulerFailed = false;
    const timeout = new Promise<typeof TASK_TIMED_OUT | typeof TASK_FAILED>((resolve) => {
      try {
        timeoutHandle = state.scheduler.setTimeout(
          () => resolve(TASK_TIMED_OUT),
          state.limits.exportTimeoutMs,
        );
        timeoutScheduled = true;
      } catch {
        schedulerFailed = true;
        resolve(TASK_FAILED);
      }
    });
    const result = deadline
      ? await Promise.race([
          taskResult,
          timeout,
          deadline.reached.then((): typeof TASK_DEADLINE => TASK_DEADLINE),
        ])
      : await Promise.race([taskResult, timeout]);
    if (timeoutScheduled) {
      try {
        state.scheduler.clearTimeout(timeoutHandle);
      } catch {
        schedulerFailed = true;
      }
    }
    return { result, schedulerFailed };
  }

  private async performDrain(
    state: TelemetryState,
    records: readonly TelemetryRecord[],
    localLines: readonly string[],
    deadlineAtMs: number,
  ): Promise<void> {
    const deadline = this.createDeadline(state, deadlineAtMs);
    try {
      await Promise.all([
        this.drainRecords(state, records, deadline),
        this.drainLocalLines(state, localLines, deadline),
      ]);
    } finally {
      deadline.close();
    }
  }

  private async drainRecords(
    state: TelemetryState,
    records: readonly TelemetryRecord[],
    deadline: AbsoluteDeadline,
  ): Promise<void> {
    let offset = 0;
    try {
      if (!state.exporter) {
        state.drops.drain += records.length;
        return;
      }
      if (state.exporting && !(await this.waitWithinDeadline(state.exporting, deadline))) {
        state.drops.drain += records.length;
        return;
      }
      while (offset < records.length) {
        if (deadline.expired()) {
          state.drops.drain += records.length - offset;
          return;
        }
        const batch = Object.freeze(
          records.slice(offset, offset + state.limits.maxBatchRecords),
        );
        const observedStart = readClock(state);
        if (observedStart === undefined) state.drops.invalid++;
        const result = await this.exportBatch(state, batch, observedStart, false, deadline);
        if (result === TASK_DEADLINE) {
          state.drops.drain += records.length - offset;
          return;
        }
        offset += batch.length;
        // The timed-out exporter call is still outside our control. Starting
        // another batch would accumulate concurrent hung promises during
        // shutdown, so drop the untouched remainder under the drain counter.
        if (result === TASK_TIMED_OUT) {
          state.drops.drain += records.length - offset;
          return;
        }
      }
    } catch {
      state.drops.drain += records.length - offset;
      this.observeExportFailure(state);
    }
  }

  private async drainLocalLines(
    state: TelemetryState,
    lines: readonly string[],
    deadline: AbsoluteDeadline,
  ): Promise<void> {
    let offset = 0;
    try {
      if (!state.localSink) {
        state.localHealth.dropped.drain += lines.length;
        return;
      }
      if (state.localInFlight && !(await this.waitWithinDeadline(state.localInFlight, deadline))) {
        state.localHealth.dropped.drain += lines.length;
        return;
      }
      while (offset < lines.length) {
        if (deadline.expired()) {
          state.localHealth.dropped.drain += lines.length - offset;
          return;
        }
        const delivery = await this.runBoundedTask(state, () => state.localSink!(lines[offset]!), deadline);
        if (delivery.result === TASK_DEADLINE) {
          state.localHealth.failures++;
          state.localHealth.timeouts++;
          state.localHealth.dropped.drain += lines.length - offset;
          return;
        }
        if (delivery.result === TASK_OK) {
          state.localHealth.deliveredRecords = boundedCount(state.localHealth.deliveredRecords);
          if (delivery.schedulerFailed) state.localHealth.failures++;
        } else {
          state.localHealth.failures++;
          state.localHealth.dropped.failure++;
          if (delivery.result === TASK_TIMED_OUT) state.localHealth.timeouts++;
        }
        offset++;
        // As with exporters, a timed-out sink may still be running. Never
        // multiply that stalled work while trying to finish shutdown.
        if (delivery.result === TASK_TIMED_OUT) {
          state.localHealth.dropped.drain += lines.length - offset;
          return;
        }
      }
    } catch {
      state.localHealth.failures++;
      state.localHealth.dropped.drain += lines.length - offset;
    }
  }

  private async waitWithinDeadline(
    task: Promise<void>,
    deadline: AbsoluteDeadline,
  ): Promise<boolean> {
    if (deadline.expired()) return false;
    return Promise.race([
      task.then(
        () => true,
        () => true,
      ),
      deadline.reached.then(() => false),
    ]);
  }

  private createDeadline(state: TelemetryState, deadlineAtMs: number): AbsoluteDeadline {
    let deadlineReached = false;
    let timeoutHandle: unknown;
    let timeoutScheduled = false;
    let resolveReached!: () => void;
    const reached = new Promise<void>((resolve) => {
      resolveReached = resolve;
    });
    const expire = (): void => {
      if (deadlineReached) return;
      deadlineReached = true;
      resolveReached();
    };
    const initialNow = readClock(state);
    if (!Number.isFinite(deadlineAtMs) || initialNow === undefined) {
      state.drops.invalid++;
      expire();
    } else if (deadlineAtMs <= initialNow) {
      expire();
    } else {
      try {
        timeoutHandle = state.scheduler.setTimeout(expire, deadlineAtMs - initialNow);
        timeoutScheduled = true;
      } catch {
        expire();
      }
    }

    return {
      reached,
      expired: () => {
        if (deadlineReached) return true;
        const currentNow = readClock(state);
        if (currentNow === undefined) {
          state.drops.invalid++;
          expire();
        } else if (currentNow >= deadlineAtMs) {
          expire();
        }
        return deadlineReached;
      },
      close: () => {
        if (!timeoutScheduled) return;
        timeoutScheduled = false;
        try {
          state.scheduler.clearTimeout(timeoutHandle);
        } catch {
          // Cleanup faults must not turn shutdown into a rejection.
        }
      },
    };
  }

  private recordExporterDegraded(timestampMs: number): void {
    this.recordEvent({
      timestampMs,
      name: "exporter_degraded",
      level: "error",
      operation: "lifecycle",
      stage: "export",
      outcome: "unavailable",
      resource: "telemetry",
    });
  }

  private observeExportFailure(state: TelemetryState): void {
    state.exportHealth.failures++;
    const now = readClock(state);
    if (now === undefined) state.drops.invalid++;
    else state.exportHealth.lastFailureAtMs = now;
  }

  private pruneExpired(state: TelemetryState, now: number): void {
    while (
      state.records[state.head] &&
      now - state.records[state.head]!.retainedAtMs >= state.limits.retentionMs
    ) {
      this.removeOldest(state, "expired");
    }
  }

  private removeOldest(state: TelemetryState, reason: "overflow" | "expired"): void {
    const oldest = state.records[state.head];
    if (!oldest) return;
    state.records[state.head] = undefined;
    state.head++;
    state.queuedBytes -= oldest.bytes;
    state.drops[reason]++;
    this.compact(state);
  }

  private compact(state: TelemetryState): void {
    if (state.head === state.records.length) {
      state.records = [];
      state.head = 0;
    } else if (state.head >= state.limits.maxRecords && state.head * 2 >= state.records.length) {
      state.records = state.records.slice(state.head);
      state.head = 0;
    }
  }

  private takeRecords(state: TelemetryState, requested: number): TelemetryRecord[] {
    const count = Math.min(Math.max(0, requested), state.records.length - state.head);
    const records: TelemetryRecord[] = [];
    for (let index = 0; index < count; index++) {
      const buffered = state.records[state.head + index]!;
      records.push(buffered.record);
      state.queuedBytes -= buffered.bytes;
      state.records[state.head + index] = undefined;
    }
    state.head += count;
    this.compact(state);
    return records;
  }

  private pruneLocalExpired(state: TelemetryState, now: number): void {
    while (
      state.localLines[state.localHead] &&
      now - state.localLines[state.localHead]!.retainedAtMs >= state.limits.retentionMs
    ) {
      this.removeOldestLocal(state, "expired");
    }
  }

  private removeOldestLocal(
    state: TelemetryState,
    reason: "overflow" | "expired",
  ): void {
    const oldest = state.localLines[state.localHead];
    if (!oldest) return;
    state.localLines[state.localHead] = undefined;
    state.localHead++;
    state.localBytes -= oldest.bytes;
    state.localHealth.dropped[reason]++;
    this.compactLocal(state);
  }

  private takeLocalLines(state: TelemetryState, requested: number): string[] {
    const count = Math.min(Math.max(0, requested), state.localLines.length - state.localHead);
    const lines: string[] = [];
    for (let index = 0; index < count; index++) {
      const buffered = state.localLines[state.localHead + index]!;
      lines.push(buffered.line);
      state.localBytes -= buffered.bytes;
      state.localLines[state.localHead + index] = undefined;
    }
    state.localHead += count;
    this.compactLocal(state);
    return lines;
  }

  private compactLocal(state: TelemetryState): void {
    if (state.localHead === state.localLines.length) {
      state.localLines = [];
      state.localHead = 0;
    } else if (
      state.localHead >= state.limits.maxRecords &&
      state.localHead * 2 >= state.localLines.length
    ) {
      state.localLines = state.localLines.slice(state.localHead);
      state.localHead = 0;
    }
  }
}
