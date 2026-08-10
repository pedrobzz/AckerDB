import type { Outcome } from "@ackerdb/core";
import { AckerDBError, isAckerDBError } from "../../shared/errors.ts";

export function isAuthFailure(outcome: Outcome): boolean {
  return outcome.code === "auth_stale" ||
    outcome.code === "auth_unavailable" ||
    outcome.code === "unauthenticated" ||
    outcome.code === "unauthorized";
}

export function authOutcome(code: "auth_stale" | "unauthorized", message: string): Outcome {
  return Object.freeze({ code, retryable: false, message });
}

export function overloadOutcome(message: string): Outcome {
  return Object.freeze({
    code: "overloaded",
    retryable: true,
    retryAfterMs: 0,
    resource: "subscription",
    message,
  });
}

export function errorOutcome(error: unknown): Outcome {
  if (isAckerDBError(error)) {
    return Object.freeze({
      code: error.code,
      retryable: error.retryable,
      message: error.message.slice(0, 512),
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
      ...(error.resource === undefined ? {} : { resource: error.resource }),
      ...(error.committed === undefined ? {} : { committed: error.committed }),
    });
  }
  return Object.freeze({ code: "internal", retryable: false, message: "Subscription evaluation failed" });
}

export function overloaded(message: string): AckerDBError {
  return new AckerDBError("overloaded", message, {
    retryable: true,
    retryAfterMs: 0,
    resource: "subscription",
  });
}

export function unavailable(message: string): AckerDBError {
  return new AckerDBError("unavailable", message, { resource: "subscription" });
}
