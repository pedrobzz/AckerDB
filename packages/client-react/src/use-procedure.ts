import {
  DbzzClientError,
  type DbzzCallOptions,
  type DbzzClient,
  type ProcedureRef,
} from "@dbzz/client";
import { useEffect, useState } from "react";
import { useProviderClient } from "./provider.tsx";

/** The stable callable returned by {@link useProcedure}. */
export type DbzzProcedure<A, R> = (args: A, options?: DbzzCallOptions) => Promise<R>;

// A call issued before the provider's commit-phase effect has constructed the
// client waits here. Every waiter settles through exactly one explicit path:
// dispatch when the client arrives, discard when the hook's lifetime ends, or
// rejection when its caller's abort signal fires first. Once dispatched, the
// caller's signal and provider shutdown both settle the call through the
// client's own fetch abort path, so the hook never wraps or reinterprets the
// typed outcome.
interface Waiter {
  dispatch(client: DbzzClient): void;
  discard(error: DbzzClientError): void;
}

// Per-hook-instance mutable state shared between renders and the stable
// callable. The callable reads the provider's current client through it, so
// its identity never changes across renders, client arrival, or provider
// reconfiguration.
interface Cell<A, R> {
  ref: ProcedureRef<A, R>;
  client: DbzzClient | null;
  ended: boolean;
  readonly waiters: Set<Waiter>;
  readonly call: DbzzProcedure<A, R>;
}

// Typed outcomes for the two settlements the hook itself owns: calls that end
// before ever reaching a client. Shapes mirror the client's local errors.
function hookError(message: string): DbzzClientError {
  return new DbzzClientError({
    code: "unavailable",
    message,
    retryable: false,
    resource: "operation",
  });
}

function drain(waiters: Set<Waiter>): Waiter[] {
  const drained = [...waiters];
  waiters.clear();
  return drained;
}

function createCell<A, R>(initialRef: ProcedureRef<A, R>): Cell<A, R> {
  const cell: Cell<A, R> = {
    ref: initialRef,
    client: null,
    ended: false,
    waiters: new Set(),
    call(args, options) {
      const client = cell.client;
      if (client !== null) return client.procedure<A, R>(cell.ref, args, options);
      if (cell.ended) return Promise.reject(hookError("client closed"));
      const signal = options?.signal;
      if (signal?.aborted) return Promise.reject(hookError("procedure request was canceled"));
      return new Promise<R>((resolve, reject) => {
        const target = cell.ref; // the procedure named at call time
        const waiter: Waiter = {
          dispatch(readyClient) {
            signal?.removeEventListener("abort", onAbort);
            readyClient.procedure<A, R>(target, args, options).then(resolve, reject);
          },
          discard(error) {
            signal?.removeEventListener("abort", onAbort);
            reject(error);
          },
        };
        const onAbort = (): void => {
          cell.waiters.delete(waiter);
          reject(hookError("procedure request was canceled"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        cell.waiters.add(waiter);
      });
    },
  };
  return cell;
}

/**
 * Typed one-off request/response calls against the enclosing provider's
 * client. Returns one callable per hook instance, stable across every render.
 * Calls issued before the provider's effect has constructed the client wait
 * for it; caller aborts and provider shutdown settle every call promptly with
 * the exact typed dbzz outcome, and a failed call is never silently replayed.
 */
export function useProcedure<A, R>(ref: ProcedureRef<A, R>): DbzzProcedure<A, R> {
  const client = useProviderClient("useProcedure");
  const [cell] = useState(() => createCell(ref));

  // Generated references are proxies with fresh identity per render; track the
  // latest one each commit so the stable callable always names the procedure
  // the caller most recently rendered with.
  useEffect(() => {
    cell.ref = ref;
  });

  useEffect(() => {
    cell.ended = false;
    cell.client = client;
    if (client === null) return;
    for (const waiter of drain(cell.waiters)) waiter.dispatch(client);
  }, [cell, client]);

  // The hook's lifetime ends with its component (provider shutdown unmounts
  // consumers too): settle queued calls instead of leaving them pending.
  useEffect(
    () => () => {
      cell.ended = true;
      const error = hookError("client closed");
      for (const waiter of drain(cell.waiters)) waiter.discard(error);
    },
    [cell],
  );

  return cell.call;
}
