import type { ZodType } from 'zod';

/**
 * Converts a Zod schema to JSON Schema compatible with MCP specification.
 * Uses zodToJsonSchema if available from zod, otherwise uses basic conversion.
 */
export function zodToJsonSchema(schema: ZodType): Record<string, unknown> {
  // Use Zod's built-in JSON Schema generation if available (Zod 3.x)
  if ('_def' in schema) {
    return convertZodDef((schema as any)._def);
  }
  return { type: 'object' };
}

function convertZodDef(def: any): Record<string, unknown> {
  if (!def) return {};

  const typeName = def.typeName;

  switch (typeName) {
    case 'ZodString':
      return buildStringSchema(def);
    case 'ZodNumber':
      return buildNumberSchema(def);
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodNull':
      return { type: 'null' };
    case 'ZodArray':
      return { type: 'array', items: convertZodDef(def.type?._def) };
    case 'ZodObject':
      return buildObjectSchema(def);
    case 'ZodEnum':
      return { type: 'string', enum: def.values };
    case 'ZodOptional':
      return convertZodDef(def.innerType?._def);
    case 'ZodDefault':
      return {
        ...convertZodDef(def.innerType?._def),
        default: def.defaultValue(),
      };
    case 'ZodNullable': {
      const inner = convertZodDef(def.innerType?._def);
      return { ...inner, nullable: true };
    }
    case 'ZodUnion':
      return {
        anyOf: def.options?.map((opt: any) => convertZodDef(opt._def)) ?? [],
      };
    case 'ZodLiteral':
      return { const: def.value };
    case 'ZodRecord':
      return {
        type: 'object',
        additionalProperties: convertZodDef(def.valueType?._def),
      };
    default:
      return {};
  }
}

function buildStringSchema(def: any): Record<string, unknown> {
  const schema: Record<string, unknown> = { type: 'string' };
  if (def.checks) {
    for (const check of def.checks) {
      if (check.kind === 'min') schema.minLength = check.value;
      if (check.kind === 'max') schema.maxLength = check.value;
      if (check.kind === 'regex') schema.pattern = check.regex.source;
      if (check.kind === 'email') schema.format = 'email';
      if (check.kind === 'url') schema.format = 'uri';
    }
  }
  return schema;
}

function buildNumberSchema(def: any): Record<string, unknown> {
  const schema: Record<string, unknown> = { type: 'number' };
  if (def.checks) {
    for (const check of def.checks) {
      if (check.kind === 'min') {
        schema[check.inclusive ? 'minimum' : 'exclusiveMinimum'] = check.value;
      }
      if (check.kind === 'max') {
        schema[check.inclusive ? 'maximum' : 'exclusiveMaximum'] = check.value;
      }
      if (check.kind === 'int') schema.type = 'integer';
    }
  }
  return schema;
}

function buildObjectSchema(def: any): Record<string, unknown> {
  const shape = def.shape?.();
  if (!shape) return { type: 'object' };

  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(shape)) {
    const fieldDef = (value as any)?._def;
    properties[key] = convertZodDef(fieldDef);

    // Add description from .describe()
    if (fieldDef?.description) {
      (properties[key] as any).description = fieldDef.description;
    }

    // Check if field is optional
    if (fieldDef?.typeName !== 'ZodOptional' && fieldDef?.typeName !== 'ZodDefault') {
      required.push(key);
    }
  }

  const schema: Record<string, unknown> = { type: 'object', properties };
  if (required.length > 0) schema.required = required;

  // Add description from .describe()
  if (def.description) {
    schema.description = def.description;
  }

  return schema;
}

/**
 * Extract parameter descriptions from a Zod schema for prompt argument metadata.
 */
export function extractZodDescriptions(
  schema: ZodType,
): Array<{ name: string; description?: string; required: boolean }> {
  const def = (schema as any)?._def;
  if (def?.typeName !== 'ZodObject') return [];

  const shape = def.shape?.();
  if (!shape) return [];

  const result: Array<{ name: string; description?: string; required: boolean }> = [];

  for (const [key, value] of Object.entries(shape)) {
    const fieldDef = (value as any)?._def;
    result.push({
      name: key,
      description: fieldDef?.description,
      required: fieldDef?.typeName !== 'ZodOptional' && fieldDef?.typeName !== 'ZodDefault',
    });
  }

  return result;
}
