import { getRef, type ApplicationError } from "@ackerdb/core";
import type { QueryRef } from "@ackerdb/client";
import { useMemo } from "react";
import { useObservation } from "./observation.ts";
import { useProviderClient } from "./provider.tsx";
import { queryArgsKey, skip } from "./query-observation.ts";
import {
  DEFAULT_PAGE_SIZE,
  PAGINATED_DISABLED_STATE,
  PAGINATED_PENDING_STATE,
  PaginatedQueryEntry,
  type AckerDBPaginatedArgs,
  type AckerDBPaginatedQueryState,
  type AckerDBQueryPage,
} from "./paginated-query-store.ts";

export interface UsePaginatedQueryOptions {
  /** Rows per live page; the server also caps one page's rows. Default 25. */
  readonly pageSize?: number;
}

/**
 * A live paginated window over a cursor-paginated query — one that declares
 * `{ cursor, pageSize }` arguments and returns `paginate()`'s
 * `{ items, nextCursor }` page. Each loaded page is an ordinary live
 * subscription, so the whole window stays fresh; `loadMore` extends it from
 * the last page's `nextCursor` until `exhausted`. Pass `skip` to render the
 * disabled state without starting any subscription.
 */
export function usePaginatedQuery<
  Args extends AckerDBPaginatedArgs,
  Item,
  Error extends ApplicationError = never,
>(
  ref: QueryRef<Args, AckerDBQueryPage<Item>, Error>,
  args: Omit<Args, "cursor" | "pageSize"> | typeof skip,
  options?: UsePaginatedQueryOptions,
): AckerDBPaginatedQueryState<Item, Error> {
  const client = useProviderClient("usePaginatedQuery");
  const address = getRef(ref);
  const pageSize = options?.pageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0) {
    throw new TypeError("usePaginatedQuery: pageSize must be a positive safe integer");
  }
  const argsKey = args === skip ? null : queryArgsKey(args);
  // One entry per (client lifetime, address, canonical base arguments,
  // pageSize): the entry owns the page chain, while each page shares the
  // ordinary live-query registry with every other consumer of the same
  // (address, arguments) pair. Entries subscribe only once a listener
  // commits, so discarded renders never start work.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const source = useMemo(
    () =>
      client === null || argsKey === null
        ? null
        : new PaginatedQueryEntry<Item, Error>(client, address, args, pageSize),
    [client, address, argsKey, pageSize],
  );
  return useObservation<AckerDBPaginatedQueryState<Item, Error>>(
    source,
    (argsKey === null
      ? PAGINATED_DISABLED_STATE
      : PAGINATED_PENDING_STATE) as AckerDBPaginatedQueryState<Item, Error>,
  );
}
