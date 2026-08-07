import { AckerDBClientError, type AckerDBClient } from "@ackerdb/client";
import type { ApplicationError } from "@ackerdb/core";
import { SharedObservation } from "./observation.ts";
import {
  QueryStoreEntry,
  queryRegistryFor,
  type QuerySource,
} from "./query-store.ts";
import {
  UNENCODABLE_ARGS,
  queryArgsKey,
} from "./query-observation.ts";

/** Reactive cursor pagination defaults to ~25 rows per page (#193). */
export const DEFAULT_PAGE_SIZE = 25;

/** The page shape a paginated query returns — `ctx.db...paginate()`'s result. */
export interface AckerDBQueryPage<Item> {
  readonly items: readonly Item[];
  readonly nextCursor: string | null;
}

/** The argument contract a paginated query declares; the hook fills both. */
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
 * window of live pages, plus the pagination controls. `loadMore` is always
 * present and is a no-op unless the window can actually grow.
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

const noLoadMore = (): void => {};

function inertState(
  status: "disabled" | "pending",
  loadMore: () => void,
): AckerDBPaginatedQueryState<never> {
  return {
    status,
    items: undefined,
    error: undefined,
    loading: status === "pending",
    loadingMore: false,
    exhausted: false,
    loadMore,
  } as AckerDBPaginatedQueryState<never>;
}

export const PAGINATED_DISABLED_STATE = Object.freeze(inertState("disabled", noLoadMore));
export const PAGINATED_PENDING_STATE = Object.freeze(inertState("pending", noLoadMore));

function pageOf<Item>(data: unknown): AckerDBQueryPage<Item> | undefined {
  if (
    data === null ||
    typeof data !== "object" ||
    !Array.isArray((data as { items?: unknown }).items)
  ) {
    return undefined;
  }
  const nextCursor = (data as { nextCursor?: unknown }).nextCursor;
  if (nextCursor !== null && typeof nextCursor !== "string") return undefined;
  return data as AckerDBQueryPage<Item>;
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
  readonly source: QuerySource<AckerDBQueryPage<Item>, Error>;
  readonly stop: () => void;
}

/**
 * One consumer's live paginated window: an ordered chain of page
 * subscriptions, each an ordinary shared live query whose arguments carry
 * `{ cursor, pageSize }`. Page one starts at `cursor: null`; `loadMore`
 * subscribes the page after the last one's `nextCursor`. Every page stays a
 * live subscription, so a write that lands inside the window re-delivers the
 * affected page; when it moves a page's `nextCursor`, the pages behind it are
 * resubscribed from the new boundary so the flattened window stays contiguous
 * (it briefly truncates to the proven prefix rather than showing overlap).
 * The flatten never mixes eras: pages behind a stale or pending boundary are
 * withheld until the boundary itself re-proves the chain. Releasing the last
 * listener releases every page subscription.
 *
 * Known bound: one commit whose fan-out touches BOTH sides of a page
 * boundary without moving the cursor string arrives as independent frames,
 * so between those frames the flatten can transiently pair one page's new
 * delivery with its neighbor's not-yet-delivered one. The client cannot
 * tell that apart from "the neighbor was unaffected" without commit-scoped
 * delivery metadata; closing it needs the session to expose per-commit
 * atomic fan-out (or per-commit checkpoints for unaffected subscriptions),
 * which is a protocol decision, not a client-side one. It self-heals on the
 * neighbor's frame of the same commit.
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
    if (state.status !== "success") return;
    const page = pageOf<Item>(state.data);
    if (page === undefined || page.nextCursor === null) return;
    this.pages.push(this.openPage(page.nextCursor));
    this.replace(this.fold());
  };

  protected startObservation(): void {
    this.pages = [this.openPage(null)];
    this.replace(this.fold());
  }

  protected stopObservation(): void {
    for (const page of this.pages) page.stop();
    this.pages = [];
  }

  private readonly onPageEvent = (): void => {
    this.reconcile();
  };

  private openPage(cursor: string | null): PageSlot<Item, Error> {
    const args = {
      ...(this.baseArgs as object),
      pageSize: this.pageSize,
      cursor,
    };
    const key = queryArgsKey(args);
    // Unencodable arguments have no canonical key: a private entry reports
    // the exact validation error instead of sharing a registry slot.
    const source: QuerySource<AckerDBQueryPage<Item>, Error> = key === UNENCODABLE_ARGS
      ? new QueryStoreEntry<AckerDBQueryPage<Item>, Error>(this.client, this.address, args)
      : queryRegistryFor(this.client).source<AckerDBQueryPage<Item>, Error>(
          this.address,
          key,
          args,
        );
    return { cursor, source, stop: source.listen(this.onPageEvent) };
  }

  /**
   * Re-verify the cursor chain: every page after the first must start at its
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
        this.pages[index + 1] = this.openPage(page.nextCursor);
      }
    }
    this.replace(this.fold());
  }

  /**
   * Flatten one era, never two. A window that leads with stale-retained
   * pages is the pre-disconnect era: its consecutive retained pages were a
   * proven chain when live and flatten together, ending at the first page
   * that has since moved on. A window that leads with live successes is the
   * current era: a stale or pending page ends it — retained rows behind a
   * fresh boundary (and fresh rows behind a stale one) would mix eras as
   * overlap or gaps, so the suffix is withheld until its pages re-prove.
   */
  private fold(): AckerDBPaginatedQueryState<Item, Error> {
    const first = this.pages[0]?.source.snapshot();
    if (first !== undefined && first.status === "unavailable" && first.data !== undefined) {
      return this.foldRetainedEra(first.error);
    }
    const items: Item[] = [];
    for (let index = 0; index < this.pages.length; index++) {
      const state = this.pages[index]!.source.snapshot();
      if (state.status === "success") {
        const page = pageOf<Item>(state.data);
        if (page === undefined) return this.errorState("rejected", malformedPage());
        items.push(...page.items);
        if (index === this.pages.length - 1) {
          return this.successState(items, false, page.nextCursor === null);
        }
        continue;
      }
      if (state.status === "pending") {
        if (index === 0) return PAGINATED_PENDING_STATE as AckerDBPaginatedQueryState<Item, Error>;
        return this.successState(items, true, false);
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
        if (state.data !== undefined) {
          // Pre-disconnect rows behind a live fresh boundary: the connection
          // is back, this page just has not re-proven yet — withhold it.
          return this.successState(items, true, false);
        }
        // Unavailable without retained data: nothing behind it is proven.
        return items.length === 0
          ? this.errorState("unavailable", state.error)
          : this.staleState(items, state.error, false);
      }
      // "disabled" never happens: page sources always carry real arguments.
      break;
    }
    return this.successState(items, false, false);
  }

  /** The leading run of stale-retained pages — one era retained as it was. */
  private foldRetainedEra(error: AckerDBClientError): AckerDBPaginatedQueryState<Item, Error> {
    const items: Item[] = [];
    for (let index = 0; index < this.pages.length; index++) {
      const state = this.pages[index]!.source.snapshot();
      if (state.status !== "unavailable" || state.data === undefined) {
        // This page moved past the retained era; it and everything behind it
        // are withheld until the chain re-proves from the front.
        return this.staleState(items, error, false);
      }
      const page = pageOf<Item>(state.data);
      if (page === undefined) return this.errorState("rejected", malformedPage());
      items.push(...page.items);
      if (index === this.pages.length - 1) {
        return this.staleState(items, error, page.nextCursor === null);
      }
    }
    return this.staleState(items, error, false);
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
