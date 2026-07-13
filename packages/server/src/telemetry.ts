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

export interface TelemetrySnapshot {
  readonly enabled: boolean;
  readonly queuedRecords: number;
  readonly queuedBytes: number;
  readonly oldestAgeMs: number;
  readonly metricSeries: number;
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
  readonly aggregates: Map<string, MutableAggregate>;
  readonly aggregateOverflow: MutableAggregate;
  records: Array<BufferedRecord | undefined>;
  head: number;
  queuedBytes: number;
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

const SYSTEM_SCHEDULER: TelemetryScheduler = {
  setInterval: (callback, delayMs) => setInterval(callback, delayMs),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const DISABLED_SNAPSHOT: TelemetrySnapshot = Object.freeze({
  enabled: false,
  queuedRecords: 0,
  queuedBytes: 0,
  oldestAgeMs: 0,
  metricSeries: 0,
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
  return value !== undefined && SAFE_ID.test(value) ? value : undefined;
}

function safeName(value: string | undefined): string | undefined {
  return value !== undefined && SAFE_NAME.test(value) ? value : undefined;
}

function safeCount(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function isMember<const T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === "string" && values.includes(value);
}

function sanitizeContext(context: TelemetryTraceContext | undefined): TelemetryRecordContext {
  return Object.freeze({
    traceId: safeId(context?.traceId),
    spanId: safeId(context?.spanId),
    parentSpanId: safeId(context?.parentSpanId),
    requestId: safeId(context?.requestId),
    connectionId: safeId(context?.connectionId),
    mutationId: safeId(context?.mutationId),
    commitId: safeId(context?.commitId),
    subscriptionId: safeId(context?.subscriptionId),
  });
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
      aggregates: new Map(),
      aggregateOverflow: {
        overflow: true,
        count: 0,
        durationMs: 0,
      },
      records: [],
      head: 0,
      queuedBytes: 0,
      localLines: [],
      localHead: 0,
      localBytes: 0,
      localPumpScheduled: false,
      stopped: false,
      aggregateOverflowedRecords: 0,
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
    const resource = isMember(TELEMETRY_RESOURCES, input.resource) ? input.resource : undefined;
    const record: TelemetrySpanRecord = Object.freeze({
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      kind: "span",
      timestampMs,
      ...sanitizeContext(input.context),
      links: sanitizeLinks(input.links),
      operation: input.operation,
      stage: input.stage,
      outcome: input.outcome,
      function: safeName(input.functionName),
      statement: safeName(input.statement),
      resource,
      durationMs: input.durationMs,
      sizeBytes: safeCount(input.sizeBytes),
      rowCount: safeCount(input.rowCount),
      resultCount: safeCount(input.resultCount),
      replayed: typeof input.replayed === "boolean" ? input.replayed : undefined,
      dependencyCount: safeCount(input.dependencyCount),
      postCommit: typeof input.postCommit === "boolean" ? input.postCommit : undefined,
    });
    this.aggregateSpan(state, record);
    const retain = input.durationMs >= state.limits.slowOperationMs || input.outcome !== "ok";
    return retain ? this.retain(record, true) : true;
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
        input.errorClass !== undefined && SAFE_ERROR_CLASS.test(input.errorClass)
          ? input.errorClass
          : undefined,
    });
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
    const series = [...state.aggregates.values()].map((aggregate) => this.freezeAggregate(aggregate));
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

  private retain(record: TelemetryRecord, emitLocally: boolean): boolean {
    const state = this.state!;
    const now = readClock(state);
    if (now === undefined) {
      state.drops.invalid++;
      return false;
    }
    let line: string;
    let bytes: number;
    try {
      line = JSON.stringify(record);
      bytes = state.encoder.encode(line).byteLength;
    } catch {
      state.drops.invalid++;
      return false;
    }
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

  private aggregateSpan(state: TelemetryState, record: TelemetrySpanRecord): void {
    const key = `${record.operation}|${record.stage}|${record.outcome}|${record.function ?? ""}|${record.resource ?? ""}`;
    let aggregate = state.aggregates.get(key);
    if (!aggregate) {
      if (state.aggregates.size >= state.limits.maxMetricSeries - 1) {
        aggregate = state.aggregateOverflow;
        state.aggregateOverflowedRecords = boundedCount(state.aggregateOverflowedRecords);
      } else {
        aggregate = {
          operation: record.operation,
          stage: record.stage,
          outcome: record.outcome,
          function: record.function,
          resource: record.resource,
          count: 0,
          durationMs: 0,
        };
        state.aggregates.set(key, aggregate);
      }
    }
    aggregate.count = boundedCount(aggregate.count);
    aggregate.durationMs = boundedSum(aggregate.durationMs, record.durationMs);
    this.addAggregateValue(aggregate, "sizeBytes", record.sizeBytes);
    this.addAggregateValue(aggregate, "rowCount", record.rowCount);
    this.addAggregateValue(aggregate, "resultCount", record.resultCount);
    this.addAggregateValue(aggregate, "dependencyCount", record.dependencyCount);
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
