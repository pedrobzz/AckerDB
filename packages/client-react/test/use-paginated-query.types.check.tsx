// Compile-time contract for usePaginatedQuery: the paginated-argument
// convention, item inference from the page shape, the typed skip sentinel,
// and exhaustive state handling. This file is typechecked (see the package
// tsconfig) and never executed.
import {
  skip,
  usePaginatedQuery,
  type AckerDBClientError,
  type AckerDBPaginatedQueryState,
  type AckerDBQueryPage,
  type QueryRef,
} from "@ackerdb/client-react";
import type { ApplicationError } from "@ackerdb/core";
import type { MutationRef } from "@ackerdb/client";

interface LogRow {
  readonly id: bigint;
  readonly message: string;
}
type ListArgs = {
  readonly level: string;
  readonly cursor: string | null;
  readonly pageSize: number;
};
type LogsGone = ApplicationError<"logs.gone", { readonly level: string }, 410>;
declare const list: QueryRef<ListArgs, AckerDBQueryPage<LogRow>, LogsGone>;
declare const record: MutationRef<ListArgs, bigint>;

// --- reference-driven inference ----------------------------------------------

function Inferred(): string {
  // Cursor and pageSize belong to the hook; callers pass the rest.
  const state = usePaginatedQuery(list, { level: "error" }, { pageSize: 50 });
  if (state.status === "success") {
    const rows: readonly LogRow[] = state.items;
    const growing: boolean = state.loadingMore;
    const done: boolean = state.exhausted;
    state.loadMore();
    return `${rows.length}:${growing}:${done}`;
  }
  if (state.status === "application-error") {
    const exact: LogsGone = state.error;
    const absent: undefined = state.items;
    return `${exact.code}:${String(absent)}`;
  }
  if (state.status === "rejected") {
    const exact: AckerDBClientError = state.error;
    return exact.code;
  }
  if (state.status === "unavailable") {
    const retained: readonly LogRow[] | undefined = state.items;
    return `${state.error.code}:${state.stale}:${retained?.length ?? 0}`;
  }
  return state.status;
}
void Inferred;

const skipped: AckerDBPaginatedQueryState<LogRow, LogsGone> = usePaginatedQuery(list, skip);
void skipped;

// --- rejected references and arguments ---------------------------------------

// @ts-expect-error mutations are not paginated queries
usePaginatedQuery(record, { level: "error" });

// @ts-expect-error cursor is the hook's to manage
usePaginatedQuery(list, { level: "error", cursor: null });

// @ts-expect-error missing declared arguments
usePaginatedQuery(list, {});

declare const flat: QueryRef<ListArgs, LogRow[], LogsGone>;
// @ts-expect-error a paginated query must return { items, nextCursor }
usePaginatedQuery(flat, { level: "error" });

declare const unpaged: QueryRef<{ readonly level: string }, AckerDBQueryPage<LogRow>>;
// @ts-expect-error the query must declare cursor and pageSize arguments
usePaginatedQuery(unpaged, { level: "error" });
