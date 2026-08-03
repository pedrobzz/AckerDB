import {
  PRODUCTION_LIMITS,
  validateTelemetryLimits,
  type TelemetryLimits,
} from "../../runtime/limits.ts";
import { TraceJournal } from "../journal.ts";
import type {
  MutableTraceRetention,
  MutableTraceList,
  TelemetryState,
} from "../state/types.ts";
import type {
  BufferedRecord,
  BufferedLocalLine,
  EncodedRecord,
  JsonSpanPrimitive,
  SanitizedTelemetrySpan,
} from "../records/types.ts";
import { isMember, safeCount, safeId, safeName } from "../records/sanitize.ts";
import { TelemetryAggregation } from "../aggregation/series.ts";
import {
  MAX_LINKS,
  SAFE_ERROR_CLASS,
  OVERFLOW_METRIC_NAME,
  OVERFLOW_SERIES,
  TASK_OK,
  TASK_FAILED,
  TASK_TIMED_OUT,
  TASK_DEADLINE,
  EMPTY_RECORDS,
  UUID_LENGTH,
  NO_SLOT,
} from "../state/constants.ts";
import {
  TELEMETRY_EVENT_NAMES,
  TELEMETRY_OPERATIONS,
  TELEMETRY_OUTCOMES,
  TELEMETRY_RESOURCES,
  TELEMETRY_SCHEMA_VERSION,
  TELEMETRY_STAGES,
  type TelemetryOperation,
  type TelemetryOutcome,
  type TelemetryResource,
  type TelemetryStage,
} from "../contracts/schema.ts";
import type {
  PREPARED_TRACE_CONTEXT,
  TelemetryTraceContext,
  PreparedTelemetryTraceContext,
  TelemetryLink,
  TelemetrySpanInput,
  PreparedTelemetrySpanInput,
  TelemetryEventInput,
  TelemetryEventRecord,
  TelemetryMetricInput,
  TelemetryMetricRecord,
  TelemetryRecordContext,
  TelemetrySpanRecord,
  TelemetryRecord,
  TelemetryScheduler,
  TelemetryOptions,
  TelemetryTraceRetentionSnapshot,
  TelemetrySnapshot,
  TelemetryAggregateSnapshot,
} from "../contracts/types.ts";

import { AuthenticTelemetryTraceContext } from "../tracing/context.ts";
import {
  CLAIM_OPERATION_DELIVERY_LEASE,
  FINISH_OPERATION_TRACE,
  IDENTIFY_OPERATION_TRACE,
  OPEN_OPERATION_TRACE,
  OPERATION_INVOCATION_NODE,
  OPERATION_TRACE_CONTEXT,
  OperationTrace,
  OperationTraceContext,
  RECORD_OPERATION_EVENT,
  RECORD_OPERATION_SPAN,
  type OperationTelemetrySpanInput,
  type OperationTraceHandle,
  type OperationTraceInput,
} from "../tracing/operation-trace.ts";

/** Package-private entry point for spans carrying an authenticated prepared context. */
export const RECORD_PREPARED_SPAN = Symbol("ackerdb.recordPreparedTelemetrySpan");

declare const TELEMETRY_DELIVERY_LEASE: unique symbol;
export interface TelemetryDeliveryLease {
  readonly [TELEMETRY_DELIVERY_LEASE]: true;
}

/** Package-private ownership for one Runtime frame awaiting terminal delivery observation. */
export const CLAIM_DELIVERY_LEASE = Symbol("ackerdb.claimTelemetryDeliveryLease");
export const RELEASE_DELIVERY_LEASE = Symbol("ackerdb.releaseTelemetryDeliveryLease");

import { SYSTEM_SCHEDULER } from "./defaults.ts";
import { DISABLED_AGGREGATES, DISABLED_SNAPSHOT } from "../status/disabled.ts";
import {
  createAbsoluteDeadline,
  type AbsoluteDeadline,
} from "../export/deadline.ts";

/** Create or authenticate one package-owned context, sanitizing identifiers once. */
export function prepareTelemetryTraceContext(
  context: Partial<TelemetryTraceContext> = {},
): PreparedTelemetryTraceContext {
  if (AuthenticTelemetryTraceContext.owns(context)) {
    return context;
  }
  const sanitized = sanitizeContext({
    ...context,
    traceId: context.traceId ?? crypto.randomUUID(),
  });
  if (
    sanitized.traceId === undefined ||
    (context.spanId !== undefined && sanitized.spanId === undefined)
  ) {
    throw new TypeError("prepared telemetry contexts require safe traceId and spanId values");
  }
  return new AuthenticTelemetryTraceContext(sanitized);
}

/** Derive one authenticated child while inheriting already-sanitized operation identifiers. */
export function deriveTelemetryTraceContext(
  parent: PreparedTelemetryTraceContext,
  identifiers: Partial<Pick<
    TelemetryTraceContext,
    "requestId" | "connectionId" | "mutationId" | "commitId" | "subscriptionId"
  >> = {},
): PreparedTelemetryTraceContext {
  if (!AuthenticTelemetryTraceContext.owns(parent)) {
    throw new TypeError("telemetry child contexts require an authentic prepared parent");
  }
  return AuthenticTelemetryTraceContext.derive(parent, {
    traceId: parent.traceId,
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
  });
}

/** Add authenticated request identity without changing the owning root span. */
export function identifyTelemetryTraceRequest(
  context: PreparedTelemetryTraceContext,
  requestId: string,
): PreparedTelemetryTraceContext {
  if (!AuthenticTelemetryTraceContext.owns(context)) {
    throw new TypeError("telemetry request identity requires an authentic prepared context");
  }
  return AuthenticTelemetryTraceContext.identify(context, safeId(requestId));
}

