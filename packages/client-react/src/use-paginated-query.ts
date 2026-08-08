import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  getRef,
  type ApplicationError,
  type QueryPage,
} from "@ackerdb/core";
import type { QueryRef } from "@ackerdb/client";
import { useMemo } from "react";
import { useObservation } from "./observation.ts";
import { useProviderClient } from "./provider.tsx";
import { queryArgsKey, skip } from "./query-observation.ts";
import {
  PAGINATED_DISABLED_STATE,
  PAGINATED_PENDING_STATE,
  PaginatedQueryEntry,
  type AckerDBPaginatedArgs,
  type AckerDBPaginatedQueryState,
} from "./paginated-query-store.ts";

export interface UsePaginatedQueryOptions {
  /** Rows per live page. Defaults to 25; the server caps it at 256. */
  readonly pageSize?: number;
}

function pageSizeOf(options: UsePaginatedQueryOptions | undefined): number {
  const pageSize = options?.pageSize ?? DEFAULT_PAGE_SIZE;
  // The bound is the server's, so failing here costs one thrown render instead
  // of one rejected subscription per page.
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0 || pageSize > MAX_PAGE_SIZE) {
    throw new RangeError(`pageSize must be a positive safe integer of at most ${MAX_PAGE_SIZE}`);
  }
  return pageSize;
}

/**
 * A live window over a cursor-paginated query — one declaring
 * `{ cursor, pageSize }` arguments and returning `paginate()`'s page. Each
 * loaded page is an ordinary live subscription, so the whole window stays
 * fresh rather than aging into a snapshot; `loadMore` extends it from the last
 * page's `nextCursor` until `exhausted`. Pass `skip` to render the disabled
 * state without starting any subscription.
 */
export function usePaginatedQuery<
  Args extends AckerDBPaginatedArgs,
  Item,
  Error extends ApplicationError = never,
>(
  ref: QueryRef<Args, QueryPage<Item>, Error>,
  args: Omit<Args, "cursor" | "pageSize"> | typeof skip,
  options?: UsePaginatedQueryOptions,
): AckerDBPaginatedQueryState<Item, Error> {
  const client = useProviderClient("usePaginatedQuery");
  const address = getRef(ref);
  const pageSize = pageSizeOf(options);
  const argsKey = args === skip ? null : queryArgsKey(args);
  // One window per (client lifetime, address, canonical base arguments,
  // pageSize). The window owns the page chain; the pages themselves share the
  // ordinary live-query registry with every other consumer of the same
  // (address, arguments) pair. Windows subscribe only once a listener commits,
  // so renders React discards never start work.
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
