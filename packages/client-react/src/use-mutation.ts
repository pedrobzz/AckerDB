import type { MutationRef } from "@dbzz/client";
import { callThroughCell, useLifetimeCall } from "./lifetime-call.ts";

/**
 * A typed callable over a generated mutation reference. Returns one callable
 * per hook instance, stable across renders, client arrival, and provider
 * reconfiguration. Once a client exists the callable returns the base
 * client's own `mutation` promise unwrapped — replay identity across
 * reconnects, determinate/indeterminate outcomes, and exact `DbzzClientError`
 * values are the client's own. Calls issued before the provider's effect has
 * constructed the client wait for it and dispatch exactly once on arrival;
 * mutations have no abort surface (the base `mutation` takes no signal), so a
 * queued call settles only by that dispatch or by the typed discard when the
 * hook's lifetime ends.
 */
export function useMutation<Args, Result>(
  ref: MutationRef<Args, Result>,
): (args: Args) => Promise<Result> {
  return useLifetimeCall(
    "useMutation",
    ref,
    (cell) =>
      (args: Args): Promise<Result> => {
        const target = cell.ref; // the mutation named at call time
        return callThroughCell(cell, (client) => client.mutation<Args, Result>(target, args));
      },
  );
}
