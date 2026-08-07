import { AckerDBClientError, type AckerDBClient } from "@ackerdb/client";
import type { ApplicationError, QueryPage } from "@ackerdb/core";
import { SharedObservation } from "./observation.ts";
import {
  QueryStoreEntry,
  queryRegistryFor,
  type QuerySource,
} from "./query-store.ts";
import { UNENCODABLE_ARGS, queryArgsKey } from "./query-observation.ts";

/** The arguments a paginated query declares; the hook supplies both of them. */
export interface AckerDBPaginatedArgs {
  readonly cursor: string | null;
  readonly pageSize: number;
}

export type PaginatedApplicationErrorState<Error extends ApplicationError> =
  [Error] extends [never]
    ? never
    : {
      readonly status: "application-error";
      readonly items: undefined;
      readonly error: Error;
      readonly loading: false;
      readonly loadingMore: false;
      readonly exhausted: false;
      readonly loadMore: () => void;
    };

/**
 * Exhaustive paginated-query state: the `useQuery` union over a flattened
 * window of live pages, plus the controls that grow it. `loadMore` is always
 * present and does nothing unless the window can actually grow, so a caller
 * never guards the call itself.
 */
export type AckerDBPaginatedQueryState<Item, Error extends ApplicationError = never> =
  | {
      readonly status: "disabled";
      readonly items: undefined;
      readonly error: undefined;
      readonly loading: false;
      readonly loadingMore: false;
      readonly exhausted: false;
      readonly loadMore: () => void;
    }
  | {
      readonly status: "pending";
      readonly items: undefined;
      readonly error: undefined;
      readonly loading: true;
      readonly loadingMore: false;
      readonly exhausted: false;
      readonly loadMore: () => void;
    }
  | {
      readonly status: "success";
      readonly items: readonly Item[];
      readonly error: undefined;
      readonly loading: false;
      readonly stale: false;
      readonly loadingMore: boolean;
      readonly exhausted: boolean;
      readonly loadMore: () => void;
    }
  | PaginatedApplicationErrorState<Error>
  | {
      readonly status: "rejected";
      readonly items: undefined;
      readonly error: AckerDBClientError;
      readonly loading: false;
      readonly loadingMore: false;
      readonly exhausted: false;
      readonly loadMore: () => void;
    }
  | {
      readonly status: "unavailable";
      readonly items: readonly Item[];
      readonly error: AckerDBClientError;
      readonly loading: false;
      readonly stale: true;
      readonly loadingMore: false;
      readonly exhausted: boolean;
      readonly loadMore: () => void;
    }
  | {
      readonly status: "unavailable";
      readonly items: undefined;
      readonly error: AckerDBClientError;
      readonly loading: false;
      readonly stale: false;
      readonly loadingMore: false;
      readonly exhausted: false;
      readonly loadMore: () => void;
    };

const noop = (): void => {};

function inertState(status: "disabled" | "pending"): AckerDBPaginatedQueryState<never> {
  return Object.freeze({
    status,
    items: undefined,
    error: undefined,
    loading: status === "pending",
    loadingMore: false,
    exhausted: false,
    loadMore: noop,
  }) as AckerDBPaginatedQueryState<never>;
}

export const PAGINATED_DISABLED_STATE = inertState("disabled");
export const PAGINATED_PENDING_STATE = inertState("pending");

function pageOf<Item>(data: unknown): QueryPage<Item> | undefined {
  if (
    data === null ||
    typeof data !== "object" ||
    !Array.isArray((data as { items?: unknown }).items)
  ) {
    return undefined;
  }
  const nextCursor = (data as { nextCursor?: unknown }).nextCursor;
  if (nextCursor !== null && typeof nextCursor !== "string") return undefined;
  return data as QueryPage<Item>;
}

function malformedPage(): AckerDBClientError {
  return new AckerDBClientError({
    code: "validation",
    retryable: false,
    message: "a paginated query must return { items, nextCursor } — paginate() produces it",
    resource: "subscription",
  });
}

