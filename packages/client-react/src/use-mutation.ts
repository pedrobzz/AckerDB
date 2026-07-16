import { DbzzClientError, type MutationRef } from "@dbzz/client";
import { useMemo } from "react";
import { useProviderClient } from "./provider.tsx";

// Rejection for a call that races the provider's commit-phase client
// construction (or runs during server rendering): no client exists, so no
// mutation identity was created and nothing reached the network.
function detachedMutation(): Promise<never> {
  return Promise.reject(
    new DbzzClientError({
      code: "unavailable",
      message: "the provider has not constructed its client yet",
      retryable: false,
      resource: "connection",
    }),
  );
}

/**
 * A stable typed callable over a generated mutation reference, bound to the
 * enclosing provider's client lifetime. The returned function IS the client's
 * `mutation` bound to the reference address — no wrapper — so the promise,
 * replay identity across reconnects, determinate/indeterminate outcomes, and
 * exact `DbzzClientError` values are the base client's own.
 */
export function useMutation<Args, Result>(
  ref: MutationRef<Args, Result>,
): (args: Args) => Promise<Result> {
  const client = useProviderClient("useMutation");
  // Generated references are proxies that yield a fresh object per property
  // access; the address string is the reference's stable identity.
  const address = ref.$ref;
  return useMemo(
    () => (client === null ? detachedMutation : (client.mutation<Args, Result>).bind(client, address)),
    [client, address],
  );
}
