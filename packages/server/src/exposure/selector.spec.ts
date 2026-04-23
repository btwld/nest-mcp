import type { ToolMetadata } from '@nest-mcp/common';
import { describe, expect, it } from 'vitest';
import { isEager, matchesSelector } from './selector';

function meta(overrides: Partial<ToolMetadata> = {}): ToolMetadata {
  return {
    name: 'tool',
    description: 'desc',
    methodName: 'fn',
    target: class {} as unknown as abstract new (...args: unknown[]) => unknown,
    ...overrides,
  };
}

describe('matchesSelector', () => {
  it('array form matches on tool name', () => {
    expect(matchesSelector(meta({ name: 'a' }), ['a', 'b'])).toBe(true);
    expect(matchesSelector(meta({ name: 'c' }), ['a', 'b'])).toBe(false);
  });

  it('tags form matches when any tag overlaps', () => {
    expect(matchesSelector(meta({ tags: ['core', 'fast'] }), { tags: ['core'] })).toBe(true);
    expect(matchesSelector(meta({ tags: ['slow'] }), { tags: ['core'] })).toBe(false);
  });

  it('tags form is false when tool has no tags', () => {
    expect(matchesSelector(meta(), { tags: ['core'] })).toBe(false);
  });

  it('function form delegates to the predicate', () => {
    expect(matchesSelector(meta({ name: 'x' }), (m) => m.name.startsWith('x'))).toBe(true);
    expect(matchesSelector(meta({ name: 'y' }), (m) => m.name.startsWith('x'))).toBe(false);
  });
});

describe('isEager', () => {
  it('returns true when per-tool exposure is "eager" regardless of selector', () => {
    expect(isEager(meta({ exposure: 'eager' }), { tags: ['never-matches'] })).toBe(true);
  });

  it('returns false when per-tool exposure is "deferred" regardless of selector', () => {
    const selector = ['tool'] as const;
    expect(isEager(meta({ exposure: 'deferred' }), [...selector])).toBe(false);
  });

  it('falls back to selector when exposure is "auto"', () => {
    expect(isEager(meta({ exposure: 'auto', tags: ['core'] }), { tags: ['core'] })).toBe(true);
    expect(isEager(meta({ exposure: 'auto', tags: [] }), { tags: ['core'] })).toBe(false);
  });

  it('defaults to eager when no selector is supplied and no override is set', () => {
    expect(isEager(meta(), undefined)).toBe(true);
  });

  it('treats missing exposure as "auto"', () => {
    expect(isEager(meta({ tags: ['core'] }), { tags: ['core'] })).toBe(true);
    expect(isEager(meta({ tags: ['other'] }), { tags: ['core'] })).toBe(false);
  });
});
