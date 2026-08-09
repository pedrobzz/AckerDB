import { ProtocolError, type Outcome } from "@ackerdb/core";
import { isValidationError } from "../validation/error.ts";
import { isAckerDBError } from "../shared/errors.ts";

export const PUBLIC_ERROR_FALLBACK = "err";
const MAX_PUBLIC_MESSAGE_UNITS = 512;

export interface FittedOutcome<T> {
  readonly value: T;
  readonly bytes: number;
}

function codePointPrefix(value: string, maxUnits: number): string {
  let result = "";
  for (const character of value) {
    if (result.length + character.length > maxUnits) break;
    result += character;
  }
  return result;
}

function boundedMessage(message: string): string {
  if (message.length === 0) return PUBLIC_ERROR_FALLBACK;
  return message.length <= MAX_PUBLIC_MESSAGE_UNITS
    ? message
    : `${codePointPrefix(message, MAX_PUBLIC_MESSAGE_UNITS - 3)}...`;
}

/** Fits one parser-valid public outcome without splitting Unicode code points. */
export function fitOutcome<T>(
  outcome: Outcome,
  maxBytes: number,
  encodeOutcome: (candidate: Outcome) => FittedOutcome<T>,
): FittedOutcome<T> | null {
  const withMessage = (message: string) => encodeOutcome({ ...outcome, message });
  const message = outcome.message.length === 0 ? PUBLIC_ERROR_FALLBACK : outcome.message;
  const complete = withMessage(message);
  if (complete.bytes <= maxBytes) return complete;

  let best = withMessage(PUBLIC_ERROR_FALLBACK);
  if (best.bytes > maxBytes) return null;
  const characters = [...message];
  let low = 1;
  let high = characters.length - 1;
  while (low <= high) {
    const length = low + Math.floor((high - low) / 2);
    const candidate = withMessage(`${characters.slice(0, length).join("")}…`);
    if (candidate.bytes <= maxBytes) {
      best = candidate;
      low = length + 1;
    } else {
      high = length - 1;
    }
  }
  return best;
}

/** Convert every owning failure boundary to the one safe transport contract. */
export function outcomeFromError(error: unknown): Outcome {
  if (isAckerDBError(error)) {
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
  if (isValidationError(error)) {
    return { code: "validation", retryable: false, message: boundedMessage(error.message) };
  }
  return { code: "internal", retryable: false, message: "internal server error" };
}

export function outcomeHttpStatus(outcome: Outcome): number {
  switch (outcome.code) {
    case "malformed":
    case "validation":
    case "version_mismatch":
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
  if (outcome.code === "malformed" || outcome.code === "version_mismatch") return 1002;
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
