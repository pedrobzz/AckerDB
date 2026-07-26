import { WireError, getRef, stableEncode, type ApplicationError } from "@ackerdb/core";
import type { QueryRef } from "@ackerdb/client";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useProviderClient } from "./provider.tsx";
import {
  DISABLED_STATE,
  PENDING_STATE,
  QueryStoreEntry,
  queryRegistryFor,
  type AckerDBQueryState,
  type QuerySource,
} from "./query-store.ts";

/**
 * Typed skip sentinel: `useQuery(ref, skip)` renders the disabled state and
 * starts no subscription. Replacing it with real arguments starts one.
 */
export const skip: unique symbol = Symbol("ackerdb.useQuery.skip");

const noSubscription = (): (() => void) => () => {};

// Not a stableEncode output (canonical encodings are JSON), so it can never
// collide with a real argument key.
const UNENCODABLE = "!unencodable";

function argsKeyOf(args: unknown): string {
  try {
    return stableEncode(args);
  } catch (error) {
    if (!(error instanceof WireError)) throw error;
    return UNENCODABLE;
  }
}

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
  const argsKey = args === skip ? null : argsKeyOf(args);
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
        : argsKey === UNENCODABLE
          ? new QueryStoreEntry<Rows, Error>(client, address, args)
          : queryRegistryFor(client).source<Rows, Error>(address, argsKey, args),
    [client, address, argsKey],
  );
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      source !== null ? source.listen(onStoreChange) : noSubscription(),
    [source],
  );
  // Without a source the snapshot is deterministic: disabled while skipped,
  // pending during the commit gap before the provider constructs its client.
  const getSnapshot = useCallback(
    (): AckerDBQueryState<Rows, Error> =>
      source !== null ? source.snapshot() : argsKey === null ? DISABLED_STATE : PENDING_STATE,
    [source, argsKey],
  );
  const getServerSnapshot = useCallback(
    (): AckerDBQueryState<Rows, Error> => (argsKey === null ? DISABLED_STATE : PENDING_STATE),
    [argsKey],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
