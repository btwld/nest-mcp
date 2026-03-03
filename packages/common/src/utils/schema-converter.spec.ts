import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  extractZodDescriptions,
  warnMissingDescriptions,
  zodToJsonSchema,
} from './schema-converter';

describe('zodToJsonSchema', () => {
  it('should convert ZodString to JSON Schema', () => {
    const schema = z.string();
    expect(zodToJsonSchema(schema)).toEqual({ type: 'string' });
  });

  it('should convert ZodString with min/max constraints', () => {
    const schema = z.string().min(2).max(100);
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'string',
      minLength: 2,
      maxLength: 100,
    });
  });

  it('should convert ZodString with regex pattern', () => {
    const schema = z.string().regex(/^[a-z]+$/);
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'string',
      pattern: '^[a-z]+$',
    });
  });

  it('should convert email schema with format', () => {
    const schema = z.email();
    expect(zodToJsonSchema(schema)).toMatchObject({
      type: 'string',
      format: 'email',
    });
  });

  it('should convert url schema with format', () => {
    const schema = z.url();
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'string',
      format: 'uri',
    });
  });

  it('should convert ZodNumber to JSON Schema', () => {
    const schema = z.number();
    expect(zodToJsonSchema(schema)).toEqual({ type: 'number' });
  });

  it('should convert ZodNumber with min/max (inclusive)', () => {
    const schema = z.number().min(0).max(100);
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'number',
      minimum: 0,
      maximum: 100,
    });
  });

  it('should convert ZodNumber with exclusive min/max using gt/lt', () => {
    const schema = z.number().gt(0).lt(100);
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'number',
      exclusiveMinimum: 0,
      exclusiveMaximum: 100,
    });
  });

  it('should convert ZodNumber with int check', () => {
    const schema = z.number().int();
    expect(zodToJsonSchema(schema)).toMatchObject({ type: 'integer' });
  });

  it('should convert ZodBoolean to JSON Schema', () => {
    const schema = z.boolean();
    expect(zodToJsonSchema(schema)).toEqual({ type: 'boolean' });
  });

  it('should convert ZodNull to JSON Schema', () => {
    const schema = z.null();
    expect(zodToJsonSchema(schema)).toEqual({ type: 'null' });
  });

  it('should convert ZodArray to JSON Schema', () => {
    const schema = z.array(z.string());
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'array',
      items: { type: 'string' },
    });
  });

  it('should convert ZodObject to JSON Schema with required fields', () => {
    const schema = z.object({
      name: z.string(),
      age: z.number(),
    });
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'number' },
      },
      required: ['name', 'age'],
      additionalProperties: false,
    });
  });

  it('should convert ZodObject with optional fields', () => {
    const schema = z.object({
      name: z.string(),
      nickname: z.string().optional(),
    });
    const result = zodToJsonSchema(schema);
    expect(result).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string' },
        nickname: { type: 'string' },
      },
      required: ['name'],
      additionalProperties: false,
    });
  });

  it('should convert ZodObject with field descriptions', () => {
    const schema = z.object({
      name: z.string().describe('The user name'),
    });
    const result = zodToJsonSchema(schema) as {
      properties: Record<string, unknown>;
    };
    expect(result.properties.name).toEqual({
      type: 'string',
      description: 'The user name',
    });
  });

  it('should convert ZodObject with top-level description', () => {
    const schema = z
      .object({
        name: z.string(),
      })
      .describe('A user object');
    const result = zodToJsonSchema(schema);
    expect(result).toHaveProperty('description', 'A user object');
  });

  it('should convert ZodEnum to JSON Schema', () => {
    const schema = z.enum(['red', 'green', 'blue']);
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'string',
      enum: ['red', 'green', 'blue'],
    });
  });

  it('should convert ZodDefault to JSON Schema', () => {
    const schema = z.string().default('hello');
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'string',
      default: 'hello',
    });
  });

  it('should convert ZodNullable to JSON Schema anyOf', () => {
    const schema = z.string().nullable();
    expect(zodToJsonSchema(schema)).toEqual({
      anyOf: [{ type: 'string' }, { type: 'null' }],
    });
  });

  it('should convert ZodUnion to JSON Schema anyOf', () => {
    const schema = z.union([z.string(), z.number()]);
    expect(zodToJsonSchema(schema)).toEqual({
      anyOf: [{ type: 'string' }, { type: 'number' }],
    });
  });

  it('should convert ZodLiteral to JSON Schema const', () => {
    const schema = z.literal('hello');
    expect(zodToJsonSchema(schema)).toMatchObject({ const: 'hello' });
  });

  it('should convert ZodRecord to JSON Schema', () => {
    const schema = z.record(z.string(), z.string());
    expect(zodToJsonSchema(schema)).toMatchObject({
      type: 'object',
      additionalProperties: { type: 'string' },
    });
  });

  it('should convert ZodObject with all optional fields (no required key)', () => {
    const schema = z.object({
      a: z.string().optional(),
      b: z.number().optional(),
    });
    const result = zodToJsonSchema(schema);
    expect(result).not.toHaveProperty('required');
    expect(result).toMatchObject({ type: 'object', properties: { a: {}, b: {} } });
  });

  it('should convert ZodOptional directly to inner type schema', () => {
    const schema = z.string().optional();
    expect(zodToJsonSchema(schema)).toEqual({ type: 'string' });
  });

  it('should not include $schema in the output', () => {
    const schema = z.string();
    expect(zodToJsonSchema(schema)).not.toHaveProperty('$schema');
  });
});

