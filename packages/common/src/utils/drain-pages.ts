const DEFAULT_MAX_PAGES = 100;

/**
 * Exhaustively fetches all pages from a cursor-paginated endpoint.
 *
 * The `fetchPage` callback receives an optional cursor and must return
 * `{ data: T[], nextCursor?: string }`. Pages are fetched sequentially
 * until `nextCursor` is undefined or `maxPages` is reached.
 */
export async function drainAllPages<T>(
  fetchPage: (cursor?: string) => Promise<{ data: T[]; nextCursor?: string }>,
  maxPages = DEFAULT_MAX_PAGES,
): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | undefined;
  let pages = 0;

  do {
    const result = await fetchPage(cursor);
    all.push(...result.data);
    cursor = result.nextCursor;
    pages++;
  } while (cursor && pages < maxPages);

  return all;
}
