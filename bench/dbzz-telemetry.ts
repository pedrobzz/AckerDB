import {
  PRODUCTION_LIMITS,
  TELEMETRY_OPERATIONS,
  TELEMETRY_STAGES,
  type TelemetryAggregateSnapshot,
  type TelemetryOperation,
  type TelemetryRecord,
  type TelemetrySnapshot,
  type TelemetryStage,
} from "@dbzz/server";
import type { DriverResult } from "./benchmark.ts";
import type { DbzzStartupMode } from "./dbzz-profile.ts";

const RECORD_PREFIX = '{"schemaVersion":1,"kind":';
const DIAGNOSTIC_TAIL_CHARS = 64 * 1024;
const MAX_CONTROL_LINES = 16;
const MAX_CONTROL_LINE_CHARS = 4 * 1024;
const MAX_LINE_CHARS = PRODUCTION_LIMITS.telemetry.maxBytes;
const BENCHMARK_OPERATIONS = ["query", "mutation", "procedure", "subscription"] as const;

type BenchmarkOperation = (typeof BENCHMARK_OPERATIONS)[number];
type TelemetryRecordKind = TelemetryRecord["kind"];

export interface LocalTelemetryOutputSnapshot {
  readonly records: number;
  readonly bytes: number;
  readonly invalidRecords: number;
  readonly oversizedLines: number;
  readonly controlOverflow: number;
  readonly peakPendingChars: number;
  readonly diagnosticTailChars: number;
  readonly byKind: Readonly<Record<TelemetryRecordKind, number>>;
  readonly byOperation: Readonly<Record<TelemetryOperation, number>>;
  readonly byStage: Readonly<Record<TelemetryStage, number>>;
}

export interface AggregateCell {
  readonly count: number;
  readonly durationMs: number;
}

export interface OperationAggregateSummary {
  readonly count: number;
  readonly durationMs: number;
  readonly stages: Readonly<Record<TelemetryStage, AggregateCell>>;
}

export interface BenchmarkAggregateSummary {
  readonly maxSeries: number;
  readonly overflowedRecords: number;
  readonly spans: number;
  readonly durationMs: number;
  readonly operations: Readonly<Record<BenchmarkOperation, OperationAggregateSummary>>;
}

export interface DbzzTelemetryTerminalReport {
  readonly schemaVersion: 1;
  readonly startupMode: DbzzStartupMode;
  readonly runtime: Readonly<{
    beforeDrain: TelemetrySnapshot;
    afterDrain: TelemetrySnapshot;
  }>;
  readonly aggregates: BenchmarkAggregateSummary;
}

export interface DbzzTelemetryDrainAccounting {
  readonly retainedBeforeDrain: number;
  readonly exportedDuringDrain: number;
  readonly drainDropDelta: number;
  readonly overflowDropDelta: number;
  readonly expiredDropDelta: number;
  readonly drainTimeAdditionsOrRemovals: number;
}

export interface DbzzTelemetryReport extends DbzzTelemetryTerminalReport {
  readonly localOutput: LocalTelemetryOutputSnapshot;
  readonly drainAccounting: DbzzTelemetryDrainAccounting;
}

interface StreamState {
  readonly decoder: TextDecoder;
  pending: string;
  discarding: boolean;
}

function zeroCounts<const T extends readonly string[]>(values: T): Record<T[number], number> {
  return Object.fromEntries(values.map((value) => [value, 0])) as Record<T[number], number>;
}

function zeroStages(): Record<TelemetryStage, AggregateCell> {
  return Object.fromEntries(
    TELEMETRY_STAGES.map((stage) => [stage, { count: 0, durationMs: 0 }]),
  ) as Record<TelemetryStage, AggregateCell>;
}

function zeroOperations(): Record<BenchmarkOperation, OperationAggregateSummary> {
  return Object.fromEntries(
    BENCHMARK_OPERATIONS.map((operation) => [operation, { count: 0, durationMs: 0, stages: zeroStages() }]),
  ) as Record<BenchmarkOperation, OperationAggregateSummary>;
}

