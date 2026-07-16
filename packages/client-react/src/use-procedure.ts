import type { DbzzCallOptions, ProcedureRef } from "@dbzz/client";
import { callThroughCell, useLifetimeCall } from "./lifetime-call.ts";

/** The stable callable returned by {@link useProcedure}. */
export type DbzzProcedure<A, R> = (args: A, options?: DbzzCallOptions) => Promise<R>;

/**
 * Typed one-off request/response calls against the enclosing provider's
 * client. Returns one callable per hook instance, stable across every render.
 * Calls issued before the provider's effect has constructed the client wait
 * for it; caller aborts and provider shutdown settle every call promptly with
 * the exact typed dbzz outcome, and a failed call is never silently replayed.
 */
export function useProcedure<A, R>(ref: ProcedureRef<A, R>): DbzzProcedure<A, R> {
  return useLifetimeCall(
    "useProcedure",
    ref,
    (cell): DbzzProcedure<A, R> =>
      (args, options) => {
        const target = cell.ref; // the procedure named at call time
        return callThroughCell(
          cell,
          args,
          (client, value) => client.procedure<A, R>(target, value, options),
          // Procedures own a caller abort signal, so a queued call must honor
          // it too; once dispatched the signal settles the call through the
          // client's own fetch abort path instead.
          options?.signal === undefined
            ? undefined
            : { signal: options.signal, canceled: "procedure request was canceled" },
        );
      },
  );
}
