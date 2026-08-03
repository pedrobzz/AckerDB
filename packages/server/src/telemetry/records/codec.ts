import type {
  TelemetryLink,
  TelemetryRecord,
  TelemetryRecordContext,
  TelemetrySpanInput,
  TelemetrySpanRecord,
  TelemetryTraceContext,
} from "../contracts/types.ts";
import {
  TELEMETRY_RESOURCES,
  TELEMETRY_SCHEMA_VERSION,
} from "../contracts/schema.ts";
import { MAX_LINKS } from "../state/constants.ts";
import { AuthenticTelemetryTraceContext } from "../tracing/context.ts";
import { OperationTraceContext } from "../tracing/operation-trace.ts";
import { isMember, safeCount, safeId, safeName } from "./sanitize.ts";
import type {
  EncodedRecord,
  JsonSpanPrimitive,
  SanitizedTelemetrySpan,
} from "./types.ts";

export function sanitizeContext(
  context: Partial<TelemetryTraceContext> | undefined,
): TelemetryRecordContext {
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

export function sanitizeLinks(
  links: readonly TelemetryLink[] | undefined,
): readonly TelemetryLink[] | undefined {
  if (!links?.length) return undefined;
  const safe: TelemetryLink[] = [];
  for (let index = 0; index < links.length && safe.length < MAX_LINKS; index++) {
    const traceId = safeId(links[index]?.traceId);
    const spanId = safeId(links[index]?.spanId);
    if (traceId && spanId) safe.push(Object.freeze({ traceId, spanId }));
  }
  return safe.length ? Object.freeze(safe) : undefined;
}

export function sanitizeSpan(
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

export function materializeSpan(span: SanitizedTelemetrySpan): TelemetrySpanRecord {
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
export function stagedSpanBytes(span: SanitizedTelemetrySpan): number {
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

export function encodeRecord(record: TelemetryRecord): EncodedRecord {
  const line = JSON.stringify(record);
  // All free-form strings cross ASCII-only sanitizers, so code units equal
  // encoded UTF-8 bytes without allocating an encoded copy.
  return { line, bytes: line.length };
}
