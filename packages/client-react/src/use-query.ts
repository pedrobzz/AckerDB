import { WireError, getRef, stableEncode } from "@dbzz/core";
import type { QueryRef } from "@dbzz/client";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useProviderClient } from "./provider.tsx";
import {
  DISABLED_STATE,
  PENDING_STATE,
  QueryStoreEntry,
  type DbzzQueryState,
} from "./query-store.ts";

/**
 * Typed skip sentinel: `useQuery(ref, skip)` renders the disabled state and
 * starts no subscription. Replacing it with real arguments starts one.
 */
export const skip: unique symbol = Symbol("dbzz.useQuery.skip");

const noSubscription = (): (() => void) => () => {};

function argsKeyOf(args: unknown): string {
  try {
    return stableEncode(args);
  } catch (error) {
    if (!(error instanceof WireError)) throw error;
    // Unencodable argument values (NaN, functions, ...) share one key; the
    // subscription attempt then reports the exact validation error as state.
    return "!unencodable";
  }
}

/**
 * Live query state for a generated reference. Arguments, rows, and the exact
 * `DbzzClientError` are inferred from the reference; the result is an
 * exhaustive disabled/pending/success/error union with reconnect-aware
 * stale/fresh success data.
 */
export function useQuery<Args, Rows>(
  ref: QueryRef<Args, Rows>,
  args: Args | typeof skip,
): DbzzQueryState<Rows> {
  const client = useProviderClient("useQuery");
  const address = getRef(ref);
  const argsKey = args === skip ? null : argsKeyOf(args);
  // One entry per (client lifetime, address, canonical arguments); args
  // participates through argsKey, so equal-valued literals continue the
  // current subscription. Entries only subscribe once a listener commits, so
  // renders React discards never start work.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const entry = useMemo(
    () =>
      client !== null && argsKey !== null
        ? new QueryStoreEntry<Rows>(client, address, args)
        : null,
    [client, address, argsKey],
  );
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      entry !== null ? entry.listen(onStoreChange) : noSubscription(),
    [entry],
  );
  // Without an entry the snapshot is deterministic: disabled while skipped,
  // pending during the commit gap before the provider constructs its client.
  const getSnapshot = useCallback(
    (): DbzzQueryState<Rows> =>
      entry !== null ? entry.snapshot() : argsKey === null ? DISABLED_STATE : PENDING_STATE,
    [entry, argsKey],
  );
  const getServerSnapshot = useCallback(
    (): DbzzQueryState<Rows> => (argsKey === null ? DISABLED_STATE : PENDING_STATE),
    [argsKey],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
