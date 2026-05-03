import { describe, expect, it } from 'vitest';
import { compactSchema, truncateDescription } from './compact-schema';

describe('compactSchema', () => {
  it('strips description and example keys', () => {
    const out = compactSchema({
      a: {
        type: 'string',
        description: 'a long description',
      },
    });
    expect(out.a).toEqual({ type: 'string' });
  });

  it('preserves structural keys', () => {
    const out = compactSchema({
      a: {
        type: 'object',
        properties: { x: { type: 'string' } },
        required: ['x'],
      },
    });
    expect(out.a.type).toBe('object');
    expect(out.a.properties).toEqual({ x: { type: 'string' } });
    expect(out.a.required).toEqual(['x']);
  });

  it('recurses into nested object properties', () => {
    const out = compactSchema({
      a: {
        type: 'object',
        properties: {
          inner: { type: 'string', description: 'drop me' },
        },
      },
    });
    expect(out.a.properties?.inner).toEqual({ type: 'string' });
  });

  it('defaults missing type to string', () => {
    const out = compactSchema({ a: {} });
    expect(out.a.type).toBe('string');
  });

  it('preserves enum, allOf, oneOf, anyOf, default, format', () => {
    const out = compactSchema({
      a: {
        type: 'string',
        enum: ['x', 'y'],
        format: 'uuid',
      },
    });
    expect(out.a.enum).toEqual(['x', 'y']);
    expect(out.a.format).toBe('uuid');
  });
});

describe('truncateDescription', () => {
  it('returns empty when maxLength is 0', () => {
    expect(truncateDescription('hello', 0)).toBe('');
  });

  it('returns full string when shorter than max', () => {
    expect(truncateDescription('hi', 10)).toBe('hi');
  });

  it('truncates and adds ellipsis when too long', () => {
    expect(truncateDescription('abcdefghij', 4)).toBe('abcd...');
  });
});
