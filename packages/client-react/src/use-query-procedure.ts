import type { ProcedureRef } from "@ackerdb/client";
import { getRef, type ApplicationError } from "@ackerdb/core";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useProviderClient } from "./provider.tsx";
import {
  DISABLED_QUERY_PROCEDURE_STATE,
  PENDING_QUERY_PROCEDURE_STATE,
  QueryProcedureEntry,
  queryProcedureRegistryFor,
  type AckerDBQueryProcedureOptions,
  type AckerDBQueryProcedureState,
  type QueryProcedureSource,
} from "./query-procedure-store.ts";
import {
  UNENCODABLE_ARGS,
  noObservation,
  queryArgsKey,
  skip,
} from "./query-observation.ts";

function refreshIntervalOf(
  options: AckerDBQueryProcedureOptions | undefined,
): number | undefined {
  const interval = options?.refreshIntervalMs;
  if (
    interval !== undefined &&
    (!Number.isSafeInteger(interval) || interval <= 0)
  ) {
    throw new RangeError("refreshIntervalMs must be a positive safe integer");
  }
  return interval;
}

/**
 * Repeatable procedure demand observed through query-shaped state. Equal
 * committed consumers share one execution, schedule, snapshot, and refresh
 * operation within the provider's client lifetime.
 */
export function useQueryProcedure<
  Args,
  Data,
  Error extends ApplicationError = never,
>(
  ref: ProcedureRef<Args, Data, Error>,
  args: Args | typeof skip,
  options?: AckerDBQueryProcedureOptions,
): AckerDBQueryProcedureState<Data, Error> {
  const client = useProviderClient("useQueryProcedure");
  const address = getRef(ref);
  const argsKey = args === skip ? null : queryArgsKey(args);
  const refreshIntervalMs = refreshIntervalOf(options);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const source = useMemo<QueryProcedureSource<Data, Error> | null>(
    () =>
      client === null || argsKey === null
        ? null
        : argsKey === UNENCODABLE_ARGS
          ? new QueryProcedureEntry<Data, Error>(
              client,
              address,
              args,
              refreshIntervalMs,
            )
          : queryProcedureRegistryFor(client).source<Data, Error>(
              address,
              argsKey,
              args,
              refreshIntervalMs,
            ),
    [client, address, argsKey, refreshIntervalMs],
  );
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      source !== null ? source.listen(onStoreChange) : noObservation(),
    [source],
  );
  const getSnapshot = useCallback(
    (): AckerDBQueryProcedureState<Data, Error> =>
      source !== null
        ? source.snapshot()
        : argsKey === null
          ? DISABLED_QUERY_PROCEDURE_STATE
          : PENDING_QUERY_PROCEDURE_STATE,
    [source, argsKey],
  );
  const getServerSnapshot = useCallback(
    (): AckerDBQueryProcedureState<Data, Error> =>
      argsKey === null
        ? DISABLED_QUERY_PROCEDURE_STATE
        : PENDING_QUERY_PROCEDURE_STATE,
    [argsKey],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export type {
  AckerDBQueryProcedureOptions,
  AckerDBQueryProcedureState,
} from "./query-procedure-store.ts";
