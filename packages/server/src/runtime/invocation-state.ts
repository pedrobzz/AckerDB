import { AsyncLocalStorage } from "node:async_hooks";
import type { Principal } from "../auth/credentials.ts";
import { DbzzError } from "../shared/errors.ts";
import { poisonTransaction } from "./transaction-context.ts";

export interface MutationAccessFrame {
  tail: Promise<void>;
}

export interface MutationAccessState {
  current: MutationAccessFrame | null;
}

export interface MutationInvocationScope {
  runRoot<T>(
    work: (access: MutationAccess) => T | Promise<T>,
  ): Promise<T>;
  run<T>(
    parent: MutationAccess,
    work: (access: MutationAccess) => T | Promise<T>,
    onError?: (error: unknown) => never,
  ): Promise<T>;
}

export interface MutationAccess {
  readonly state: MutationAccessState;
  readonly frame: MutationAccessFrame;
  readonly scope: MutationInvocationScope;
}

export interface InvocationState {
  readonly principal: Principal;
  readonly root: {
    poison?: unknown;
  };
  readonly mutationAccess?: MutationAccess;
}

const invocation = new AsyncLocalStorage<InvocationState>();
let activeNestedMutationScopes = 0;

export function currentInvocationState(): InvocationState | undefined {
  return invocation.getStore();
}

export function withInvocationState<T>(
  state: InvocationState,
  work: () => T,
): T {
  return invocation.run(state, work);
}

export function withMutationAccess<T>(
  access: MutationAccess,
  work: () => T,
): T {
  const state = invocation.getStore();
  if (state === undefined) {
    throw new DbzzError(
      "internal",
      "mutation access requires an owning registered invocation",
    );
  }
  return invocation.run({ ...state, mutationAccess: access }, work);
}

export function enterNestedMutationScope(): void {
  activeNestedMutationScopes++;
}

export function leaveNestedMutationScope(): void {
  activeNestedMutationScopes--;
}

/**
 * Reject database work from an ancestor async continuation while a nested
 * mutation owns the top SQLite savepoint. Otherwise the nested rollback could
 * silently erase writes made concurrently by its parent.
 */
export function assertMutationAccess(): void {
  if (activeNestedMutationScopes === 0) return;
  const access = invocation.getStore()?.mutationAccess;
  if (
    access !== undefined &&
    access.state.current !== access.frame
  ) {
    return poisonTransaction(new DbzzError(
      "validation",
      "concurrent database access crossed a nested mutation boundary; await the nested mutation before continuing",
    ));
  }
}
