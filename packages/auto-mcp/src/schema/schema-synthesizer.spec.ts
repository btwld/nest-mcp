import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { ResolvedParam } from '../discovery/param-introspector';
import { buildInputSchema } from './schema-synthesizer';

describe('buildInputSchema', () => {
  it('uses an explicit schema from @McpExpose verbatim', () => {
    const result = buildInputSchema([], {
      schema: { type: 'object', properties: { x: { type: 'string' } } },
    });
    expect(result.schema).toEqual({ type: 'object', properties: { x: { type: 'string' } } });
    expect(result.degraded).toBe(false);
  });

  it('emits primitive type from design:paramtypes for path params', () => {
    const params: ResolvedParam[] = [
      {
        index: 0,
        kind: 'param',
        data: 'id',
        metaType: String,
        hasPipes: false,
        hasCustomFactory: false,
      },
    ];
    const { schema } = buildInputSchema(params);
    expect(schema).toEqual({
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    });
  });

  it('treats query params as optional', () => {
    const params: ResolvedParam[] = [
      {
        index: 0,
        kind: 'query',
        data: 'limit',
        metaType: Number,
        hasPipes: false,
        hasCustomFactory: false,
      },
    ];
    const { schema } = buildInputSchema(params);
    expect((schema as { required: string[] }).required).toEqual([]);
    expect((schema as { properties: Record<string, unknown> }).properties.limit).toEqual({
      type: 'number',
    });
  });

  it('falls back to permissive object for whole-body without validator metadata', () => {
    const params: ResolvedParam[] = [
      {
        index: 0,
        kind: 'body',
        data: undefined,
        metaType: class Dto {},
        hasPipes: false,
        hasCustomFactory: false,
      },
    ];
    const { schema, degraded } = buildInputSchema(params);
    const properties = (schema as { properties: Record<string, unknown> }).properties;
    expect(properties.body).toEqual({ type: 'object', additionalProperties: true });
    expect(degraded).toBe(true);
  });

  it('marks unsupported params as degraded (custom decorator factory)', () => {
    const params: ResolvedParam[] = [
      { index: 0, kind: 'unsupported', hasPipes: false, hasCustomFactory: true },
    ];
    const { degraded } = buildInputSchema(params);
    expect(degraded).toBe(true);
  });
});
