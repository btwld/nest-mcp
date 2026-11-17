const DEFAULT_MAX_PAGES = 100;

/** Details passed to {@link DrainAllPagesOptions.onTruncated} when the page cap is reached. */
export interface DrainAllPagesTruncation {
  /** The page cap that was reached. */
  maxPages: number;
  /** Number of items collected before stopping. */
  itemCount: number;
  /** The cursor of the first page that was not fetched. */
  nextCursor: string;
}

export interface DrainAllPagesOptions {
  /** Maximum number of pages to fetch. Defaults to 100. */
  maxPages?: number;
  /**
   * Called once when the page cap is reached while the server still reports a `nextCursor`,
   * i.e. when the returned list is incomplete.
   */
  onTruncated?: (info: DrainAllPagesTruncation) => void;
}

/**
 * Exhaustively fetches all pages from a cursor-paginated endpoint.
 *
 * The `fetchPage` callback receives an optional cursor and must return
 * `{ data: T[], nextCursor?: string }`. Pages are fetched sequentially
 * until `nextCursor` is undefined or the page cap (`maxPages`, default 100) is reached.
 * Reaching the cap does not throw; pass `onTruncated` to be told when it happens.
 *
 * The second argument is either the page cap or an options object.
 */
export async function drainAllPages<T>(
  fetchPage: (cursor?: string) => Promise<{ data: T[]; nextCursor?: string }>,
  maxPagesOrOptions: number | DrainAllPagesOptions = DEFAULT_MAX_PAGES,
): Promise<T[]> {
  const options: DrainAllPagesOptions =
    typeof maxPagesOrOptions === 'number' ? { maxPages: maxPagesOrOptions } : maxPagesOrOptions;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;

  const all: T[] = [];
  let cursor: string | undefined;
  let pages = 0;

  do {
    const result = await fetchPage(cursor);
    all.push(...result.data);
    cursor = result.nextCursor;
    pages++;
  } while (cursor && pages < maxPages);

  if (cursor) {
    options.onTruncated?.({ maxPages, itemCount: all.length, nextCursor: cursor });
  }

  return all;
}
