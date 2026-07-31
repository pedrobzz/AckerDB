import { getRef, type ApplicationError } from "@ackerdb/core";
import type { QueryRef } from "@ackerdb/client";
import { useMemo } from "react";
import { useObservation } from "./observation.ts";
import { useProviderClient } from "./provider.tsx";
import {
  QueryStoreEntry,
  queryRegistryFor,
  type QuerySource,
} from "./query-store.ts";
import {
  DISABLED_STATE,
  PENDING_STATE,
  UNENCODABLE_ARGS,
  queryArgsKey,
  skip,
  type AckerDBQueryState,
} from "./query-observation.ts";

/**
 * Typed skip sentinel: `useQuery(ref, skip)` renders the disabled state and
 * starts no subscription. Replacing it with real arguments starts one.
 */
export { skip } from "./query-observation.ts";

/**
 * Live query state for a generated reference. Arguments, rows, and the exact
 * `AckerDBClientError` are inferred from the reference; the result is an
 * exhaustive disabled/pending/success/error union with reconnect-aware
 * stale/fresh success data.
 */
export function useQuery<Args, Rows, Error extends ApplicationError = never>(
  ref: QueryRef<Args, Rows, Error>,
  args: Args | typeof skip,
): AckerDBQueryState<Rows, Error> {
  const client = useProviderClient("useQuery");
  const address = getRef(ref);
  const argsKey = args === skip ? null : queryArgsKey(args);
  // One shared registry source per (client lifetime, address, canonical
  // arguments): every consumer with the same key observes the same underlying
  // entry — one client subscription, one snapshot object — and equal-valued
  // literals continue the current subscription. Unencodable arguments have no
  // canonical key, so they stay private to this consumer and report their own
  // exact validation error. Entries only subscribe once a listener commits,
  // so renders React discards never start or register work.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const source = useMemo<QuerySource<Rows, Error> | null>(
    () =>
      client === null || argsKey === null
        ? null
        : argsKey === UNENCODABLE_ARGS
          ? new QueryStoreEntry<Rows, Error>(client, address, args)
          : queryRegistryFor(client).source<Rows, Error>(address, argsKey, args),
    [client, address, argsKey],
  );
  // Without a source the snapshot is deterministic: disabled while skipped,
  // pending during the commit gap before the provider constructs its client.
  return useObservation<AckerDBQueryState<Rows, Error>>(
    source,
    argsKey === null ? DISABLED_STATE : PENDING_STATE,
  );
}
