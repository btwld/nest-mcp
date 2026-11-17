import { ValidationError } from '../errors/validation.error';

export interface PaginatedResult<T> {
  items: T[];
  nextCursor?: string;
}

/**
 * Paginate an array of items using cursor-based pagination.
 * Cursor is a base64url-encoded index into the array.
 */
export function paginate<T>(items: T[], cursor?: string, pageSize = 100): PaginatedResult<T> {
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
  const text = Buffer.from(cursor, 'base64url').toString();
  const decoded = Number(text);
  // Spec: an invalid cursor is an Invalid params error, not "start over".
  if (text.trim() === '' || !Number.isInteger(decoded) || decoded < 0) {
    throw new ValidationError('Invalid cursor');
  }
  return decoded;
}
