/**
 * The cursor-pagination contract shared by the server materializer and the
 * React client. Both ends need the same numbers: the client sizes its live
 * pages with them and fails a bad `pageSize` at the hook instead of one
 * rejected subscription per page, and the server enforces them because a page
 * size arrives from a caller it does not trust.
 */

/** One page of a cursor-paginated query — what `paginate()` returns. */
export interface QueryPage<Item> {
  readonly items: readonly Item[];
  /** Pass back unchanged to read the next page; `null` ends the sequence. */
  readonly nextCursor: string | null;
}

/** Rows a live page holds when the caller does not choose. */
export const DEFAULT_PAGE_SIZE = 25;

/** Rows one page may hold. A larger `pageSize` is rejected, never truncated. */
export const MAX_PAGE_SIZE = 256;

/**
 * Row bytes one page may hold, measured over the stored values a page carries.
 * It is the cap that survives a table whose rows are not uniform: a page stops
 * at the last row that fits and reports a cursor there, so a few oversized rows
 * cost the page its trailing rows instead of the whole delivery. A page always
 * carries at least one row, so an individual row larger than the budget still
 * makes forward progress; the transport's own frame limit judges that row.
 */
export const MAX_PAGE_BYTES = 512 * 1024;
