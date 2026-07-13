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
  readonly localSinkFailures: number;
  readonly dropped: TelemetryDropSnapshot;
  readonly exporter: TelemetryExportSnapshot;
}

interface BufferedRecord {
  readonly record: TelemetryRecord;
  readonly bytes: number;
  readonly retainedAtMs: number;
}

interface TelemetryState {
  readonly limits: TelemetryLimits;
  readonly now: () => number;
  readonly scheduler: TelemetryScheduler;
  readonly exporter?: TelemetryExporter;
  readonly localSink?: (safeJsonLine: string) => void;
  readonly encoder: TextEncoder;
  readonly metricSeries: Set<string>;
  records: BufferedRecord[];
  head: number;
  queuedBytes: number;
  intervalHandle?: unknown;
  exporting?: Promise<void>;
  localSinkFailures: number;
  drops: {
    overflow: number;
    expired: number;
    oversized: number;
    invalid: number;
    exporter: number;
    cardinality: number;
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
const EXPORT_OK = Symbol("export-ok");
const EXPORT_FAILED = Symbol("export-failed");
const EXPORT_TIMED_OUT = Symbol("export-timed-out");

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
  localSinkFailures: 0,
  dropped: Object.freeze({
    overflow: 0,
    expired: 0,
    oversized: 0,
    invalid: 0,
    exporter: 0,
    cardinality: 0,
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
  const timestamp = timestampMs ?? state.now();
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

export function captureTelemetryLink(context: Pick<TelemetryTraceContext, "traceId" | "spanId">): TelemetryLink {
  const traceId = safeId(context.traceId);
  const spanId = safeId(context.spanId);
  if (!traceId || !spanId) throw new TypeError("telemetry links require safe traceId and spanId values");
  return Object.freeze({ traceId, spanId });
}

export class Telemetry {
  readonly enabled: boolean;
  private readonly state?: TelemetryState;

  constructor(options: TelemetryOptions = {}) {
    this.enabled = options.enabled !== false;
    if (!this.enabled) return;

    const limits = validateTelemetryLimits({
      ...PRODUCTION_LIMITS.telemetry,
      ...options.limits,
    });
    const scheduler = options.scheduler ?? SYSTEM_SCHEDULER;
    const state: TelemetryState = {
      limits,
      now: options.now ?? Date.now,
      scheduler,
      exporter: options.exporter,
      localSink: options.localSink === false ? undefined : options.localSink ?? console.log,
      encoder: new TextEncoder(),
      metricSeries: new Set(),
      records: [],
      head: 0,
      queuedBytes: 0,
      localSinkFailures: 0,
      drops: { overflow: 0, expired: 0, oversized: 0, invalid: 0, exporter: 0, cardinality: 0 },
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
      state.intervalHandle = scheduler.setInterval(() => void this.flush(), limits.batchIntervalMs);
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
      resource,
      durationMs: input.durationMs,
      sizeBytes: safeCount(input.sizeBytes),
      rowCount: safeCount(input.rowCount),
      resultCount: safeCount(input.resultCount),
      replayed: typeof input.replayed === "boolean" ? input.replayed : undefined,
      dependencyCount: safeCount(input.dependencyCount),
      postCommit: typeof input.postCommit === "boolean" ? input.postCommit : undefined,
    });
    return this.retain(record, input.durationMs >= state.limits.slowOperationMs || input.outcome !== "ok");
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
      state.metricSeries.add(OVERFLOW_SERIES);
      const overflow: TelemetryMetricRecord = Object.freeze({
        schemaVersion: TELEMETRY_SCHEMA_VERSION,
        kind: "metric",
        timestampMs,
        name: OVERFLOW_METRIC_NAME,
        value: 1,
        unit: "count",
        labels: Object.freeze({ resource: "telemetry", overflow: true }),
      });
      return this.retain(overflow, false);
    }
    state.metricSeries.add(seriesKey);
    const record: TelemetryMetricRecord = Object.freeze({
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      kind: "metric",
      timestampMs,
      name,
      value: input.value,
      unit: input.unit,
      labels,
    });
    return this.retain(record, false);
  }

  async flush(): Promise<void> {
    const state = this.state;
    if (!state?.exporter) return;
    if (state.exporting) return state.exporting;
    const now = this.readNow(state);
    this.pruneExpired(state, now);
    const count = Math.min(state.limits.maxBatchRecords, state.records.length - state.head);
    if (count === 0) return;

    const batch: TelemetryRecord[] = [];
    for (let index = 0; index < count; index++) {
      const buffered = state.records[state.head + index]!;
      batch.push(buffered.record);
      state.queuedBytes -= buffered.bytes;
    }
    state.head += count;
    this.compact(state);
    state.exportHealth.attempts++;
    const startedAtMs = now;
    const exporter = state.exporter;
    const frozenBatch = Object.freeze(batch);

    const attempt = (async () => {
      let exportResult: Promise<typeof EXPORT_OK | typeof EXPORT_FAILED>;
      try {
        exportResult = Promise.resolve(exporter.export(frozenBatch)).then(
          () => EXPORT_OK,
          () => EXPORT_FAILED,
        );
      } catch {
        exportResult = Promise.resolve(EXPORT_FAILED);
      }
      let timeoutHandle: unknown;
      const timeout = new Promise<typeof EXPORT_TIMED_OUT>((resolve) => {
        timeoutHandle = state.scheduler.setTimeout(
          () => resolve(EXPORT_TIMED_OUT),
          state.limits.exportTimeoutMs,
        );
      });
      const result = await Promise.race([exportResult, timeout]);
      state.scheduler.clearTimeout(timeoutHandle);
      const finishedAtMs = this.readNow(state);
      state.exportHealth.lastDurationMs = Math.max(0, finishedAtMs - startedAtMs);
      if (result === EXPORT_OK) {
        state.exportHealth.exportedRecords += count;
        state.exportHealth.lastSuccessAtMs = finishedAtMs;
      } else {
        state.exportHealth.failures++;
        state.exportHealth.failedRecords += count;
        state.exportHealth.lastFailureAtMs = finishedAtMs;
        state.drops.exporter += count;
        if (result === EXPORT_TIMED_OUT) state.exportHealth.timeouts++;
        this.recordEvent({
          timestampMs: finishedAtMs,
          name: "exporter_degraded",
          level: "error",
          operation: "lifecycle",
          stage: "export",
          outcome: "unavailable",
          resource: "telemetry",
        });
      }
      state.exporting = undefined;
    })();
    state.exporting = attempt;
    await attempt;
  }

  snapshot(): TelemetrySnapshot {
    const state = this.state;
    if (!state) return DISABLED_SNAPSHOT;
    const now = this.readNow(state);
    this.pruneExpired(state, now);
    const oldest = state.records[state.head];
    return Object.freeze({
      enabled: true,
      queuedRecords: state.records.length - state.head,
      queuedBytes: state.queuedBytes,
      oldestAgeMs: oldest ? Math.max(0, now - oldest.retainedAtMs) : 0,
      metricSeries: state.metricSeries.size,
      localSinkFailures: state.localSinkFailures,
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
    if (!state || state.intervalHandle === undefined) return;
    state.scheduler.clearInterval(state.intervalHandle);
    state.intervalHandle = undefined;
  }

  private readNow(state: TelemetryState): number {
    const now = state.now();
    if (!Number.isFinite(now)) throw new RangeError("telemetry clock must return finite milliseconds");
    return now;
  }

  private retain(record: TelemetryRecord, emitLocally: boolean): boolean {
    const state = this.state!;
    const line = JSON.stringify(record);
    if (emitLocally && state.localSink) {
      try {
        state.localSink(line);
      } catch {
        state.localSinkFailures++;
      }
    }
    const bytes = state.encoder.encode(line).byteLength;
    if (bytes > state.limits.maxBytes) {
      state.drops.oversized++;
      return false;
    }
    const now = this.readNow(state);
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
}