function isMember<const T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === "string" && values.includes(value);
}

function operationOf(record: TelemetryRecord): TelemetryOperation | undefined {
  return record.kind === "metric" ? record.labels.operation : record.operation;
}

function stageOf(record: TelemetryRecord): TelemetryStage | undefined {
  return record.kind === "metric" ? undefined : record.stage;
}

/** Streams child output while retaining only fixed counters and a bounded diagnostic tail. */
export class DbzzOutputCollector {
  private readonly stdout: StreamState = { decoder: new TextDecoder(), pending: "", discarding: false };
  private readonly stderr: StreamState = { decoder: new TextDecoder(), pending: "", discarding: false };
  private readonly encoder = new TextEncoder();
  private readonly controls: Array<{ sequence: number; line: string }> = [];
  private readonly byKind = zeroCounts(["span", "event", "metric"] as const);
  private readonly byOperation = zeroCounts(TELEMETRY_OPERATIONS);
  private readonly byStage = zeroCounts(TELEMETRY_STAGES);
  private tail = "";
  private sequence = 0;
  private records = 0;
  private bytes = 0;
  private invalidRecords = 0;
  private oversizedLines = 0;
  private controlOverflow = 0;
  private peakPendingChars = 0;
  private finished = false;

  writeStdout(chunk: Uint8Array): void {
    this.write(this.stdout, this.stdout.decoder.decode(chunk, { stream: true }), true);
  }

  writeStderr(chunk: Uint8Array): void {
    this.write(this.stderr, this.stderr.decoder.decode(chunk, { stream: true }), false);
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.write(this.stdout, this.stdout.decoder.decode(), true);
    this.write(this.stderr, this.stderr.decoder.decode(), false);
    this.finishStream(this.stdout, true);
    this.finishStream(this.stderr, false);
  }

  output(): string {
    const controls = [...this.controls]
      .sort((left, right) => left.sequence - right.sequence)
      .map(({ line }) => line)
      .join("\n");
    return controls === "" ? this.tail : `${controls}\n${this.tail}`;
  }

  snapshot(): LocalTelemetryOutputSnapshot {
    return Object.freeze({
      records: this.records,
      bytes: this.bytes,
      invalidRecords: this.invalidRecords,
      oversizedLines: this.oversizedLines,
      controlOverflow: this.controlOverflow,
      peakPendingChars: this.peakPendingChars,
      diagnosticTailChars: this.tail.length,
      byKind: Object.freeze({ ...this.byKind }),
      byOperation: Object.freeze({ ...this.byOperation }),
      byStage: Object.freeze({ ...this.byStage }),
    });
  }

  private write(state: StreamState, text: string, telemetry: boolean): void {
    let remaining = text;
    if (state.discarding) {
      const newline = remaining.indexOf("\n");
      if (newline === -1) return;
      state.discarding = false;
      remaining = remaining.slice(newline + 1);
    }
    while (remaining !== "") {
      const newline = remaining.indexOf("\n");
      if (newline === -1) {
        if (state.pending.length + remaining.length > MAX_LINE_CHARS) {
          this.rejectOversizedLine(state, remaining, telemetry, true);
          return;
        }
        state.pending += remaining;
        this.peakPendingChars = Math.max(this.peakPendingChars, state.pending.length);
        return;
      }
      if (state.pending.length + newline > MAX_LINE_CHARS) {
        this.rejectOversizedLine(state, remaining.slice(0, Math.min(newline, RECORD_PREFIX.length)), telemetry, false);
        remaining = remaining.slice(newline + 1);
        continue;
      }
      const line = `${state.pending}${remaining.slice(0, newline)}`.replace(/\r$/, "");
      state.pending = "";
      this.acceptLine(line, telemetry);
      remaining = remaining.slice(newline + 1);
    }
  }