interface PageSlot<Item, Error extends ApplicationError> {
  readonly cursor: string | null;
  readonly source: QuerySource<QueryPage<Item>, Error>;
  stop: () => void;
}

/**
 * One consumer's live paginated window: an ordered chain of pages, each an
 * ordinary shared live query whose arguments carry its `{ cursor, pageSize }`.
 * Page one starts at `cursor: null` and `loadMore` subscribes the page after
 * the last one's `nextCursor`, so the window is not a snapshot that ages — a
 * write landing anywhere inside it re-delivers the page it touched.
 *
 * Because every page is a real subscription, the chain can be contradicted:
 * when a write moves a page's `nextCursor`, the pages behind it no longer
 * start where their predecessor ends. Those are resubscribed at the new
 * boundary, and until the chain proves itself again the window shows only its
 * proven prefix. A truncated window is honest; an overlapping one is not.
 *
 * Each page is individually consistent, and the window is consistent across
 * pages only eventually. One commit that changes two pages produces two
 * deliveries, and between them the pages sit at different versions: a later
 * page can land first and be flattened onto a predecessor that is about to
 * move, so the window can briefly miss or repeat a row that crossed a
 * boundary. The predecessor's own delivery — already in flight, since the
 * server sent both — repairs it. Closing that gap would need every
 * subscription to confirm its currency at every commit, which is a cost the
 * whole system would pay for a transient one list shows.
 *
 * The chain lives and dies with committed demand, which is what makes it idle
 * cheap: the last listener leaving releases every page subscription, and a
 * listener returning within the release window continues them untouched.
 */
export class PaginatedQueryEntry<
  Item,
  Error extends ApplicationError = never,
