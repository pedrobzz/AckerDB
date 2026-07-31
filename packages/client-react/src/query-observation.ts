import { AckerDBClientError } from "@ackerdb/client";
import {
  WireError,
  stableEncode,
  type ApplicationError,
} from "@ackerdb/core";

/** Disables query-shaped demand without inventing an empty argument value. */
export const skip: unique symbol = Symbol("ackerdb.query.skip");

export type ApplicationErrorState<Error extends ApplicationError> =
  [Error] extends [never]
    ? never
    : {
      readonly status: "application-error";
      readonly data: undefined;
      readonly error: Error;
      readonly loading: false;
    };

/**
 * Exhaustive query-shaped state. Only transport or unhandled unavailability
 * may retain the last successful data, explicitly marked stale. Application
 * and authoritative framework errors clear it.
 */
export type AckerDBQueryState<Data, Error extends ApplicationError = never> =
  | {
      readonly status: "disabled";
      readonly data: undefined;
      readonly error: undefined;
      readonly loading: false;
    }
  | {
      readonly status: "pending";
      readonly data: undefined;
      readonly error: undefined;
      readonly loading: true;
    }
  | {
      readonly status: "success";
      readonly data: Data;
      readonly error: undefined;
      readonly loading: false;
      readonly stale: false;
    }
  | ApplicationErrorState<Error>
  | {
      readonly status: "rejected";
      readonly data: undefined;
      readonly error: AckerDBClientError;
      readonly loading: false;
    }
  | {
      readonly status: "unavailable";
      readonly data: Data;
      readonly error: AckerDBClientError;
      readonly loading: false;
      readonly stale: true;
    }
  | {
      readonly status: "unavailable";
      readonly data: undefined;
      readonly error: AckerDBClientError;
      readonly loading: false;
      readonly stale: false;
    };

export const DISABLED_STATE = Object.freeze({
  status: "disabled",
  data: undefined,
  error: undefined,
  loading: false,
});

export const PENDING_STATE = Object.freeze({
  status: "pending",
  data: undefined,
  error: undefined,
  loading: true,
});

// Not a stableEncode output (canonical encodings are JSON), so it can never
// collide with a real argument key.
export const UNENCODABLE_ARGS = "!unencodable";

export function queryArgsKey(args: unknown): string {
  try {
    return stableEncode(args);
  } catch (error) {
    if (!(error instanceof WireError)) throw error;
    return UNENCODABLE_ARGS;
  }
}

// Snapshots promise immutable container structure. Binary leaves remain
// genuine mutable Uint8Arrays because the platform has no immutable typed
// array and wrapping one breaks normal ArrayBuffer-view consumers.
export function freezeQueryData<T>(value: T): T {
  const visit = (current: unknown): void => {
    if (typeof current !== "object" || current === null) return;
    if (ArrayBuffer.isView(current) || Object.isFrozen(current)) return;
    Object.freeze(current);
    for (const child of Object.values(current)) visit(child);
  };
  visit(value);
  return value;
}

export function querySuccess<Data, Error extends ApplicationError = never>(
  data: Data,
): AckerDBQueryState<Data, Error> {
  return {
    status: "success",
    data: freezeQueryData(data),
    error: undefined,
    loading: false,
    stale: false,
  };
}

export function queryApplicationError<
  Data,
  Error extends ApplicationError,
>(error: Error): AckerDBQueryState<Data, Error> {
  return {
    status: "application-error",
    data: undefined,
    error,
    loading: false,
  } as ApplicationErrorState<Error>;
}

export function queryClientError<
  Data,
  Error extends ApplicationError = never,
>(
  current: AckerDBQueryState<Data, Error>,
  error: AckerDBClientError,
): AckerDBQueryState<Data, Error> {
  if (error.kind === "framework") {
    return {
      status: "rejected",
      data: undefined,
      error,
      loading: false,
    };
  }
  const data = current.status === "success"
    ? current.data
    : current.status === "unavailable"
      ? current.data
      : undefined;
  return data === undefined
    ? {
        status: "unavailable",
        data: undefined,
        error,
        loading: false,
        stale: false,
      }
    : {
        status: "unavailable",
        data,
        error,
        loading: false,
        stale: true,
      };
}

export function queryConnectionUnavailable<
  Data,
  Error extends ApplicationError = never,
>(
  current: AckerDBQueryState<Data, Error>,
  error: AckerDBClientError,
): AckerDBQueryState<Data, Error> {
  if (current.status === "success") {
    return {
      status: "unavailable",
      data: current.data,
      error,
      loading: false,
      stale: true,
    };
  }
  if (current.status === "application-error") {
    return {
      status: "unavailable",
      data: undefined,
      error,
      loading: false,
      stale: false,
    };
  }
  return current;
}
