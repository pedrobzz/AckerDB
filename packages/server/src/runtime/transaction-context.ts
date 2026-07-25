import { AsyncLocalStorage } from "node:async_hooks";

interface TransactionState {
  poison?: unknown;
}

const transaction = new AsyncLocalStorage<TransactionState>();

export function inTransaction(): boolean {
  return transaction.getStore() !== undefined;
}

export function runInTransaction<T>(work: () => T): T {
  return transaction.run({}, work);
}

export function markTransactionPoisoned(error: unknown): void {
  const state = transaction.getStore();
  if (state !== undefined && !Object.hasOwn(state, "poison")) {
    state.poison = error;
  }
}

export function poisonTransaction(error: unknown): never {
  markTransactionPoisoned(error);
  throw error;
}

export function assertTransactionHealthy(): void {
  const state = transaction.getStore();
  if (state !== undefined && Object.hasOwn(state, "poison")) {
    throw state.poison;
  }
}
