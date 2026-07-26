import type { ClientResult, AckerDBCallOptions, ProcedureRef } from "@ackerdb/client";
import type { ApplicationError } from "@ackerdb/core";
import { callResultThroughCell, useLifetimeCall } from "./lifetime-call.ts";

/** The stable callable returned by {@link useProcedure}. */
export type AckerDBProcedure<
  A,
  Data,
  Error extends ApplicationError = never,
> = (args: A, options?: AckerDBCallOptions) => Promise<ClientResult<Data, Error>>;

/**
 * Typed one-off request/response calls against the enclosing provider's
 * client. Returns one callable per hook instance, stable across every render.
 * Calls issued before the provider's effect has constructed the client wait
 * for it; caller aborts and provider shutdown settle every call promptly with
 * the exact typed ackerdb outcome, and a failed call is never silently replayed.
 */
export function useProcedure<A, Data, Error extends ApplicationError = never>(
  ref: ProcedureRef<A, Data, Error>,
): AckerDBProcedure<A, Data, Error> {
  return useLifetimeCall(
    "useProcedure",
    ref,
    (cell): AckerDBProcedure<A, Data, Error> =>
      (args, options) => {
        const target = cell.ref; // the procedure named at call time
        return callResultThroughCell(
          cell,
          args,
          (client, value) => client.procedure<A, Data, Error>(target, value, options),
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