function sanitizeContext(context: Partial<TelemetryTraceContext> | undefined): TelemetryRecordContext {
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
  const context = span.context;
  const materializedContext = AuthenticTelemetryTraceContext.owns(context) ||
      context instanceof OperationTraceContext
    ? {
        traceId: context.traceId,
        spanId: context.spanId,
        parentSpanId: context.parentSpanId,
        requestId: context.requestId,
        connectionId: context.connectionId,
        mutationId: context.mutationId,
        commitId: context.commitId,
        subscriptionId: context.subscriptionId,
      }
    : context;
  return Object.freeze({
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    kind: "span",
    timestampMs: span.timestampMs,
    ...materializedContext,
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

function jsonStringPropertyBytes(
  name: string,
  valueLength: number | undefined,
  leadingComma = true,
): number {
  return valueLength === undefined
    ? 0
    : jsonPropertyPrefixBytes(name, leadingComma) + valueLength + 2;
}

/** Exact JSON/UTF-8 size of the public record represented by one sanitized span. */
function stagedSpanBytes(span: SanitizedTelemetrySpan): number {
  let bytes = 2 + jsonPropertyBytes("schemaVersion", TELEMETRY_SCHEMA_VERSION, false);
  bytes += jsonPropertyBytes("kind", "span");
  bytes += jsonPropertyBytes("timestampMs", span.timestampMs);
  if (span.context instanceof OperationTraceContext) {
    bytes += jsonStringPropertyBytes("traceId", span.context.trace.traceIdLength());
    bytes += jsonStringPropertyBytes("spanId", span.context.trace.spanIdLength(span.context.node));
    bytes += jsonStringPropertyBytes(
      "parentSpanId",
      span.context.trace.parentSpanIdLength(span.context.node),
    );
  } else if (AuthenticTelemetryTraceContext.owns(span.context)) {
    bytes += jsonStringPropertyBytes("traceId", span.context.traceId.length);
    bytes += jsonStringPropertyBytes(
      "spanId",
      AuthenticTelemetryTraceContext.idLength(span.context, "spanId"),
    );
    bytes += jsonStringPropertyBytes(
      "parentSpanId",
      AuthenticTelemetryTraceContext.idLength(span.context, "parentSpanId"),
    );
  } else {
    bytes += jsonPropertyBytes("traceId", span.context.traceId);
    bytes += jsonPropertyBytes("spanId", span.context.spanId);
    bytes += jsonPropertyBytes("parentSpanId", span.context.parentSpanId);
  }
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

/** Exact JSON/UTF-8 size of one deferred package-owned operation span. */
function bufferedOperationSpanBytes(
  trace: OperationTrace,
  node: number,
  timestampMs: number,
  input: OperationTelemetrySpanInput,
): number {
  let bytes = 2 + jsonPropertyBytes("schemaVersion", TELEMETRY_SCHEMA_VERSION, false);
  bytes += jsonPropertyBytes("kind", "span");
  bytes += jsonPropertyBytes("timestampMs", timestampMs);
  bytes += jsonStringPropertyBytes("traceId", trace.traceIdLength());
  bytes += jsonStringPropertyBytes("spanId", trace.spanIdLength(node));
  bytes += jsonStringPropertyBytes("parentSpanId", trace.parentSpanIdLength(node));
  bytes += jsonPropertyBytes("requestId", safeId(input.requestId) ?? trace.requestId);
  bytes += jsonPropertyBytes("connectionId", safeId(input.connectionId) ?? trace.connectionId);
  bytes += jsonPropertyBytes("mutationId", safeId(input.mutationId) ?? trace.mutationId);
  bytes += jsonPropertyBytes("commitId", safeId(input.commitId) ?? trace.commitId);
  bytes += jsonPropertyBytes("subscriptionId", safeId(input.subscriptionId) ?? trace.subscriptionId);
  bytes += jsonPropertyBytes("operation", input.operation);
  bytes += jsonPropertyBytes("stage", input.stage);
  bytes += jsonPropertyBytes("outcome", input.outcome);
  bytes += jsonPropertyBytes("function", safeName(input.functionName));
  bytes += jsonPropertyBytes("statement", safeName(input.statement));
  bytes += jsonPropertyBytes("resource", input.resource);
  bytes += jsonPropertyBytes("durationMs", input.durationMs);
  bytes += jsonPropertyBytes("sizeBytes", safeCount(input.sizeBytes));
  bytes += jsonPropertyBytes("rowCount", safeCount(input.rowCount));
  bytes += jsonPropertyBytes("resultCount", safeCount(input.resultCount));
  bytes += jsonPropertyBytes("replayed", input.replayed);
  bytes += jsonPropertyBytes("dependencyCount", safeCount(input.dependencyCount));
  bytes += jsonPropertyBytes("postCommit", input.postCommit);
  return bytes;
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
    const operationTraceSampleInterval = options.operationTraceSampleInterval ?? 1_024;
    if (
      !Number.isSafeInteger(operationTraceSampleInterval) ||
      operationTraceSampleInterval < 0
    ) {
      throw new RangeError("operationTraceSampleInterval must be a non-negative safe integer");
    }
    this.sampleIntervalMs = limits.sampleIntervalMs;
    const scheduler = options.scheduler ?? SYSTEM_SCHEDULER;
    const state: TelemetryState = {
      limits,
      now: options.now ?? Date.now,
      scheduler,
      exporter: options.exporter,
      localSink: options.localSink === false ? undefined : options.localSink ?? console.log,
      encoder: new TextEncoder(),
      operationTraceSampleInterval,
      operationTraceSequence: 0,
      bufferedOperationSpans: 0,
      bufferedOperationBytes: 0,
      bufferedOperations: new Set(),
      metricSeries: new Set(),
      aggregation: new TelemetryAggregation(limits.maxMetricSeries),
      publicTraceIndex: new Map(),
      publicTraceDeletions: 0,
      activeTraces: { size: 0 },
      completedTraces: { size: 0 },
      traceJournal: new TraceJournal(limits.maxRecords),
      completedTracesWithStaging: 0,
      records: [],
      head: 0,
      queuedBytes: 0,
      stagedTraceRecords: 0,
      stagedTraceBytes: 0,
      localLines: [],
      localHead: 0,
      localBytes: 0,
      localPumpScheduled: false,
      exportPumpScheduled: false,
      exportPumpSuspended: false,
      stopped: false,
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
        exportedAggregateSnapshots: 0,
        failedAggregateSnapshots: 0,
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

  [OPEN_OPERATION_TRACE](input: OperationTraceInput): OperationTraceHandle {
    const state = this.state;
    if (!state) return new OperationTrace(input);
    const startedAtMs = readClock(state);
    if (startedAtMs === undefined) {
      this.observeInvalidTraceLifecycle(state);
      return new OperationTrace(input);
    }
    state.operationTraceSequence = boundedCount(state.operationTraceSequence);
    const sampled = state.operationTraceSampleInterval > 0 &&
      state.operationTraceSequence % state.operationTraceSampleInterval === 0;
    const operation = new OperationTrace(input, startedAtMs, sampled);
    if (state.limits.slowOperationMs === 0) return operation;
    this.pruneCompletedTraces(state, startedAtMs);
    if (operation.inheritedContext !== undefined) {
      const inherited = this.traceForContext(state, operation.inheritedContext);
      if (inherited?.phase === "active") {
        operation.retention = inherited;
        inherited.operationTrace = operation;
      }
      return operation;
    }
    if (!sampled) return operation;
    const trace = this.createTraceRetention(state, startedAtMs, undefined, undefined, operation);
    if (trace === undefined) return operation;
    operation.retention = trace;
    this.linkActiveTrace(state, trace);
    return operation;
  }

  [IDENTIFY_OPERATION_TRACE](
    handle: OperationTraceHandle,
    functionName: string,
    requestId: string,
  ): void {
    if (handle instanceof OperationTrace) handle.identify(functionName, requestId);
  }

  [FINISH_OPERATION_TRACE](handle: OperationTraceHandle): void {
    const state = this.state;
    if (!state || !(handle instanceof OperationTrace)) return;
    const completedAtMs = readClock(state);
    if (completedAtMs === undefined) {
      this.observeInvalidTraceLifecycle(state);
      const trace = handle.retention;
      if (trace?.owner !== state || trace.phase !== "active") return;
      this.removeTrace(state, trace);
      this.discardTrace(state, trace);
      return;
    }
    this[RECORD_OPERATION_SPAN](handle, 0, 0, {
      operation: handle.operation,
      stage: "boundary",
      outcome: handle.outcome,
      functionName: handle.rootFunction,
      resource: "operation",
      durationMs: Math.max(0, completedAtMs - (handle.startedAtMs ?? completedAtMs)),
    });
    const trace = handle.retention;
    if (trace?.owner !== state || trace.phase !== "active") {
      this.discardBufferedOperationSpans(state, handle);
      return;
    }
    this.pruneCompletedTraces(state, completedAtMs);
    if (handle.sampled && !trace.retained) this.promoteTrace(state, trace, completedAtMs);
    this.completeTrace(state, trace, completedAtMs);
  }

  [OPERATION_INVOCATION_NODE](
    handle: OperationTraceHandle,
    invocationId: number,
    phase: "auth" | "policy" | "handler",
    parent: number,
  ): number {
    return handle instanceof OperationTrace
      ? handle.invocationNode(invocationId, phase, parent)
      : 0;
  }

  [OPERATION_TRACE_CONTEXT](
    handle: OperationTraceHandle,
    node: number,
  ): TelemetryTraceContext | undefined {
    return handle instanceof OperationTrace ? handle.context(node) : undefined;
  }

  [CLAIM_OPERATION_DELIVERY_LEASE](
    handle: OperationTraceHandle,
  ): TelemetryDeliveryLease | undefined {
    const state = this.state;
    if (!state || !(handle instanceof OperationTrace)) return undefined;
    let trace = handle.retention;
    if (
      state.limits.slowOperationMs > 0 &&
      (trace?.owner !== state || trace.phase !== "active")
    ) {
      const startedAtMs = handle.startedAtMs ?? readClock(state);
      if (startedAtMs === undefined) return undefined;
      trace = this.createTraceRetention(state, startedAtMs, undefined, undefined, handle);
      if (trace === undefined) return undefined;
      handle.retention = trace;
      this.linkActiveTrace(state, trace);
      this.replayBufferedOperationSpans(state, handle, trace);
    }
    return this.claimTraceDelivery(state, trace);
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
    const prepared = AuthenticTelemetryTraceContext.owns(context) ? context : undefined;
    const traceId = prepared?.traceId ?? safeId(context.traceId);
    const startedAtMs = readTimestamp(state, timestampMs);
    if (!traceId || startedAtMs === undefined) {
      this.observeInvalidTraceLifecycle(state);
      return false;
    }
    if (state.limits.slowOperationMs === 0) return true;
    this.pruneCompletedTraces(state, startedAtMs);
    // Package-authentic roots are the ownership identity; their UUID is correlation-only.
    const existing = prepared === undefined
      ? this.traceForContext(state, context)
      : AuthenticTelemetryTraceContext.retention(prepared);
    if (existing !== undefined) {
      this.observeInvalidTraceLifecycle(state);
      return false;
    }
    const rootContext = prepared === undefined
      ? undefined
      : AuthenticTelemetryTraceContext.root(prepared);
    const trace = this.createTraceRetention(state, startedAtMs, traceId, rootContext);
    if (trace === undefined) return false;
    if (prepared === undefined) state.publicTraceIndex.set(traceId, trace);
    else if (!AuthenticTelemetryTraceContext.bind(prepared, trace)) {
      this.observeInvalidTraceLifecycle(state);
      return false;
    }
    this.linkActiveTrace(state, trace);
    return true;
  }

  [CLAIM_DELIVERY_LEASE](
    context: PreparedTelemetryTraceContext,
  ): TelemetryDeliveryLease | undefined {
    const state = this.state;
    if (
      !state ||
      state.limits.slowOperationMs === 0 ||
      !AuthenticTelemetryTraceContext.owns(context)
    ) return undefined;
    return this.claimTraceDelivery(state, this.traceForContext(state, context));
  }

  [RELEASE_DELIVERY_LEASE](lease: TelemetryDeliveryLease): void {
    const state = this.state;
    if (!state) return;
    const trace = lease as unknown as MutableTraceRetention;
    if (
      trace.owner !== state ||
      trace.phase === "settled" ||
      trace.pendingDeliveries === undefined ||
      trace.pendingDeliveries === 0
    ) return;
    trace.pendingDeliveries--;
    if (trace.phase === "completed" && trace.pendingDeliveries === 0) {
      this.settleDeliveredTrace(state, trace);
    }
  }

  /** Finish a trace and preserve its bounded decision for delayed delivery spans. */
  finishTrace(
    context: Pick<TelemetryTraceContext, "traceId">,
    timestampMs?: number,
  ): boolean {
    const state = this.state;
    if (!state) return false;
    const traceId = AuthenticTelemetryTraceContext.owns(context)
      ? context.traceId
      : safeId(context.traceId);
    if (!traceId) {
      this.observeInvalidTraceLifecycle(state);
      return false;
    }
    const completedAtMs = readTimestamp(state, timestampMs);
    if (completedAtMs === undefined) {
      this.observeInvalidTraceLifecycle(state);
      const trace = this.traceForContext(state, context);
      if (trace?.phase === "active") {
        this.removeTrace(state, trace);
        this.discardTrace(state, trace);
      }
      return false;
    }
    if (state.limits.slowOperationMs === 0) return true;
    this.pruneCompletedTraces(state, completedAtMs);
    const trace = this.traceForContext(state, context);
    if (trace?.phase !== "active") {
      if (trace?.phase === "completed") return true;
      this.observeInvalidTraceLifecycle(state);
      return false;
    }
    this.completeTrace(state, trace, completedAtMs);
    return true;
  }

  recordSpan(input: TelemetrySpanInput): boolean {
    const state = this.state;
    if (!state) return false;
    const trace = this.traceForContext(state, input.context);
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
    return this.recordSanitizedSpan(state, span, trace);
  }

  [RECORD_PREPARED_SPAN](input: PreparedTelemetrySpanInput): boolean {
    const state = this.state;
    if (!state) return false;
    const timestampMs = readTimestamp(state, input.timestampMs);
    if (
      timestampMs === undefined ||
      !AuthenticTelemetryTraceContext.owns(input.context) ||
      !Number.isFinite(input.durationMs) ||
      input.durationMs < 0
    ) {
      state.drops.invalid++;
      return false;
    }
    const trace = this.traceForContext(state, input.context);
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
    }, trace?.owner === state ? trace : undefined);
  }

  [RECORD_OPERATION_SPAN](
    handle: OperationTraceHandle,
    node: number,
    parentNode: number,
    input: OperationTelemetrySpanInput,
  ): boolean {
    const state = this.state;
    if (!state || !(handle instanceof OperationTrace)) return false;
    const {
      operation,
      stage,
      outcome,
      functionName,
      statement,
      resource,
      durationMs,
      sizeBytes,
      rowCount,
      resultCount,
      replayed,
      dependencyCount,
      postCommit,
      requestId,
      connectionId,
      mutationId,
      commitId,
      subscriptionId,
    } = input;
    const timestampMs = readClock(state);
    if (timestampMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) {
      state.drops.invalid = boundedCount(state.drops.invalid);
      return false;
    }
    const safeFunction = safeName(functionName);
    const safeStatement = safeName(statement);
    const safeSize = safeCount(sizeBytes);
    const safeRows = safeCount(rowCount);
    const safeResults = safeCount(resultCount);
    const safeDependencies = safeCount(dependencyCount);
    const safeRequestId = safeId(requestId);
    const safeConnectionId = safeId(connectionId);
    const safeMutationId = safeId(mutationId);
    const safeCommitId = safeId(commitId);
    const safeSubscriptionId = safeId(subscriptionId);
    const retain = durationMs >= state.limits.slowOperationMs || outcome !== "ok";
    handle.observeOutcome(outcome);
    let trace = handle.retention;
    if (trace?.owner !== state || trace.phase === "settled") trace = undefined;
    if (trace === undefined && retain && state.limits.slowOperationMs > 0) {
      const startedAtMs = handle.startedAtMs ?? timestampMs;
      trace = this.createTraceRetention(state, startedAtMs, undefined, undefined, handle);
      if (trace !== undefined) {
        handle.retention = trace;
        this.linkActiveTrace(state, trace);
        this.promoteTrace(state, trace, timestampMs);
        this.replayBufferedOperationSpans(state, handle, trace);
      } else {
        this.discardBufferedOperationSpans(state, handle);
      }
    }
    if (state.limits.slowOperationMs > 0 && trace === undefined && !retain) {
      this.aggregateSpanValues(
        state,
        operation,
        stage,
        outcome,
        safeFunction,
        resource,
        durationMs,
        safeSize,
        safeRows,
        safeResults,
        safeDependencies,
      );
      if (stage !== "boundary") this.bufferOperationSpan(
        state,
        handle,
        node,
        parentNode,
        timestampMs,
        input,
      );
      return true;
    }
    const resolvedNode = node === NO_SLOT ? handle.childNode(parentNode) : node;
    const span: SanitizedTelemetrySpan = {
      timestampMs,
      context: handle.context(
        resolvedNode,
        safeRequestId,
        safeConnectionId,
        safeMutationId,
        safeCommitId,
        safeSubscriptionId,
      ),
      operation,
      stage,
      outcome,
      function: safeFunction,
      statement: safeStatement,
      resource,
      durationMs,
      sizeBytes: safeSize,
      rowCount: safeRows,
      resultCount: safeResults,
      replayed,
      dependencyCount: safeDependencies,
      postCommit,
    };
    this.aggregateSpan(state, span);
    return this.recordAggregatedSpan(state, span, trace);
  }

  private bufferOperationSpan(
    state: TelemetryState,
    handle: OperationTrace,
    node: number,
    parentNode: number,
    timestampMs: number,
    input: OperationTelemetrySpanInput,
  ): void {
    const resolvedNode = node === NO_SLOT ? handle.childNode(parentNode) : node;
    const bytes = bufferedOperationSpanBytes(handle, resolvedNode, timestampMs, input);
    if (
      bytes > state.limits.maxBytes ||
      state.stagedTraceRecords + state.bufferedOperationSpans >= state.limits.maxRecords ||
      bytes > state.limits.maxBytes - state.stagedTraceBytes - state.bufferedOperationBytes ||
      handle.bufferedSpanCount() >= state.limits.maxBatchRecords
    ) {
      state.traceHealth.dropped.stagedOverflow = boundedCount(
        state.traceHealth.dropped.stagedOverflow,
      );
      return;
    }
    handle.bufferSpan(resolvedNode, parentNode, timestampMs, input, bytes);
    state.bufferedOperations.add(handle);
    state.bufferedOperationSpans++;
    state.bufferedOperationBytes += bytes;
  }

  private replayBufferedOperationSpans(
    state: TelemetryState,
    handle: OperationTrace,
    trace: MutableTraceRetention,
  ): void {
    const replayed = handle.drainBufferedSpans((node, _parentNode, timestampMs, input) => {
      const span = sanitizeSpan({
        ...input,
        timestampMs,
        context: handle.context(
          node,
          safeId(input.requestId),
          safeId(input.connectionId),
          safeId(input.mutationId),
          safeId(input.commitId),
          safeId(input.subscriptionId),
        ),
      }, timestampMs);
      this.recordAggregatedSpan(state, span, trace);
    });
    state.bufferedOperationSpans -= replayed.records;
    state.bufferedOperationBytes -= replayed.bytes;
    state.bufferedOperations.delete(handle);
  }

  private discardBufferedOperationSpans(
    state: TelemetryState,
    handle: OperationTrace,
  ): void {
    const discarded = handle.drainBufferedSpans();
    state.bufferedOperationSpans -= discarded.records;
    state.bufferedOperationBytes -= discarded.bytes;
    state.bufferedOperations.delete(handle);
  }

  [RECORD_OPERATION_EVENT](
    handle: OperationTraceHandle,
    parentNode: number,
    input: Omit<TelemetryEventInput, "context">,
    requestId?: string,
    connectionId?: string,
    mutationId?: string,
    commitId?: string,
    subscriptionId?: string,
  ): boolean {
    const state = this.state;
    if (!state || !(handle instanceof OperationTrace)) return false;
    const timestampMs = readTimestamp(state, input.timestampMs);
    if (timestampMs === undefined) {
      state.drops.invalid = boundedCount(state.drops.invalid);
      return false;
    }
    const trace = handle.retention;
    if (
      state.limits.slowOperationMs > 0 &&
      trace?.owner === state &&
      trace.phase !== "settled" &&
      (input.name === "failure" ||
        input.level !== "info" ||
        (input.outcome !== undefined && input.outcome !== "ok") ||
        input.lifecycleState === "failed") &&
      !trace.retained
    ) {
      this.promoteTrace(state, trace, timestampMs);
    }
    return this.recordEvent({
      ...input,
      timestampMs,
      context: handle.context(
        handle.childNode(parentNode),
        safeId(requestId),
        safeId(connectionId),
        safeId(mutationId),
        safeId(commitId),
        safeId(subscriptionId),
      ),
    });
  }

  private recordSanitizedSpan(
    state: TelemetryState,
    span: SanitizedTelemetrySpan,
    associatedTrace?: MutableTraceRetention,
  ): boolean {
    this.aggregateSpan(state, span);
    return this.recordAggregatedSpan(state, span, associatedTrace);
  }

  private recordAggregatedSpan(
    state: TelemetryState,
    span: SanitizedTelemetrySpan,
    associatedTrace?: MutableTraceRetention,
  ): boolean {
    const retain = span.durationMs >= state.limits.slowOperationMs || span.outcome !== "ok";
    if (state.limits.slowOperationMs === 0) return this.retain(materializeSpan(span), true);

    let trace = associatedTrace?.owner === state && associatedTrace.phase !== "settled"
      ? associatedTrace
      : undefined;
    if (trace !== undefined) {
      this.pruneCompletedTraces(state, span.timestampMs);
    } else {
      const traceId = span.context.traceId;
      if (traceId !== undefined) {
        this.pruneCompletedTraces(state, span.timestampMs);
        trace = this.traceForContext(state, span.context);
      }
    }
    if (trace !== undefined) {
      if (trace.retained) return this.retain(materializeSpan(span), true);
      if (retain) {
        this.promoteTrace(state, trace, span.timestampMs);
        return this.retain(materializeSpan(span), true);
      }
      this.stageTraceSpan(state, trace, span);
      return true;
    }
    return retain ? this.retain(materializeSpan(span), true) : true;
  }

  recordEvent(input: TelemetryEventInput): boolean {
    const state = this.state;
    if (!state) return false;
    const associatedTrace = this.traceForContext(state, input.context);
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
      const trace = associatedTrace?.owner === state && associatedTrace.phase !== "settled"
        ? associatedTrace
        : undefined;
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
      stage: isMember(TELEMETRY_STAGES, input.labels?.stage) ? input.labels.stage : undefined,
      function: safeName(input.labels?.functionName),
      outcome: isMember(TELEMETRY_OUTCOMES, input.labels?.outcome) ? input.labels.outcome : undefined,
      resource: isMember(TELEMETRY_RESOURCES, input.labels?.resource)
        ? input.labels.resource
        : undefined,
    });
    const seriesKey = `${name}|${input.unit}|${labels.operation ?? ""}|${labels.stage ?? ""}|${labels.function ?? ""}|${labels.outcome ?? ""}|${labels.resource ?? ""}`;
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
    const retained = this.retain(record, input.local === true);
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
        this.scheduleExportPressure(state);
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
    return state.aggregation.snapshot();
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
        stagedRecords: state.stagedTraceRecords + state.bufferedOperationSpans,
        stagedBytes: state.stagedTraceBytes + state.bufferedOperationBytes,
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
        inFlight: state.exporting !== undefined || state.aggregation.isExporting(),
        aggregateSnapshotPending: state.exporter !== undefined &&
          state.aggregation.hasPendingExport(),
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

  private createTraceRetention(
    state: TelemetryState,
    startedAtMs: number,
    traceId?: string,
    rootContext?: AuthenticTelemetryTraceContext,
    operationTrace?: OperationTrace,
  ): MutableTraceRetention | undefined {
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
      return undefined;
    }
    return {
      traceId,
      startedAtMs,
      owner: state,
      rootContext,
      operationTrace,
      phase: "active",
      retained: false,
      stagedHead: NO_SLOT,
      stagedTail: NO_SLOT,
      stagedRecords: 0,
      stagedBytes: 0,
    };
  }

  private completeTrace(
    state: TelemetryState,
    trace: MutableTraceRetention,
    completedAtMs: number,
  ): void {
    if (
      !trace.retained &&
      completedAtMs - trace.startedAtMs >= state.limits.slowOperationMs
    ) {
      this.promoteTrace(state, trace, completedAtMs);
    }
    trace.completedAtMs = completedAtMs;
    this.linkCompletedTrace(state, trace);
    if (trace.pendingDeliveries === 0) this.settleDeliveredTrace(state, trace);
  }

  private claimTraceDelivery(
    state: TelemetryState,
    trace: MutableTraceRetention | undefined,
  ): TelemetryDeliveryLease | undefined {
    if (
      trace?.owner !== state ||
      trace.phase !== "active" ||
      trace.pendingDeliveries === Number.MAX_SAFE_INTEGER
    ) return undefined;
    trace.pendingDeliveries = (trace.pendingDeliveries ?? 0) + 1;
    return trace as unknown as TelemetryDeliveryLease;
  }

  private stageTraceSpan(
    state: TelemetryState,
    trace: MutableTraceRetention,
    span: SanitizedTelemetrySpan,
  ): void {
    // A promoted trace materializes its whole staged tail synchronously into
    // the bounded export queue, so one trace may stage at most one export
    // batch: a high-fanout operation could otherwise accumulate the entire
    // queue's worth of delivery spans and evict every other retained record
    // the moment it turns slow. The bound is per trace; the global caps below
    // still govern the staging pool as a whole.
    if (!this.canStageTraceSpan(state, trace)) return;
    const bytes = stagedSpanBytes(span);
    this.stageJournalSpan(state, trace, span, bytes);
  }

  private canStageTraceSpan(state: TelemetryState, trace: MutableTraceRetention): boolean {
    const excludedCompletedTrace = trace.phase === "completed" && trace.stagedRecords > 0
      ? 1
      : 0;
    const available = trace.stagedRecords < state.limits.maxBatchRecords &&
      (state.completedTracesWithStaging > excludedCompletedTrace ||
        (state.stagedTraceRecords + state.bufferedOperationSpans < state.limits.maxRecords &&
          state.stagedTraceBytes + state.bufferedOperationBytes < state.limits.maxBytes));
    if (!available) {
      state.traceHealth.dropped.stagedOverflow = boundedCount(
        state.traceHealth.dropped.stagedOverflow,
      );
    }
    return available;
  }

  private stageJournalSpan(
    state: TelemetryState,
    trace: MutableTraceRetention,
    span: SanitizedTelemetrySpan,
    bytes: number,
  ): void {
    while (
      (state.stagedTraceRecords + state.bufferedOperationSpans >= state.limits.maxRecords ||
        bytes > state.limits.maxBytes - state.stagedTraceBytes - state.bufferedOperationBytes) &&
      this.evictOldestCompletedTrace(state, trace, true)
    ) {
      // Prefer a current active trace over an older completed tail decision.
    }
    if (
      bytes > state.limits.maxBytes ||
      state.stagedTraceRecords + state.bufferedOperationSpans >= state.limits.maxRecords ||
      bytes > state.limits.maxBytes - state.stagedTraceBytes - state.bufferedOperationBytes
    ) {
      state.traceHealth.dropped.stagedOverflow = boundedCount(
        state.traceHealth.dropped.stagedOverflow,
      );
      return;
    }
    const wasEmpty = trace.stagedRecords === 0;
    if (!state.traceJournal.append(trace, span, bytes)) {
      state.traceHealth.dropped.stagedOverflow = boundedCount(
        state.traceHealth.dropped.stagedOverflow,
      );
      return;
    }
    if (trace.phase === "completed" && wasEmpty) {
      state.completedTracesWithStaging++;
    }
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
    this.drainTraceSpans(state, trace, retainedAtMs);
  }

  private drainTraceSpans(
    state: TelemetryState,
    trace: MutableTraceRetention,
    retainedAtMs?: number,
  ): number {
    if (trace.phase === "completed" && trace.stagedRecords > 0) {
      state.completedTracesWithStaging--;
    }
    const released = state.traceJournal.drain(
      trace,
      retainedAtMs === undefined
        ? undefined
        : (span) => {
          const record = materializeSpan(span);
          const encoded = this.encodeRecord(state, record);
          if (encoded) {
            this.retainEncoded(state, record, encoded.line, encoded.bytes, true, retainedAtMs);
          }
        },
    );
    state.stagedTraceRecords -= released.records;
    state.stagedTraceBytes -= released.bytes;
    return released.records;
  }

  private discardTrace(state: TelemetryState, trace: MutableTraceRetention): void {
    const discardedRecords = this.drainTraceSpans(state, trace);
    if (trace.retained) return;
    state.traceHealth.discardedTraces = boundedCount(state.traceHealth.discardedTraces);
    state.traceHealth.discardedRecords = Math.min(
      Number.MAX_SAFE_INTEGER,
      state.traceHealth.discardedRecords + discardedRecords,
    );
  }

  private traceForContext(
    state: TelemetryState,
    context: Pick<TelemetryRecordContext, "traceId"> | undefined,
  ): MutableTraceRetention | undefined {
    if (AuthenticTelemetryTraceContext.owns(context)) {
      const trace = AuthenticTelemetryTraceContext.retention(context);
      return trace?.owner === state && trace.phase !== "settled" ? trace : undefined;
    }
    const traceId = context === undefined ? undefined : safeId(context.traceId);
    if (traceId === undefined) return undefined;
    const publicTrace = state.publicTraceIndex.get(traceId);
    if (publicTrace !== undefined) return publicTrace;
    for (let trace = state.activeTraces.head; trace !== undefined; trace = trace.next) {
      if (trace.traceId === traceId) return trace;
    }
    for (let trace = state.completedTraces.head; trace !== undefined; trace = trace.next) {
      if (trace.traceId === traceId) return trace;
    }
    return undefined;
  }

  private linkActiveTrace(state: TelemetryState, trace: MutableTraceRetention): void {
    trace.phase = "active";
    this.appendTrace(state.activeTraces, trace);
  }

  private linkCompletedTrace(state: TelemetryState, trace: MutableTraceRetention): void {
    this.unlinkTrace(state.activeTraces, trace);
    trace.phase = "completed";
    if (trace.stagedRecords > 0) state.completedTracesWithStaging++;
    this.appendTrace(state.completedTraces, trace);
  }

  private appendTrace(list: MutableTraceList, trace: MutableTraceRetention): void {
    trace.previous = list.tail;
    trace.next = undefined;
    if (list.tail === undefined) list.head = trace;
    else list.tail.next = trace;
    list.tail = trace;
    list.size++;
  }

  private unlinkTrace(list: MutableTraceList, trace: MutableTraceRetention): void {
    const { previous, next } = trace;
    if (previous === undefined) list.head = next;
    else previous.next = next;
    if (next === undefined) list.tail = previous;
    else next.previous = previous;
    trace.previous = undefined;
    trace.next = undefined;
    list.size--;
  }

  private removeTrace(state: TelemetryState, trace: MutableTraceRetention): void {
    if (trace.owner !== state || trace.phase === "settled") return;
    if (trace.phase === "completed" && trace.stagedRecords > 0) {
      state.completedTracesWithStaging--;
    }
    this.unlinkTrace(trace.phase === "active" ? state.activeTraces : state.completedTraces, trace);
    trace.phase = "settled";
    AuthenticTelemetryTraceContext.release(trace);
    if (trace.operationTrace?.retention === trace) trace.operationTrace.retention = undefined;
    if (
      trace.rootContext === undefined &&
      trace.traceId !== undefined &&
      state.publicTraceIndex.get(trace.traceId) === trace
    ) {
      state.publicTraceIndex.delete(trace.traceId);
      state.publicTraceDeletions++;
      if (state.publicTraceDeletions >= state.limits.maxRecords) {
        // Lists own live traces, so replace the disposable lookup index with an empty map.
        state.publicTraceIndex = new Map();
        state.publicTraceDeletions = 0;
      }
    }
    trace.rootContext = undefined;
    trace.operationTrace = undefined;
    trace.owner = undefined;
  }

  private discardAllTraceState(state: TelemetryState): void {
    const bufferedOperations = state.bufferedOperations.size;
    for (const operation of [...state.bufferedOperations]) {
      this.discardBufferedOperationSpans(state, operation);
    }
    const traces = state.activeTraces.size + state.completedTraces.size + bufferedOperations;
    for (let trace = state.activeTraces.head; trace !== undefined;) {
      const next = trace.next;
      this.removeTrace(state, trace);
      this.discardTrace(state, trace);
      trace = next;
    }
    for (let trace = state.completedTraces.head; trace !== undefined;) {
      const next = trace.next;
      this.removeTrace(state, trace);
      this.discardTrace(state, trace);
      trace = next;
    }
    state.publicTraceIndex = new Map();
    state.publicTraceDeletions = 0;
    state.traceHealth.dropped.drain = Math.min(
      Number.MAX_SAFE_INTEGER,
      state.traceHealth.dropped.drain + traces,
    );
  }

  private pruneCompletedTraces(state: TelemetryState, now: number): void {
    while (state.completedTraces.head !== undefined) {
      const oldest = state.completedTraces.head;
      if (
        oldest.completedAtMs === undefined ||
        now - oldest.completedAtMs < state.limits.retentionMs
      ) return;
      this.removeCompletedTrace(state, oldest, "expiredDecisions");
    }
  }

  private evictOldestCompletedTrace(
    state: TelemetryState,
    excludedTrace?: MutableTraceRetention,
    requireStaged = false,
  ): boolean {
    if (
      requireStaged &&
      state.completedTracesWithStaging <=
        (excludedTrace?.phase === "completed" && excludedTrace.stagedRecords > 0 ? 1 : 0)
    ) return false;
    for (let trace = state.completedTraces.head; trace !== undefined; trace = trace.next) {
      if (
        trace === excludedTrace ||
        (requireStaged && trace.stagedRecords === 0)
      ) continue;
      this.removeCompletedTrace(state, trace, "decisionOverflow");
      return true;
    }
    return false;
  }

  private removeCompletedTrace(
    state: TelemetryState,
    trace: MutableTraceRetention,
    reason: "decisionOverflow" | "expiredDecisions",
  ): void {
    if (trace.owner !== state || trace.phase !== "completed") return;
    this.removeTrace(state, trace);
    state.traceHealth.dropped[reason] = boundedCount(state.traceHealth.dropped[reason]);
    this.discardTrace(state, trace);
  }

  private settleDeliveredTrace(
    state: TelemetryState,
    trace: MutableTraceRetention,
  ): void {
    if (trace.owner !== state || trace.phase !== "completed") return;
    this.removeTrace(state, trace);
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
    this.scheduleExportPressure(state);
    return true;
  }

  /**
   * Export ahead of the batch clock whenever a full batch (or half the byte
   * budget) is already queued. The interval tick alone caps sustained export
   * throughput at maxBatchRecords per batchIntervalMs, so a record burst
   * would overflow the bounded queue while a healthy exporter sat idle.
   * The pump is a microtask rather than a timer because the largest bursts
   * are themselves microtask cascades (per-sink delivery-observation drains
   * during mass disconnect and fanout failure) that retain thousands of
   * records before any timer can fire; a microtask interleaves with the
   * storm, so an exporter that settles promptly bounds the queue by its own
   * speed instead of the calendar. Record producers never execute exporter
   * code on their own stack, a flush already in flight defers rescheduling
   * to its completion, and any failed or degraded attempt suspends the pump
   * until an export succeeds again so an unhealthy exporter falls back to
   * the fail-open interval-and-overflow policy instead of being hammered.
   */
  private scheduleExportPressure(state: TelemetryState): void {
    if (
      !state.exporter ||
      state.stopped ||
      state.exportPumpScheduled ||
      state.exportPumpSuspended ||
      state.exporting !== undefined ||
      (state.records.length - state.head < state.limits.maxBatchRecords &&
        state.queuedBytes * 2 < state.limits.maxBytes)
    ) {
      return;
    }
    state.exportPumpScheduled = true;
    try {
      queueMicrotask(() => {
        state.exportPumpScheduled = false;
        if (state.stopped) return;
        try {
          void this.flush();
        } catch {
          this.observeExportFailure(state);
        }
      });
    } catch {
      state.exportPumpScheduled = false;
      this.observeExportFailure(state);
    }
  }

  private aggregateSpan(state: TelemetryState, span: SanitizedTelemetrySpan): void {
    this.aggregateSpanValues(
      state,
      span.operation,
      span.stage,
      span.outcome,
      span.function,
      span.resource,
      span.durationMs,
      span.sizeBytes,
      span.rowCount,
      span.resultCount,
      span.dependencyCount,
    );
  }

  private aggregateSpanValues(
    state: TelemetryState,
    operation: TelemetryOperation,
    stage: TelemetryStage,
    outcome: TelemetryOutcome,
    functionName: string | undefined,
    resource: TelemetryResource | undefined,
    durationMs: number,
    sizeBytes: number | undefined,
    rowCount: number | undefined,
    resultCount: number | undefined,
    dependencyCount: number | undefined,
  ): void {
    state.aggregation.record(
      operation,
      stage,
      outcome,
      functionName,
      resource,
      durationMs,
      sizeBytes,
      rowCount,
      resultCount,
      dependencyCount,
    );
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
    const aggregates = this.takeChangedAggregateSnapshot(state);
    if (count === 0 && aggregates === undefined) return;
    await this.exportBatch(
      state,
      count === 0 ? EMPTY_RECORDS : Object.freeze(this.takeRecords(state, count)),
      aggregates,
      observedStart,
      true,
    );
  }

  private takeChangedAggregateSnapshot(
    state: TelemetryState,
  ): TelemetryAggregateSnapshot | undefined {
    return state.aggregation.takeChangedSnapshot();
  }

  private async exportBatch(
    state: TelemetryState,
    batch: readonly TelemetryRecord[],
    aggregates: TelemetryAggregateSnapshot | undefined,
    observedStart: number | undefined,
    reportDegraded: boolean,
    deadline?: AbsoluteDeadline,
  ): Promise<
    typeof TASK_OK | typeof TASK_FAILED | typeof TASK_TIMED_OUT | typeof TASK_DEADLINE
  > {
    const startedAtMs = observedStart ?? fallbackNow(state);
    state.exportHealth.attempts++;
    const exported = await this.runBoundedTask(
      state,
      () => state.exporter!.export(batch, aggregates),
      deadline,
    );
    const observedFinish = readClock(state);
    if (observedFinish === undefined) state.drops.invalid++;
    const finishedAtMs = observedFinish ?? startedAtMs;
    state.exportHealth.lastDurationMs = Math.max(0, finishedAtMs - startedAtMs);
    state.exportPumpSuspended = exported.result !== TASK_OK || exported.schedulerFailed;

    if (exported.result === TASK_OK) {
      state.exportHealth.exportedRecords += batch.length;
      if (aggregates !== undefined) {
        state.aggregation.finishExport(true);
        state.exportHealth.exportedAggregateSnapshots = boundedCount(
          state.exportHealth.exportedAggregateSnapshots,
        );
      }
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
    if (aggregates !== undefined) {
      state.aggregation.finishExport(false);
      state.exportHealth.failedAggregateSnapshots = boundedCount(
        state.exportHealth.failedAggregateSnapshots,
      );
    }
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
    const deadline = createAbsoluteDeadline(
      state.scheduler,
      () => readClock(state),
      deadlineAtMs,
      () => state.drops.invalid++,
    );
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
        const result = await this.exportBatch(
          state,
          batch,
          this.takeChangedAggregateSnapshot(state),
          observedStart,
          false,
          deadline,
        );
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
      while (state.aggregation.hasDirtySnapshot()) {
        if (deadline.expired()) return;
        const aggregates = this.takeChangedAggregateSnapshot(state)!;
        const observedStart = readClock(state);
        if (observedStart === undefined) state.drops.invalid++;
        const result = await this.exportBatch(
          state,
          EMPTY_RECORDS,
          aggregates,
          observedStart,
          false,
          deadline,
        );
        if (result !== TASK_OK) return;
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
