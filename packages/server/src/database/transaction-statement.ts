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
    return result && typeof (result as PromiseLike<T>).then === "function"
      ? Promise.resolve(result).catch(failed)
      : result;
  } catch (error) {
    return failed(error);
  }
}