describe('extractZodDescriptions', () => {
  it('should extract field names, descriptions, and required status', () => {
    const schema = z.object({
      name: z.string().describe('The name'),
      age: z.number(),
      email: z.string().optional().describe('Email address'),
    });
    const result = extractZodDescriptions(schema);
    expect(result).toEqual([
      { name: 'name', description: 'The name', required: true },
      { name: 'age', description: undefined, required: true },
      { name: 'email', description: 'Email address', required: false },
    ]);
  });

  it('should return empty array for non-object schemas', () => {
    const schema = z.string();
    expect(extractZodDescriptions(schema)).toEqual([]);
  });

  it('should handle default fields as not required', () => {
    const schema = z.object({
      role: z.string().default('user'),
    });
    const result = extractZodDescriptions(schema);
    expect(result).toEqual([{ name: 'role', description: undefined, required: false }]);
  });
});

describe('warnMissingDescriptions', () => {
  it('warns when schema has no top-level description', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warnMissingDescriptions(z.string(), 'myTool');
    expect(warn).toHaveBeenCalledWith(
      '[nest-mcp] myTool: schema is missing a top-level .describe() call',
    );
    warn.mockRestore();
  });

  it('does not warn for top-level when description is present', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warnMissingDescriptions(z.string().describe('A string'), 'myTool');
    expect(warn).not.toHaveBeenCalledWith(
      '[nest-mcp] myTool: schema is missing a top-level .describe() call',
    );
    warn.mockRestore();
  });

  it('warns for each ZodObject field missing .describe()', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const schema = z
      .object({
        name: z.string().describe('The name'),
        age: z.number(),
      })
      .describe('A user');
    warnMissingDescriptions(schema, 'userTool');
    expect(warn).toHaveBeenCalledWith(
      "[nest-mcp] userTool: field 'age' is missing a .describe() call",
    );
    expect(warn).not.toHaveBeenCalledWith(
      "[nest-mcp] userTool: field 'name' is missing a .describe() call",
    );
    warn.mockRestore();
  });

  it('does not warn for fields that have .describe()', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const schema = z
      .object({
        name: z.string().describe('The name'),
      })
      .describe('A user');
    warnMissingDescriptions(schema, 'userTool');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('only warns about top-level for non-object schemas (no field iteration)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warnMissingDescriptions(z.array(z.string()), 'arrayTool');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[nest-mcp] arrayTool: schema is missing a top-level .describe() call',
    );
    warn.mockRestore();
  });
});
