import type { OutcomeCode, ResourceClass } from "@ackerdb/core";
import { brand, hasBrand } from "./identity.ts";

const ACKERDB_ERROR_IDENTITY = Symbol.for("@ackerdb/server/AckerDBError/v1");

export class IncompatibleDatabaseError extends Error {}
export class CorruptDatabaseError extends Error {}

export type AckerDBErrorCode = OutcomeCode;
export type { ResourceClass } from "@ackerdb/core";

export interface AckerDBErrorOptions {
  retryable?: boolean;
  retryAfterMs?: number;
  resource?: ResourceClass;
  committed?: true;
  cause?: unknown;
}

/** A safe, transport-independent framework failure. `message` is public. */
export class AckerDBError extends Error {
  readonly code: AckerDBErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  readonly resource: ResourceClass | undefined;
  readonly committed: true | undefined;

  constructor(code: AckerDBErrorCode, message: string, options: AckerDBErrorOptions = {}) {
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
    this.name = "AckerDBError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
    this.resource = options.resource;
    this.committed = options.committed;
    brand(this, ACKERDB_ERROR_IDENTITY);
  }
}

export function isAckerDBError(value: unknown): value is AckerDBError {
  return hasBrand(value, ACKERDB_ERROR_IDENTITY);
}

/** Preserve framework abort reasons and normalize every external cancellation. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw isAckerDBError(signal.reason)
    ? signal.reason
    : new AckerDBError("unavailable", "operation was canceled", {
        resource: "operation",
        cause: signal.reason,
      });
}
