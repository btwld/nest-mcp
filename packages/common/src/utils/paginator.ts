export interface PaginatedResult<T> {
  items: T[];
  nextCursor?: string;
}

/**
 * Paginate an array of items using cursor-based pagination.
 * Cursor is a base64url-encoded index into the array.
 */
export function paginate<T>(
  items: T[],
  cursor?: string,
  pageSize = 100,
): PaginatedResult<T> {
  const startIndex = cursor ? decodeCursor(cursor) : 0;
  const page = items.slice(startIndex, startIndex + pageSize);
  const nextIndex = startIndex + pageSize;

  return {
    items: page,
    nextCursor: nextIndex < items.length ? encodeCursor(nextIndex) : undefined,
  };
}

function encodeCursor(index: number): string {
  return Buffer.from(String(index)).toString('base64url');
}

function decodeCursor(cursor: string): number {
  const decoded = Number(Buffer.from(cursor, 'base64url').toString());
  if (Number.isNaN(decoded) || decoded < 0) return 0;
  return decoded;
}
