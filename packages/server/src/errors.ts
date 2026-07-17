import type { OutcomeCode, ResourceClass } from "@dbzz/core";

export class IncompatibleDatabaseError extends Error {}
export class CorruptDatabaseError extends Error {}

export type DbzzErrorCode = OutcomeCode;
export type { ResourceClass } from "@dbzz/core";

export interface DbzzErrorOptions {
  retryable?: boolean;
  retryAfterMs?: number;
  resource?: ResourceClass;
  committed?: true;
  cause?: unknown;
}

/** A safe, transport-independent framework failure. `message` is public. */
export class DbzzError extends Error {
  readonly code: DbzzErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  readonly resource: ResourceClass | undefined;
  readonly committed: true | undefined;

  constructor(code: DbzzErrorCode, message: string, options: DbzzErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    if (
      options.retryAfterMs !== undefined &&
      (!Number.isInteger(options.retryAfterMs) || options.retryAfterMs < 0 || options.retryAfterMs > 30_000)
    ) {
      throw new TypeError("retryAfterMs must be an integer from 0 through 30000");
    }
    if (options.retryAfterMs !== undefined && options.retryable !== true) {
      throw new TypeError("retryAfterMs requires retryable: true");
    }
    if (options.committed !== undefined && code !== "convergence_unavailable") {
      throw new TypeError("committed is valid only for convergence_unavailable");
    }
    if (code === "convergence_unavailable" && (options.committed !== true || options.retryable === true)) {
      throw new TypeError("convergence_unavailable must be committed and non-retryable");
    }
    this.name = "DbzzError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
    this.resource = options.resource;
    this.committed = options.committed;
  }
}

export function isDbzzError(value: unknown): value is DbzzError {
  return value instanceof DbzzError;
}
