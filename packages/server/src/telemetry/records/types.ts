import type {
  TelemetryLink,
  TelemetryRecord,
  TelemetryRecordContext,
} from "../contracts/types.ts";
import type {
  TelemetryOperation,
  TelemetryOutcome,
  TelemetryResource,
  TelemetryStage,
} from "../contracts/schema.ts";

export interface BufferedRecord {
  readonly record: TelemetryRecord;
  readonly bytes: number;
  readonly retainedAtMs: number;
}

export interface BufferedLocalLine {
  readonly line: string;
  readonly bytes: number;
  readonly retainedAtMs: number;
}

export interface EncodedRecord {
  readonly line: string;
  readonly bytes: number;
}

export type JsonSpanPrimitive = string | number | boolean;

export interface SanitizedTelemetrySpan {
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


