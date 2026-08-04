export const TELEMETRY_SCHEMA_VERSION = 1 as const;

export const TELEMETRY_OPERATIONS = [
  "query",
  "mutation",
  "procedure",
  "system",
  "sse",
  "transaction",
  "scheduled",
  "job",
  "subscription",
  "realtime",
  "backup",
  "restore",
  "lifecycle",
] as const;
export type TelemetryOperation = (typeof TELEMETRY_OPERATIONS)[number];

export const TELEMETRY_STAGES = [
  "boundary",
  "admission",
  "auth",
  "policy",
  "configuration",
  "signaling",
  "ice",
  "dtls",
  "data-channel",
  "handler",
  "execution",
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
  "application_error",
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
  "job_claimed",
  "job_settled",
  "job_retried",
  "job_discarded",
  "job_canceled",
  "job_failure",
] as const;
export type TelemetryEventName = (typeof TELEMETRY_EVENT_NAMES)[number];
export type TelemetryLevel = "info" | "warn" | "error";
export type TelemetryLifecycleState = "starting" | "ready" | "draining" | "stopped" | "failed";
export type TelemetryMetricUnit = "count" | "milliseconds" | "bytes" | "ratio" | "gauge";