  private rejectOversizedLine(
    state: StreamState,
    next: string,
    telemetry: boolean,
    discarding: boolean,
  ): void {
    const prefix = `${state.pending.slice(0, RECORD_PREFIX.length)}${next.slice(0, RECORD_PREFIX.length)}`
      .slice(0, RECORD_PREFIX.length);
    this.oversizedLines++;
    if (telemetry && prefix === RECORD_PREFIX) this.invalidRecords++;
    state.pending = "";
    state.discarding = discarding;
    this.appendTail("[dbzz output line exceeded the bounded collector]\n");
  }

  private finishStream(state: StreamState, telemetry: boolean): void {
    if (!state.discarding && state.pending !== "") this.acceptLine(state.pending.replace(/\r$/, ""), telemetry);
    state.pending = "";
    state.discarding = false;
  }

  private acceptLine(line: string, telemetry: boolean): void {
    const sequence = this.sequence++;
    if (line.startsWith("@@dbzz-startup ") || line.includes("ready on")) {
      if (line.length > MAX_CONTROL_LINE_CHARS || this.controls.length >= MAX_CONTROL_LINES) {
        this.controlOverflow++;
        this.appendTail("[dbzz control line exceeded the bounded collector]\n");
      } else {
        this.controls.push({ sequence, line });
      }
      return;
    }
    if (telemetry && line.startsWith(RECORD_PREFIX)) {
      if (!this.acceptTelemetry(line)) this.appendTail(`${line.slice(0, 1_024)}\n`);
      return;
    }
    if (line !== "") this.appendTail(`${line}\n`);
  }

  private acceptTelemetry(line: string): boolean {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.invalidRecords++;
      return false;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      this.invalidRecords++;
      return false;
    }
    const candidate = value as Record<string, unknown>;
    if (
      candidate.schemaVersion !== 1 ||
      (candidate.kind !== "span" && candidate.kind !== "event" && candidate.kind !== "metric") ||
      typeof candidate.timestampMs !== "number" ||
      !Number.isFinite(candidate.timestampMs)
    ) {
      this.invalidRecords++;
      return false;
    }
    const record = candidate as unknown as TelemetryRecord;
    let operation: TelemetryOperation | undefined;
    let stage: TelemetryStage | undefined;
    if (record.kind === "span") {
      if (!isMember(TELEMETRY_OPERATIONS, candidate.operation) || !isMember(TELEMETRY_STAGES, candidate.stage)) {
        this.invalidRecords++;
        return false;
      }
      operation = candidate.operation;
      stage = candidate.stage;
    } else if (record.kind === "event") {
      if (
        (candidate.operation !== undefined && !isMember(TELEMETRY_OPERATIONS, candidate.operation)) ||
        (candidate.stage !== undefined && !isMember(TELEMETRY_STAGES, candidate.stage))
      ) {
        this.invalidRecords++;
        return false;
      }
      operation = candidate.operation as TelemetryOperation | undefined;
      stage = candidate.stage as TelemetryStage | undefined;
    } else {
      if (candidate.labels === null || typeof candidate.labels !== "object" || Array.isArray(candidate.labels)) {
        this.invalidRecords++;
        return false;
      }
      const labels = candidate.labels as Record<string, unknown>;
      if (labels.operation !== undefined && !isMember(TELEMETRY_OPERATIONS, labels.operation)) {
        this.invalidRecords++;
        return false;
      }
      operation = labels.operation as TelemetryOperation | undefined;
    }
    if (
      operation !== operationOf(record) ||
      stage !== stageOf(record)
    ) {
      this.invalidRecords++;
      return false;
    }
    const bytes = this.encoder.encode(line).byteLength;
    if (bytes > PRODUCTION_LIMITS.telemetry.maxBytes) {
      this.oversizedLines++;
      this.invalidRecords++;
      return false;
    }
    this.records++;
    this.bytes += bytes;
    this.byKind[record.kind]++;
    if (operation !== undefined) this.byOperation[operation]++;
    if (stage !== undefined) this.byStage[stage]++;
    return true;
  }

  private appendTail(text: string): void {
    this.tail = `${this.tail}${text}`;
    if (this.tail.length > DIAGNOSTIC_TAIL_CHARS) this.tail = this.tail.slice(-DIAGNOSTIC_TAIL_CHARS);
  }
}

