import {
  TELEMETRY_OPERATIONS,
  TELEMETRY_OUTCOMES,
  TELEMETRY_RESOURCES,
  TELEMETRY_STAGES,
  type TelemetryOperation,
  type TelemetryOutcome,
  type TelemetryResource,
  type TelemetryStage,
} from "../contracts/schema.ts";
import type {
  TelemetryAggregateSeries,
  TelemetryAggregateSnapshot,
} from "../contracts/types.ts";

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

function labelCodes<Label extends string>(labels: readonly Label[]): Readonly<Record<Label, number>> {
  const codes = Object.create(null) as Record<Label, number>;
  for (let index = 0; index < labels.length; index++) codes[labels[index]!] = index;
  return codes;
}

const OPERATION_CODES = labelCodes(TELEMETRY_OPERATIONS);
const STAGE_CODES = labelCodes(TELEMETRY_STAGES);
const OUTCOME_CODES = labelCodes(TELEMETRY_OUTCOMES);
const RESOURCE_CODES = labelCodes(TELEMETRY_RESOURCES);
const RESOURCE_CARDINALITY = TELEMETRY_RESOURCES.length + 1;

function boundedCount(value: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, value + 1);
}

function boundedSum(left: number, right: number): number {
  const sum = left + right;
  return Number.isFinite(sum) ? sum : Number.MAX_VALUE;
}

function add(
  aggregate: MutableAggregate,
  key: "sizeBytes" | "rowCount" | "resultCount" | "dependencyCount",
  value: number | undefined,
): void {
  if (value !== undefined) {
    aggregate[key] = Math.min(Number.MAX_SAFE_INTEGER, (aggregate[key] ?? 0) + value);
  }
}

function freeze(aggregate: MutableAggregate): TelemetryAggregateSeries {
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

/** Owns bounded aggregate cardinality and exporter snapshot handoff. */
export class TelemetryAggregation {
  private readonly byLabels = new Map<number, Map<string | undefined, MutableAggregate>>();
  private readonly order: MutableAggregate[] = [];
  private readonly overflow: MutableAggregate = { overflow: true, count: 0, durationMs: 0 };
  private dirty = false;
  private exportInFlight = false;
  private overflowedRecords = 0;

  constructor(private readonly maxSeries: number) {}

  record(
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
    const code = (((OPERATION_CODES[operation] * TELEMETRY_STAGES.length +
      STAGE_CODES[stage]) * TELEMETRY_OUTCOMES.length +
      OUTCOME_CODES[outcome]) * RESOURCE_CARDINALITY) +
      (resource === undefined ? 0 : RESOURCE_CODES[resource] + 1);
    let functions = this.byLabels.get(code);
    let aggregate = functions?.get(functionName);
    if (!aggregate) {
      if (this.order.length >= this.maxSeries - 1) {
        aggregate = this.overflow;
        this.overflowedRecords = boundedCount(this.overflowedRecords);
      } else {
        aggregate = {
          operation,
          stage,
          outcome,
          function: functionName,
          resource,
          count: 0,
          durationMs: 0,
        };
        if (!functions) {
          functions = new Map();
          this.byLabels.set(code, functions);
        }
        functions.set(functionName, aggregate);
        this.order.push(aggregate);
      }
    }
    aggregate.count = boundedCount(aggregate.count);
    aggregate.durationMs = boundedSum(aggregate.durationMs, durationMs);
    add(aggregate, "sizeBytes", sizeBytes);
    add(aggregate, "rowCount", rowCount);
    add(aggregate, "resultCount", resultCount);
    add(aggregate, "dependencyCount", dependencyCount);
    this.dirty = true;
  }

  snapshot(): TelemetryAggregateSnapshot {
    const series = this.order.map(freeze);
    if (this.overflow.count > 0) series.push(freeze(this.overflow));
    return Object.freeze({
      maxSeries: this.maxSeries,
      overflowedRecords: this.overflowedRecords,
      series: Object.freeze(series),
    });
  }

  takeChangedSnapshot(): TelemetryAggregateSnapshot | undefined {
    if (!this.dirty) return undefined;
    this.dirty = false;
    this.exportInFlight = true;
    return this.snapshot();
  }

  finishExport(success: boolean): void {
    this.exportInFlight = false;
    if (!success) this.dirty = true;
  }

  hasPendingExport(): boolean {
    return this.dirty || this.exportInFlight;
  }

  hasDirtySnapshot(): boolean {
    return this.dirty;
  }

  isExporting(): boolean {
    return this.exportInFlight;
  }
}
