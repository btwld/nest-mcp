import { describe, expect, it } from 'vitest';
import { paginate } from './paginator';

describe('paginate', () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ id: i }));

  it('returns all items when total is less than page size', () => {
    const result = paginate(items);
    expect(result.items).toEqual(items);
    expect(result.nextCursor).toBeUndefined();
  });

  it('returns first page with nextCursor when items exceed page size', () => {
    const result = paginate(items, undefined, 3);
    expect(result.items).toEqual(items.slice(0, 3));
    expect(result.nextCursor).toBeDefined();
  });

  it('returns next page when cursor is provided', () => {
    const first = paginate(items, undefined, 3);
    const second = paginate(items, first.nextCursor, 3);
    expect(second.items).toEqual(items.slice(3, 6));
    expect(second.nextCursor).toBeDefined();
  });

  it('returns last page without nextCursor', () => {
    // Page through all items
    let cursor: string | undefined;
    const collected: Array<{ id: number }> = [];
    let pages = 0;

    do {
      const result = paginate(items, cursor, 4);
      collected.push(...result.items);
      cursor = result.nextCursor;
      pages++;
    } while (cursor);

    expect(collected).toEqual(items);
    expect(pages).toBe(3); // 4 + 4 + 2
  });

  it('returns empty items for cursor beyond array bounds', () => {
    const result = paginate(items, Buffer.from('999').toString('base64url'), 3);
    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeUndefined();
  });

  it('treats invalid cursor as start', () => {
    const result = paginate(items, 'not-valid-base64url-number', 3);
    expect(result.items).toEqual(items.slice(0, 3));
  });

  it('treats negative decoded cursor as start', () => {
    const negCursor = Buffer.from('-5').toString('base64url');
    const result = paginate(items, negCursor, 3);
    expect(result.items).toEqual(items.slice(0, 3));
  });

  it('returns empty result for empty input array', () => {
    const result = paginate([], undefined, 10);
    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeUndefined();
  });

  it('defaults page size to 100', () => {
    const large = Array.from({ length: 150 }, (_, i) => i);
    const result = paginate(large);
    expect(result.items).toHaveLength(100);
    expect(result.nextCursor).toBeDefined();
  });

  it('no nextCursor when items exactly fill the page', () => {
    const exact = Array.from({ length: 5 }, (_, i) => i);
    const result = paginate(exact, undefined, 5);
    expect(result.items).toHaveLength(5);
    expect(result.nextCursor).toBeUndefined();
  });
});
