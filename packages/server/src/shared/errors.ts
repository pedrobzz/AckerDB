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

/** How long a client should wait before retrying work refused during a drain. */
export const DRAIN_RETRY_AFTER_MS = 1_000;

/** A refusal that only lasts as long as the drain: always retryable, always bounded. */
export function drainingError(message: string, resource: ResourceClass): AckerDBError {
  return new AckerDBError("draining", message, {
    retryable: true,
    retryAfterMs: DRAIN_RETRY_AFTER_MS,
    resource,
  });
}

/** Preserve framework abort reasons and normalize every external cancellation. */
export function cancellation(reason: unknown): AckerDBError {
  return isAckerDBError(reason)
    ? reason
    : new AckerDBError("unavailable", "operation was canceled", {
        resource: "operation",
        cause: reason,
      });
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw cancellation(signal.reason);
}
