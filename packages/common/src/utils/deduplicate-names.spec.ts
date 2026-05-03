import { describe, expect, it } from 'vitest';
import { deduplicateNames } from './deduplicate-names';

describe('deduplicateNames', () => {
  it('leaves unique names untouched', () => {
    const items = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
    deduplicateNames(items);
    expect(items.map((i) => i.name)).toEqual(['a', 'b', 'c']);
  });

  it('keeps the first occurrence of a colliding name and suffixes the rest', () => {
    const items = [{ name: 'getUser' }, { name: 'getUser' }, { name: 'getUser' }];
    deduplicateNames(items);
    expect(items.map((i) => i.name)).toEqual(['getUser', 'getUser_2', 'getUser_3']);
  });

  it('handles partial collisions among many names', () => {
    const items = [
      { name: 'getPet' },
      { name: 'addPet' },
      { name: 'getPet' },
      { name: 'addPet' },
      { name: 'addPet' },
    ];
    deduplicateNames(items);
    expect(items.map((i) => i.name)).toEqual([
      'getPet',
      'addPet',
      'getPet_2',
      'addPet_2',
      'addPet_3',
    ]);
  });

  it('preserves additional properties on items', () => {
    const items: Array<{ name: string; description: string }> = [
      { name: 'x', description: 'first' },
      { name: 'x', description: 'second' },
    ];
    deduplicateNames(items);
    expect(items[0]).toEqual({ name: 'x', description: 'first' });
    expect(items[1]).toEqual({ name: 'x_2', description: 'second' });
  });
});
