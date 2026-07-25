export interface DbStatementObservation {
  readonly kind: "read" | "write";
  readonly table: string;
  readonly statement: string;
  readonly outcome: "ok" | "failed";
  readonly durationMs: number;
  readonly rowCount?: number;
  /** Rows whose vector BLOB reached an exact-nearest ranking operation. */
  readonly candidateRowCount?: number;
  /** Peak exact-nearest ranking entries retained at once. */
  readonly retainedRowCount?: number;
}

export type DbStatementObserver = (
  observation: Readonly<DbStatementObservation>,
) => unknown;

type ExtraCounts = Pick<
  DbStatementObservation,
  "candidateRowCount" | "retainedRowCount"
>;

export function deliverObservation(
  observer: DbStatementObserver | undefined,
  observation: DbStatementObservation,
): void {
  if (observer === undefined) return;
  try {
    const result = observer(Object.freeze(observation));
    if (
      result !== null &&
      (typeof result === "object" || typeof result === "function") &&
      typeof (result as PromiseLike<unknown>).then === "function"
    ) {
      void Promise.resolve(result).catch(() => {});
    }
  } catch {
    // Statement telemetry is diagnostic and never owns application work.
  }
}

export function observeStatement<T>(
  observer: DbStatementObserver | undefined,
  kind: DbStatementObservation["kind"],
  table: string,
  statement: string,
  work: () => T | Promise<T>,
  rowCount: (value: T) => number | undefined,
  extraCounts?: (value: T) => ExtraCounts,
): T | Promise<T> {
  const ownedByTransaction = inTransaction();
  if (observer === undefined && !ownedByTransaction) return work();
  const startedAt = observer === undefined ? 0 : performance.now();
  const failed = (error: unknown): never => {
    if (ownedByTransaction) markTransactionPoisoned(error);
    if (observer !== undefined) {
      deliverObservation(observer, {
        kind,
        table,
        statement,
        outcome: "failed",
        durationMs: Math.max(0, performance.now() - startedAt),
      });
    }
    throw error;
  };
  const succeeded = (value: T): T => {
    if (observer !== undefined) {
      deliverObservation(observer, {
        kind,
        table,
        statement,
        outcome: "ok",
        durationMs: Math.max(0, performance.now() - startedAt),
        rowCount: rowCount(value),
        ...extraCounts?.(value),
      });
    }
    return value;
  };
  try {
    const result = work();
    return result && typeof (result as PromiseLike<T>).then === "function"
      ? Promise.resolve(result).then(succeeded, failed)
      : succeeded(result as T);
  } catch (error) {
    return failed(error);
  }
}
import {
  inTransaction,
  markTransactionPoisoned,
} from "../runtime/transaction-context.ts";
