import { AsyncLocalStorage } from "node:async_hooks";
import { DbzzError } from "../shared/errors.ts";
import { poisonTransaction } from "./transaction-context.ts";

export interface MutationAccessFrame {
  tail: Promise<void>;
}

export interface MutationAccessState {
  current: MutationAccessFrame | null;
}

export interface MutationInvocationScope {
  runRoot<T>(work: () => T | Promise<T>): Promise<T>;
  run<T>(work: () => T | Promise<T>): Promise<T>;
}

interface MutationAccessToken {
  readonly state: MutationAccessState;
  readonly frame: MutationAccessFrame;
  readonly scope: MutationInvocationScope;
}

const mutationAccess = new AsyncLocalStorage<MutationAccessToken>();

export function currentMutationAccessFrame(): MutationAccessFrame | undefined {
  return mutationAccess.getStore()?.frame;
}

export function currentMutationInvocationScope(): MutationInvocationScope | undefined {
  return mutationAccess.getStore()?.scope;
}

export function withMutationAccessFrame<T>(
  state: MutationAccessState,
  frame: MutationAccessFrame,
  scope: MutationInvocationScope,
  work: () => T,
): T {
  return mutationAccess.run({ state, frame, scope }, work);
}

/**
 * Reject database work from an ancestor async continuation while a nested
 * mutation owns the top SQLite savepoint. Otherwise the nested rollback could
 * silently erase writes made concurrently by its parent.
 */
export function assertMutationAccess(): void {
  const token = mutationAccess.getStore();
  if (token !== undefined && token.state.current !== token.frame) {
    return poisonTransaction(new DbzzError(
      "validation",
      "concurrent database access crossed a nested mutation boundary; await the nested mutation before continuing",
    ));
  }
}
