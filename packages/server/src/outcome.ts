import { ProtocolError, type Outcome } from "@dbzz/core";
import { AdmissionRejected } from "./admission.ts";
import { ValidationError } from "./dbz.ts";
import { DbzzError } from "./errors.ts";

function boundedMessage(message: string): string {
  return message.length <= 512 ? message : `${message.slice(0, 509)}...`;
}

/** Convert every owning failure boundary to the one safe transport contract. */
export function outcomeFromError(error: unknown): Outcome {
  if (error instanceof DbzzError) {
    return {
      code: error.code,
      retryable: error.retryable,
      message: boundedMessage(error.message),
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
      ...(error.resource === undefined ? {} : { resource: error.resource }),
      ...(error.committed === undefined ? {} : { committed: error.committed }),
    };
  }
  if (error instanceof ProtocolError) {
    return { code: error.code, retryable: false, message: boundedMessage(error.message) };
  }
  if (error instanceof ValidationError) {
    return { code: "validation", retryable: false, message: boundedMessage(error.message) };
  }
  if (error instanceof AdmissionRejected) {
    return {
      code: error.code,
      retryable: error.retryable,
      message: boundedMessage(error.message),
      resource: error.resource,
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
    };
  }
  return { code: "internal", retryable: false, message: "internal server error" };
}

export function outcomeHttpStatus(outcome: Outcome): number {
  switch (outcome.code) {
    case "malformed":
    case "validation":
    case "unsupported_protocol":
      return 400;
    case "unauthenticated":
    case "auth_stale":
      return 401;
    case "unauthorized":
      return 403;
    case "not_found":
      return 404;
    case "conflict":
      return 409;
    case "overloaded":
      return outcome.resource === "publication" || outcome.resource === "connection" ? 503 : 429;
    case "slow_consumer":
      return 429;
    case "auth_unavailable":
    case "draining":
    case "unavailable":
      return 503;
    case "deadline_exceeded":
      return 504;
    case "convergence_unavailable":
    case "indeterminate":
    case "internal":
      return 500;
  }
}

export function outcomeWebSocketClose(outcome: Outcome): 1002 | 1008 | 1013 {
  if (outcome.code === "malformed" || outcome.code === "unsupported_protocol") return 1002;
  if (
    outcome.code === "overloaded" ||
    outcome.code === "slow_consumer" ||
    outcome.code === "draining" ||
    outcome.code === "unavailable"
  ) {
    return 1013;
  }
  return 1008;
}