export function summarizeTelemetryAggregates(snapshot: TelemetryAggregateSnapshot): BenchmarkAggregateSummary {
  const operations = zeroOperations();
  let spans = 0;
  let durationMs = 0;
  for (const series of snapshot.series) {
    spans += series.count;
    durationMs += series.durationMs;
    if (!isMember(BENCHMARK_OPERATIONS, series.operation)) continue;
    const operation = operations[series.operation];
    (operation as { count: number }).count += series.count;
    (operation as { durationMs: number }).durationMs += series.durationMs;
    if (series.stage === undefined) continue;
    const stage = operation.stages[series.stage];
    (stage as { count: number }).count += series.count;
    (stage as { durationMs: number }).durationMs += series.durationMs;
  }
  for (const operation of BENCHMARK_OPERATIONS) {
    const summary = operations[operation];
    operations[operation] = Object.freeze({
      count: summary.count,
      durationMs: summary.durationMs,
      stages: Object.freeze({ ...summary.stages }),
    });
  }
  return Object.freeze({
    maxSeries: snapshot.maxSeries,
    overflowedRecords: snapshot.overflowedRecords,
    spans,
    durationMs,
    operations: Object.freeze(operations),
  });
}

export function createDbzzTelemetryReport(
  startupMode: DbzzStartupMode,
  beforeDrain: TelemetrySnapshot,
  afterDrain: TelemetrySnapshot,
  aggregates: TelemetryAggregateSnapshot,
): DbzzTelemetryTerminalReport {
  return Object.freeze({
    schemaVersion: 1,
    startupMode,
    runtime: Object.freeze({ beforeDrain, afterDrain }),
    aggregates: summarizeTelemetryAggregates(aggregates),
  });
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function finiteNonNegative(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be finite and non-negative`);
  }
  return value;
}

function safeCount(value: unknown, label: string): number {
  const number = finiteNonNegative(value, label);
  if (!Number.isSafeInteger(number)) throw new Error(`${label} must be a safe integer`);
  return number;
}

function assertFixedCounts<T extends readonly string[]>(value: unknown, keys: T, label: string): void {
  const counts = record(value, label);
  if (Object.keys(counts).sort().join(",") !== [...keys].sort().join(",")) {
    throw new Error(`${label} must contain the exact bounded dimension set`);
  }
  for (const key of keys) safeCount(counts[key], `${label}.${key}`);
}

function assertExporterUnconfigured(snapshot: TelemetrySnapshot, label: string): void {
  const exporter = snapshot.exporter;
  if (
    exporter.configured ||
    exporter.inFlight ||
    exporter.attempts !== 0 ||
    exporter.failures !== 0 ||
    exporter.timeouts !== 0 ||
    exporter.exportedRecords !== 0 ||
    exporter.failedRecords !== 0 ||
    exporter.aggregateSnapshotPending ||
    exporter.exportedAggregateSnapshots !== 0 ||
    exporter.failedAggregateSnapshots !== 0 ||
    exporter.lastSuccessAtMs !== undefined ||
    exporter.lastFailureAtMs !== undefined ||
    exporter.lastDurationMs !== undefined
  ) {
    throw new Error(`${label} unexpectedly configured or used an exporter`);
  }
}

function assertExporterConfigured(snapshot: TelemetrySnapshot, label: string, drained: boolean): void {
  const exporter = snapshot.exporter;
  const attempts = safeCount(exporter.attempts, `${label}.attempts`);
  const exportedRecords = safeCount(exporter.exportedRecords, `${label}.exportedRecords`);
  const exportedAggregateSnapshots = safeCount(
    exporter.exportedAggregateSnapshots,
    `${label}.exportedAggregateSnapshots`,
  );
  safeCount(exporter.failures, `${label}.failures`);
  safeCount(exporter.timeouts, `${label}.timeouts`);
  safeCount(exporter.failedRecords, `${label}.failedRecords`);
  safeCount(exporter.failedAggregateSnapshots, `${label}.failedAggregateSnapshots`);
  if (exporter.lastSuccessAtMs !== undefined) {
    finiteNonNegative(exporter.lastSuccessAtMs, `${label}.lastSuccessAtMs`);
  }
  if (exporter.lastDurationMs !== undefined) {
    finiteNonNegative(exporter.lastDurationMs, `${label}.lastDurationMs`);
  }
  if (
    !exporter.configured ||
    exporter.failures !== 0 ||
    exporter.timeouts !== 0 ||
    exporter.failedRecords !== 0 ||
    exporter.failedAggregateSnapshots !== 0 ||
    typeof exporter.aggregateSnapshotPending !== "boolean" ||
    exporter.lastFailureAtMs !== undefined ||
    (drained && (
      exporter.inFlight ||
      exporter.aggregateSnapshotPending ||
      attempts === 0 ||
      exportedRecords === 0 ||
      exportedAggregateSnapshots === 0 ||
      exporter.lastSuccessAtMs === undefined ||
      exporter.lastDurationMs === undefined
    ))
  ) {
    throw new Error(`${label} did not complete healthy benchmark exports`);
  }
}

function assertAllDisabled(value: unknown, label: string): void {
  if (typeof value === "number") {
    if (value !== 0) throw new Error(`${label} must remain zero while telemetry is disabled`);
    return;
  }
  if (typeof value === "boolean") {
    if (value) throw new Error(`${label} must remain false while telemetry is disabled`);
    return;
  }
  if (value === undefined) return;
  for (const [key, child] of Object.entries(record(value, label))) assertAllDisabled(child, `${label}.${key}`);
}

function assertAggregateShape(value: unknown): BenchmarkAggregateSummary {
  const aggregate = record(value, "dbzz telemetry report.aggregates");
  for (const key of ["maxSeries", "overflowedRecords", "spans"] as const) {
    safeCount(aggregate[key], `dbzz telemetry report.aggregates.${key}`);
  }
  finiteNonNegative(aggregate.durationMs, "dbzz telemetry report.aggregates.durationMs");
  const operations = record(aggregate.operations, "dbzz telemetry report.aggregates.operations");
  if (Object.keys(operations).sort().join(",") !== [...BENCHMARK_OPERATIONS].sort().join(",")) {
    throw new Error("dbzz telemetry aggregate operations must contain the exact benchmark matrix");
  }
  for (const operation of BENCHMARK_OPERATIONS) {
    const summary = record(operations[operation], `dbzz telemetry report.aggregates.operations.${operation}`);
    safeCount(summary.count, `aggregate ${operation} count`);
    finiteNonNegative(summary.durationMs, `aggregate ${operation} duration`);
    const stages = record(summary.stages, `aggregate ${operation} stages`);
    if (Object.keys(stages).sort().join(",") !== [...TELEMETRY_STAGES].sort().join(",")) {
      throw new Error(`aggregate ${operation} stages must contain the exact stage matrix`);
    }
    for (const stage of TELEMETRY_STAGES) {
      const cell = record(stages[stage], `aggregate ${operation}.${stage}`);
      safeCount(cell.count, `aggregate ${operation}.${stage}.count`);
      finiteNonNegative(cell.durationMs, `aggregate ${operation}.${stage}.durationMs`);
    }
  }
  return value as BenchmarkAggregateSummary;
}

function validateLocalOutput(value: LocalTelemetryOutputSnapshot): void {
  for (const key of [
    "records",
    "bytes",
    "invalidRecords",
    "oversizedLines",
    "controlOverflow",
    "peakPendingChars",
    "diagnosticTailChars",
  ] as const) {
    safeCount(value[key], `dbzz local output.${key}`);
  }
  assertFixedCounts(value.byKind, ["span", "event", "metric"] as const, "dbzz local output.byKind");
  assertFixedCounts(value.byOperation, TELEMETRY_OPERATIONS, "dbzz local output.byOperation");
  assertFixedCounts(value.byStage, TELEMETRY_STAGES, "dbzz local output.byStage");
  if (value.byKind.span + value.byKind.event + value.byKind.metric !== value.records) {
    throw new Error("dbzz local telemetry output accounting does not balance");
  }
  if (value.peakPendingChars > MAX_LINE_CHARS || value.diagnosticTailChars > DIAGNOSTIC_TAIL_CHARS) {
    throw new Error("dbzz output collector exceeded its fixed memory bounds");
  }
}

export function parseDbzzTelemetryReport(
  output: string,
  expected: DbzzStartupMode,
  localOutput: LocalTelemetryOutputSnapshot,
): DbzzTelemetryReport {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch (error) {
    throw new Error("dbzz telemetry report is not valid JSON", { cause: error });
  }
  const terminal = record(value, "dbzz telemetry report");
  if (Object.keys(terminal).sort().join(",") !== "aggregates,runtime,schemaVersion,startupMode") {
    throw new Error("dbzz telemetry report has an unexpected shape");
  }
  if (terminal.schemaVersion !== 1) throw new Error("dbzz telemetry report has an unsupported schema version");
  if (JSON.stringify(terminal.startupMode) !== JSON.stringify(expected)) {
    throw new Error("dbzz telemetry report does not match the server-confirmed startup mode");
  }
  const runtime = record(terminal.runtime, "dbzz telemetry report.runtime");
  const beforeDrain = runtime.beforeDrain as TelemetrySnapshot;
  const afterDrain = runtime.afterDrain as TelemetrySnapshot;
  record(beforeDrain, "dbzz telemetry report.runtime.beforeDrain");
  record(afterDrain, "dbzz telemetry report.runtime.afterDrain");
  const aggregates = assertAggregateShape(terminal.aggregates);
  validateLocalOutput(localOutput);

  let drainAccounting: DbzzTelemetryDrainAccounting;
  if (expected.telemetry === "disabled") {
    assertAllDisabled(beforeDrain, "disabled telemetry beforeDrain");
    assertAllDisabled(afterDrain, "disabled telemetry afterDrain");
    assertAllDisabled(aggregates, "disabled telemetry aggregates");
    if (
      localOutput.records !== 0 ||
      localOutput.bytes !== 0 ||
      localOutput.invalidRecords !== 0 ||
      localOutput.oversizedLines !== 0 ||
      Object.values(localOutput.byKind).some((count) => count !== 0) ||
      Object.values(localOutput.byOperation).some((count) => count !== 0) ||
      Object.values(localOutput.byStage).some((count) => count !== 0)
    ) {
      throw new Error("disabled telemetry profile produced local telemetry output");
    }
    drainAccounting = Object.freeze({
      retainedBeforeDrain: 0,
      exportedDuringDrain: 0,
      drainDropDelta: 0,
      overflowDropDelta: 0,
      expiredDropDelta: 0,
      drainTimeAdditionsOrRemovals: 0,
    });
  } else {
    if (!beforeDrain.enabled || !afterDrain.enabled) throw new Error("enabled telemetry reported disabled");
    if (expected.exporter === "benchmark-in-process") {
      assertExporterConfigured(beforeDrain, "benchmark exporter beforeDrain", false);
      assertExporterConfigured(afterDrain, "benchmark exporter afterDrain", true);
      if (
        afterDrain.dropped.exporter !== 0 ||
        afterDrain.dropped.overflow !== 0 ||
        afterDrain.dropped.expired !== 0 ||
        afterDrain.dropped.drain !== 0
      ) {
        throw new Error("benchmark exporter dropped retained telemetry records");
      }
    } else {
      assertExporterUnconfigured(beforeDrain, "default telemetry beforeDrain");
      assertExporterUnconfigured(afterDrain, "default telemetry afterDrain");
    }
    if (!beforeDrain.localSink.configured || !afterDrain.localSink.configured) {
      throw new Error("default telemetry did not configure its console local sink");
    }
    if (
      afterDrain.localSink.inFlight ||
      afterDrain.localSink.pendingRecords !== 0 ||
      afterDrain.localSink.pendingBytes !== 0 ||
      afterDrain.localSink.failures !== 0 ||
      afterDrain.localSink.timeouts !== 0 ||
      afterDrain.localSink.dropped.failure !== 0 ||
      afterDrain.localSink.dropped.drain !== 0
    ) {
      throw new Error("default telemetry local sink did not drain cleanly");
    }
    if (
      localOutput.records === 0 ||
      localOutput.byKind.span === 0 ||
      localOutput.byKind.event === 0 ||
      beforeDrain.metricSeries === 0
    ) {
      throw new Error("default telemetry emitted no useful local span/event output or metric series");
    }
    if (
      localOutput.invalidRecords !== 0 ||
      localOutput.oversizedLines !== 0 ||
      localOutput.controlOverflow !== 0 ||
      afterDrain.localSink.deliveredRecords !== localOutput.records
    ) {
      throw new Error("default telemetry local output failed validation or delivery accounting");
    }
    if (
      beforeDrain.queuedRecords < 0 ||
      beforeDrain.queuedBytes < 0 ||
      beforeDrain.localSink.pendingRecords < 0 ||
      beforeDrain.localSink.pendingBytes < 0 ||
      beforeDrain.queuedRecords > expected.telemetryLimits!.maxRecords ||
      beforeDrain.queuedBytes > expected.telemetryLimits!.maxBytes ||
      beforeDrain.localSink.pendingRecords > expected.telemetryLimits!.maxRecords ||
      beforeDrain.localSink.pendingBytes > expected.telemetryLimits!.maxBytes ||
      afterDrain.queuedRecords !== 0 ||
      afterDrain.queuedBytes !== 0
    ) {
      throw new Error("default telemetry exceeded or failed to drain a configured queue bound");
    }
    const beforeTrace = beforeDrain.traceRetention;
    const trace = afterDrain.traceRetention;
    if (
      beforeTrace.maxTraces !== expected.telemetryLimits!.maxRecords ||
      beforeTrace.maxStagedRecords !== expected.telemetryLimits!.maxRecords ||
      beforeTrace.maxStagedBytes !== expected.telemetryLimits!.maxBytes ||
      beforeTrace.decisionRetentionMs !== expected.telemetryLimits!.retentionMs ||
      trace.maxTraces !== expected.telemetryLimits!.maxRecords ||
      trace.maxStagedRecords !== expected.telemetryLimits!.maxRecords ||
      trace.maxStagedBytes !== expected.telemetryLimits!.maxBytes ||
      trace.decisionRetentionMs !== expected.telemetryLimits!.retentionMs ||
      trace.activeTraces !== 0 ||
      trace.completedDecisions !== 0 ||
      trace.stagedRecords !== 0 ||
      trace.stagedBytes !== 0
    ) {
      throw new Error("default telemetry trace retention bounds or terminal state are invalid");
    }
    if (
      beforeTrace.activeTraces < 0 ||
      beforeTrace.completedDecisions < 0 ||
      beforeTrace.activeTraces + beforeTrace.completedDecisions > beforeTrace.maxTraces ||
      beforeTrace.stagedRecords < 0 ||
      beforeTrace.stagedRecords > beforeTrace.maxStagedRecords ||
      beforeTrace.stagedBytes < 0 ||
      beforeTrace.stagedBytes > beforeTrace.maxStagedBytes
    ) {
      throw new Error("default telemetry trace retention exceeded a configured bound");
    }
    const applicable: Readonly<Record<BenchmarkOperation, TelemetryStage>> = {
      query: "queue",
      mutation: "queue",
      procedure: "admission",
      subscription: "queue",
    };
    for (const operation of BENCHMARK_OPERATIONS) {
      if (aggregates.operations[operation].count === 0) {
        throw new Error(`default telemetry did not aggregate ${operation}`);
      }
      const stage = applicable[operation];
      if (aggregates.operations[operation].stages[stage].count === 0) {
        throw new Error(`default telemetry did not aggregate ${operation}.${stage}`);
      }
    }
    const drainDropDelta = afterDrain.dropped.drain - beforeDrain.dropped.drain;
    const overflowDropDelta = afterDrain.dropped.overflow - beforeDrain.dropped.overflow;
    const expiredDropDelta = afterDrain.dropped.expired - beforeDrain.dropped.expired;
    const exportedDuringDrain = afterDrain.exporter.exportedRecords - beforeDrain.exporter.exportedRecords;
    const accounted = exportedDuringDrain + drainDropDelta + overflowDropDelta + expiredDropDelta;
    if (
      exportedDuringDrain < 0 ||
      drainDropDelta < 0 ||
      overflowDropDelta < 0 ||
      expiredDropDelta < 0 ||
      accounted < beforeDrain.queuedRecords
    ) {
      throw new Error("enabled telemetry terminal export/drop accounting does not cover the pre-drain queue");
    }
    drainAccounting = Object.freeze({
      retainedBeforeDrain: beforeDrain.queuedRecords,
      exportedDuringDrain,
      drainDropDelta,
      overflowDropDelta,
      expiredDropDelta,
      drainTimeAdditionsOrRemovals: accounted - beforeDrain.queuedRecords,
    });
  }

  return Object.freeze({
    ...(value as DbzzTelemetryTerminalReport),
    localOutput,
    drainAccounting,
  });
}

export function workloadTelemetryLowerBounds(workload: DriverResult): Readonly<Record<BenchmarkOperation, number>> {
  const attempts = (operation: DriverResult["operations"][number]["operation"]): number =>
    workload.operations
      .filter((result) => result.operation === operation)
      .flatMap((result) => result.trials)
      .reduce((sum, trial) => sum + trial.attempted, 0);
  return Object.freeze({
    query: attempts("query"),
    mutation: attempts("mutation-uncontended") + attempts("mutation-contended"),
    procedure: attempts("procedure"),
    subscription: workload.subscriptions.reduce((sum, result) => sum + result.distinctQueryArguments, 0),
  });
}

export function assertDbzzTelemetryWorkload(
  report: DbzzTelemetryReport,
  workload: DriverResult,
): void {
  if (report.startupMode.telemetry === "disabled") return;
  const lowerBounds = workloadTelemetryLowerBounds(workload);
  const stages: Readonly<Record<BenchmarkOperation, TelemetryStage>> = {
    query: "queue",
    mutation: "queue",
    procedure: "admission",
    subscription: "queue",
  };
  for (const operation of BENCHMARK_OPERATIONS) {
    const observed = report.aggregates.operations[operation];
    const lowerBound = lowerBounds[operation];
    if (observed.count < lowerBound || observed.stages[stages[operation]].count < lowerBound) {
      throw new Error(
        `dbzz telemetry ${operation}.${stages[operation]} count ${observed.stages[stages[operation]].count} is below benchmark workload lower bound ${lowerBound}`,
      );
    }
  }
}