> extends SharedObservation<AckerDBPaginatedQueryState<Item, Error>> {
  private pages: PageSlot<Item, Error>[] = [];

  constructor(
    private readonly client: AckerDBClient,
    private readonly address: string,
    private readonly baseArgs: unknown,
    private readonly pageSize: number,
  ) {
    super(PAGINATED_PENDING_STATE as AckerDBPaginatedQueryState<Item, Error>);
  }

  readonly loadMore = (): void => {
    if (!this.hasDemand || this.pages.length === 0) return;
    const last = this.pages[this.pages.length - 1]!;
    const state = last.source.snapshot();
    // Only a delivered page names the next one's boundary. A click during
    // loading has nothing to extend from and is deliberately dropped.
    if (state.status !== "success") return;
    const page = pageOf<Item>(state.data);
    if (page === undefined || page.nextCursor === null) return;
    this.openPage(page.nextCursor, this.pages.length);
    this.replace(this.fold());
  };

  protected startObservation(): void {
    this.pages = [];
    this.openPage(null, 0);
    this.replace(this.fold());
  }

  protected stopObservation(): void {
    for (const page of this.pages) page.stop();
    this.pages = [];
  }

  private readonly onPageEvent = (): void => {
    this.reconcile();
  };

  /**
   * Put a page in the chain, then subscribe it — in that order. A subscription
   * can fail synchronously, and that failure must fold the chain the page
   * already belongs to rather than the one it is about to join.
   */
  private openPage(cursor: string | null, position: number): void {
    const args = { ...(this.baseArgs as object), pageSize: this.pageSize, cursor };
    const key = queryArgsKey(args);
    // Pages share the ordinary live-query registry, so two windows resting on
    // the same page hold one subscription between them. Unencodable arguments
    // have no canonical key: a private entry reports their exact validation
    // error instead of claiming a registry slot.
    const source: QuerySource<QueryPage<Item>, Error> = key === UNENCODABLE_ARGS
      ? new QueryStoreEntry<QueryPage<Item>, Error>(this.client, this.address, args)
      : queryRegistryFor(this.client).source<QueryPage<Item>, Error>(this.address, key, args);
    const slot: PageSlot<Item, Error> = { cursor, source, stop: noop };
    this.pages[position] = slot;
    slot.stop = source.listen(this.onPageEvent);
  }

  /**
   * Re-verify the chain: every page after the first must start at its
   * predecessor's delivered `nextCursor`. A page whose predecessor has not
   * resolved keeps its subscription until the chain can be proven again.
   */
  private reconcile(): void {
    for (let index = 0; index + 1 < this.pages.length; index++) {
      const state = this.pages[index]!.source.snapshot();
      if (state.status !== "success") break;
      const page = pageOf<Item>(state.data);
      if (page === undefined) break;
      if (page.nextCursor === null) {
        for (const dropped of this.pages.splice(index + 1)) dropped.stop();
        break;
      }
      if (this.pages[index + 1]!.cursor !== page.nextCursor) {
        this.pages[index + 1]!.stop();
        this.openPage(page.nextCursor, index + 1);
      }
    }
    this.replace(this.fold());
  }

  /** Flatten the chain into one window, stopping at the first unproven page. */
  private fold(): AckerDBPaginatedQueryState<Item, Error> {
    const items: Item[] = [];
    let unavailableError: AckerDBClientError | undefined;
    let exhausted = false;
    for (let index = 0; index < this.pages.length; index++) {
      const state = this.pages[index]!.source.snapshot();
      const last = index === this.pages.length - 1;
      if (state.status === "unavailable" && unavailableError === undefined) {
        unavailableError = state.error;
      }
      if (state.status === "success" || (state.status === "unavailable" && state.data !== undefined)) {
        const page = pageOf<Item>(state.data);
        if (page === undefined) return this.errorState("rejected", malformedPage());
        items.push(...page.items);
        if (last) exhausted = page.nextCursor === null;
        continue;
      }
      if (state.status === "pending") {
        // Page one pending is the whole window pending; a later one is the
        // proven prefix still growing.
        if (index === 0) return PAGINATED_PENDING_STATE as AckerDBPaginatedQueryState<Item, Error>;
        return unavailableError === undefined
          ? this.successState(items, true, false)
          : this.staleState(items, unavailableError, false);
      }
      if (state.status === "application-error") {
        return {
          status: "application-error",
          items: undefined,
          error: state.error,
          loading: false,
          loadingMore: false,
          exhausted: false,
          loadMore: this.loadMore,
        } as AckerDBPaginatedQueryState<Item, Error>;
      }
      if (state.status === "rejected") return this.errorState("rejected", state.error);
      if (state.status === "unavailable") {
        // Unavailable without retained data: nothing from here on is proven.
        return items.length === 0
          ? this.errorState("unavailable", state.error)
          : this.staleState(items, state.error, false);
      }
      // "disabled" cannot happen: a page source always carries real arguments.
      break;
    }
    if (unavailableError === undefined) return this.successState(items, false, exhausted);
    return items.length === 0
      ? this.errorState("unavailable", unavailableError)
      : this.staleState(items, unavailableError, exhausted);
  }

  private successState(
    items: Item[],
    loadingMore: boolean,
    exhausted: boolean,
  ): AckerDBPaginatedQueryState<Item, Error> {
    return {
      status: "success",
      items: Object.freeze(items),
      error: undefined,
      loading: false,
      stale: false,
      loadingMore,
      exhausted,
      loadMore: this.loadMore,
    };
  }

  private staleState(
    items: Item[],
    error: AckerDBClientError,
    exhausted: boolean,
  ): AckerDBPaginatedQueryState<Item, Error> {
    return {
      status: "unavailable",
      items: Object.freeze(items),
      error,
      loading: false,
      stale: true,
      loadingMore: false,
      exhausted,
      loadMore: this.loadMore,
    };
  }

  private errorState(
    status: "rejected" | "unavailable",
    error: AckerDBClientError,
  ): AckerDBPaginatedQueryState<Item, Error> {
    return {
      status,
      items: undefined,
      error,
      loading: false,
      ...(status === "unavailable" ? { stale: false as const } : {}),
      loadingMore: false,
      exhausted: false,
      loadMore: this.loadMore,
    } as AckerDBPaginatedQueryState<Item, Error>;
  }
}
