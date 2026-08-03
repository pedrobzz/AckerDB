import { AckerDBError } from "../../shared/errors.ts";

/** Retryable outbound-delivery failures shared by both bounded transports. */
export function slowConsumer(resource: "outbound" | "sse", message: string): AckerDBError {
  return new AckerDBError("slow_consumer", message, { retryable: true, resource });
}

export function overloaded(resource: "outbound" | "sse", message: string): AckerDBError {
  return new AckerDBError("overloaded", message, { retryable: true, resource });
}

export function unavailable(resource: "outbound" | "sse", message: string): AckerDBError {
  return new AckerDBError("unavailable", message, { retryable: true, resource });
}
