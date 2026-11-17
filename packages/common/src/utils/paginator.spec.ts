import { describe, expect, it } from 'vitest';
import { ValidationError } from '../errors/validation.error';
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

  it('rejects a cursor that does not decode to an index', () => {
    expect(() => paginate(items, 'not-valid-base64url-number', 3)).toThrow(ValidationError);
  });

  it('rejects a negative or fractional cursor', () => {
    const negCursor = Buffer.from('-5').toString('base64url');
    const fractional = Buffer.from('1.5').toString('base64url');
    expect(() => paginate(items, negCursor, 3)).toThrow('Invalid cursor');
    expect(() => paginate(items, fractional, 3)).toThrow('Invalid cursor');
  });

  it('reports an invalid cursor as Invalid params', () => {
    try {
      paginate(items, '!!!', 3);
      throw new Error('expected paginate to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).code).toBe(-32602);
    }
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
