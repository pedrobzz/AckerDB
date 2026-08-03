import type { TelemetryRecord } from "../contracts/types.ts";

export const MAX_LINKS = 32;
export const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
export const SAFE_ERROR_CLASS = /^[A-Za-z][A-Za-z0-9_.]{0,79}$/;
export const OVERFLOW_METRIC_NAME = "telemetry.cardinality_overflow";
export const OVERFLOW_SERIES = `${OVERFLOW_METRIC_NAME}|count|telemetry|overflow`;
export const TASK_OK = Symbol("task-ok");
export const TASK_FAILED = Symbol("task-failed");
export const TASK_TIMED_OUT = Symbol("task-timed-out");
export const TASK_DEADLINE = Symbol("task-deadline");
export const EMPTY_RECORDS: readonly TelemetryRecord[] = Object.freeze([]);
export const UUID_LENGTH = 36;
export const NO_SLOT = -1;


