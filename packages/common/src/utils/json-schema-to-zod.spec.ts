import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type JsonSchemaProperty, jsonSchemaToZod } from './json-schema-to-zod';

describe('jsonSchemaToZod', () => {
  it('converts a string schema', () => {
    const zod = jsonSchemaToZod({ type: 'string' });
    expect(zod.safeParse('x').success).toBe(true);
    expect(zod.safeParse(1).success).toBe(false);
  });

  it('converts a string enum to z.enum', () => {
    const zod = jsonSchemaToZod({ type: 'string', enum: ['a', 'b'] });
    expect(zod.safeParse('a').success).toBe(true);
    expect(zod.safeParse('c').success).toBe(false);
  });

  it('converts integer schema with int constraint', () => {
    const zod = jsonSchemaToZod({ type: 'integer' });
    expect(zod.safeParse(1).success).toBe(true);
    expect(zod.safeParse(1.5).success).toBe(false);
  });

  it('converts a boolean', () => {
    expect(jsonSchemaToZod({ type: 'boolean' }).safeParse(true).success).toBe(true);
  });

  it('converts an array of strings', () => {
    const zod = jsonSchemaToZod({ type: 'array', items: { type: 'string' } });
    expect(zod.safeParse(['a', 'b']).success).toBe(true);
    expect(zod.safeParse(['a', 1]).success).toBe(false);
  });

  it('handles object with required + optional fields', () => {
    const zod = jsonSchemaToZod({
      type: 'object',
      properties: {
        a: { type: 'string' },
        b: { type: 'number' },
      },
      required: ['a'],
    });
    expect(zod.safeParse({ a: 'x' }).success).toBe(true);
    expect(zod.safeParse({}).success).toBe(false);
  });

  it('falls back to z.record on object without properties', () => {
    const zod = jsonSchemaToZod({ type: 'object' });
    expect(zod.safeParse({ anything: 1 }).success).toBe(true);
  });

  it('handles OpenAPI 3.1 type union with null', () => {
    const zod = jsonSchemaToZod({ type: ['string', 'null'] });
    expect(zod.safeParse('x').success).toBe(true);
    expect(zod.safeParse(null).success).toBe(true);
    expect(zod.safeParse(1).success).toBe(false);
  });

  it('honors OpenAPI 3.0 nullable: true', () => {
    const zod = jsonSchemaToZod({ type: 'string', nullable: true });
    expect(zod.safeParse(null).success).toBe(true);
  });

  it('merges allOf properties', () => {
    const zod = jsonSchemaToZod({
      allOf: [
        { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
        { type: 'object', properties: { b: { type: 'number' } }, required: ['b'] },
      ],
    });
    expect(zod.safeParse({ a: 'x', b: 1 }).success).toBe(true);
    expect(zod.safeParse({ a: 'x' }).success).toBe(false);
  });

  it('emits z.union for oneOf', () => {
    const zod = jsonSchemaToZod({
      oneOf: [{ type: 'string' }, { type: 'number' }],
    });
    expect(zod.safeParse('x').success).toBe(true);
    expect(zod.safeParse(1).success).toBe(true);
    expect(zod.safeParse(true).success).toBe(false);
  });

  it('treats default and readOnly as optional in object shapes', () => {
    const zod = jsonSchemaToZod({
      type: 'object',
      properties: {
        a: { type: 'string', default: 'x' },
        b: { type: 'string', readOnly: true },
        c: { type: 'string' },
      },
      required: ['a', 'b', 'c'],
    });
    expect(zod.safeParse({ c: 'y' }).success).toBe(true);
  });

  it('applies format refinements (uuid, email, date-time)', () => {
    const uuid = jsonSchemaToZod({ type: 'string', format: 'uuid' });
    expect(uuid.safeParse('not-a-uuid').success).toBe(false);
    expect(uuid.safeParse('00000000-0000-0000-0000-000000000000').success).toBe(true);

    const email = jsonSchemaToZod({ type: 'string', format: 'email' });
    expect(email.safeParse('a@b.co').success).toBe(true);
    expect(email.safeParse('not-email').success).toBe(false);

    const dt = jsonSchemaToZod({ type: 'string', format: 'date-time' });
    expect(dt.safeParse('2025-01-01T00:00:00.000Z').success).toBe(true);
    expect(dt.safeParse('not-a-date').success).toBe(false);
  });

  it('handles single-value numeric enum as literal', () => {
    const zod = jsonSchemaToZod({ type: 'integer', enum: [42] });
    expect(zod.safeParse(42).success).toBe(true);
    expect(zod.safeParse(43).success).toBe(false);
  });

  it('falls back to z.unknown for missing type', () => {
    const zod = jsonSchemaToZod({} as JsonSchemaProperty);
    expect(zod.safeParse('x').success).toBe(true);
    expect(zod.safeParse(1).success).toBe(true);
  });

  it('round-trips through z.toJSONSchema for object schemas', () => {
    const zod = jsonSchemaToZod({
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    });
    const back = z.toJSONSchema(zod) as Record<string, unknown>;
    expect(back.type).toBe('object');
  });
});
