import type { TelemetryMetadata } from "./value.ts";
import type { Identity } from "@ackerdb/core";

export type ApplicationLogLevel = "debug" | "info" | "warn" | "error";

/** Producer of one journal log row: application `ctx.log` or a framework event. */
export type ApplicationLogSource = "app" | "framework";

export interface ApplicationLogger {
  debug(message: string, metadata?: TelemetryMetadata): void;
  info(message: string, metadata?: TelemetryMetadata): void;
  warn(message: string, metadata?: TelemetryMetadata): void;
  error(message: string, metadata?: TelemetryMetadata): void;
}

export interface AnalyticsTracker {
  track(event: string, properties?: TelemetryMetadata): void;
}

export interface ApplicationLogRecord {
  readonly kind: "log";
  readonly processGeneration: string;
  readonly sequence: bigint;
  readonly timestamp: number;
  readonly level: ApplicationLogLevel;
  readonly source: ApplicationLogSource;
  readonly message: string;
  readonly metadata?: TelemetryMetadata;
  readonly truncated: boolean;
  readonly malformed: boolean;
  readonly functionAddress: string;
  readonly functionKind: string;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly requestId?: string;
}

export interface AnalyticsEventRecord {
  readonly kind: "analytics";
  readonly processGeneration: string;
  readonly sequence: bigint;
  readonly timestamp: number;
  readonly event: string;
  readonly properties?: TelemetryMetadata;
  readonly identity?: Identity;
  readonly truncated: boolean;
  readonly malformed: boolean;
  readonly functionAddress: string;
  readonly functionKind: string;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly requestId?: string;
  readonly commitId?: string;
}

export type TelemetryJournalRecord = ApplicationLogRecord | AnalyticsEventRecord;
export type TelemetryJournalEntry = TelemetryJournalRecord & { readonly id: bigint };

export interface ApplicationLogCallContext {
  readonly functionAddress: string;
  readonly functionKind: string;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly requestId?: string;
}
