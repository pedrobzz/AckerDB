import type { Database } from "bun:sqlite";
import {
  inTransaction,
  markTransactionPoisoned,
} from "../runtime/transaction-context.ts";

/** Preserve transaction poisoning without adding work outside a transaction. */
export function runStatement<T>(work: () => T | Promise<T>): T | Promise<T> {
  if (!inTransaction()) return work();
  const failed = (error: unknown): never => {
    markTransactionPoisoned(error);
    throw error;
  };
  try {
    const result = work();
    return isThenable(result) ? Promise.resolve(result).catch(failed) : result;
  } catch (error) {
    return failed(error);
  }
}

export interface TransactionOptions {
  /** `immediate` takes the write lock at BEGIN; `deferred` reads a snapshot. */
  readonly begin?: "immediate" | "deferred";
}

const ROLLBACK_FAILED = "transaction failed and its rollback failed too";

function isThenable(value: unknown): boolean {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as PromiseLike<unknown>).then === "function"
  );
}

function begin(connection: Database, options: TransactionOptions): void {
  connection.exec(options.begin === "deferred" ? "BEGIN DEFERRED" : "BEGIN IMMEDIATE");
}

/**
 * One rollback policy: the failure that required the rollback is the failure the
 * caller sees, and a rollback that fails too rides along instead of replacing it.
 */
function rollback(connection: Database, primary: unknown): never {
  if (!connection.inTransaction) throw primary;
  try {
    connection.exec("ROLLBACK");
  } catch (rollbackError) {
    throw new AggregateError([primary, rollbackError], ROLLBACK_FAILED);
  }
  throw primary;
}

/**
 * Run `work` inside one SQLite transaction: commit on return, roll back on throw.
 * A `work` that returns a promise is refused — bun:sqlite commits at the first
 * `await`, so an asynchronous body must say so and use `transactionAsync`.
 */
export function transaction<T>(
  connection: Database,
  work: () => T,
  options: TransactionOptions = {},
): T {
  begin(connection, options);
  let value: T;
  try {
    value = work();
    if (isThenable(value)) {
      throw new TypeError("transaction work must be synchronous; use transactionAsync");
    }
    connection.exec("COMMIT");
  } catch (error) {
    rollback(connection, error);
  }
  return value;
}

/**
 * The asynchronous form. The transaction is held across every `await`, so the
 * caller must already own the connection for the whole span.
 */
export async function transactionAsync<T>(
  connection: Database,
  work: () => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  begin(connection, options);
  let value: T;
  try {
    value = await work();
    connection.exec("COMMIT");
  } catch (error) {
    rollback(connection, error);
  }
  return value;
}
