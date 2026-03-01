import { describe, expect, it, vi } from 'vitest';
import { drainAllPages } from './drain-pages';

describe('drainAllPages', () => {
  it('returns all items from a single page', async () => {
    const fetch = vi.fn().mockResolvedValue({ data: [1, 2, 3], nextCursor: undefined });
    const result = await drainAllPages(fetch);
    expect(result).toEqual([1, 2, 3]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(undefined);
  });

  it('drains multiple pages until nextCursor is undefined', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ data: [1, 2], nextCursor: 'page2' })
      .mockResolvedValueOnce({ data: [3, 4], nextCursor: 'page3' })
      .mockResolvedValueOnce({ data: [5], nextCursor: undefined });

    const result = await drainAllPages(fetch);
    expect(result).toEqual([1, 2, 3, 4, 5]);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch).toHaveBeenNthCalledWith(1, undefined);
    expect(fetch).toHaveBeenNthCalledWith(2, 'page2');
    expect(fetch).toHaveBeenNthCalledWith(3, 'page3');
  });

  it('stops at maxPages safety limit', async () => {
    const fetch = vi.fn().mockResolvedValue({ data: [1], nextCursor: 'next' });
    const result = await drainAllPages(fetch, 3);
    expect(result).toEqual([1, 1, 1]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('returns empty array when first page is empty', async () => {
    const fetch = vi.fn().mockResolvedValue({ data: [], nextCursor: undefined });
    const result = await drainAllPages(fetch);
    expect(result).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('propagates errors from fetchPage', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('connection lost'));
    await expect(drainAllPages(fetch)).rejects.toThrow('connection lost');
  });

  it('propagates errors from intermediate pages', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ data: [1, 2], nextCursor: 'page2' })
      .mockRejectedValueOnce(new Error('timeout'));

    await expect(drainAllPages(fetch)).rejects.toThrow('timeout');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('stops when nextCursor is an empty string (falsy)', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ data: [1, 2], nextCursor: '' })
      .mockResolvedValueOnce({ data: [3], nextCursor: undefined });

    const result = await drainAllPages(fetch);
    // Empty string is falsy — loop should stop after first page
    expect(result).toEqual([1, 2]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('accumulates items from exactly two pages', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ data: ['a', 'b'], nextCursor: 'pg2' })
      .mockResolvedValueOnce({ data: ['c'], nextCursor: undefined });

    const result = await drainAllPages(fetch);
    expect(result).toEqual(['a', 'b', 'c']);
    expect(fetch).toHaveBeenNthCalledWith(2, 'pg2');
  });
});
