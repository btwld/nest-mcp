import { z } from 'zod';

export interface JsonSchemaProperty {
  type?: string | string[];
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  items?: JsonSchemaProperty;
  enum?: unknown[];
  $ref?: string;
  nullable?: boolean;
  allOf?: JsonSchemaProperty[];
  oneOf?: JsonSchemaProperty[];
  anyOf?: JsonSchemaProperty[];
  additionalProperties?: boolean | JsonSchemaProperty;
  default?: unknown;
  format?: string;
  readOnly?: boolean;
  description?: string;
}

const FORMAT_REFINERS: Record<string, (s: z.ZodString) => z.ZodTypeAny> = {
  uuid: (s) => s.uuid(),
  email: (s) => s.email(),
  url: (s) => s.url(),
  'date-time': (s) => s.datetime({ offset: true }),
};

export function jsonSchemaToZod(schema: JsonSchemaProperty): z.ZodTypeAny {
  if (Array.isArray(schema.type)) {
    const types = schema.type;
    const isNullable = types.includes('null');
    const nonNullType = types.find((t) => t !== 'null') ?? 'string';
    const inner = jsonSchemaToZod({ ...schema, type: nonNullType });
    return isNullable ? inner.nullable() : inner;
  }

  if (schema.oneOf?.length || schema.anyOf?.length) {
    const variants = (schema.oneOf ?? schema.anyOf ?? []).map((s) => jsonSchemaToZod(s));
    if (variants.length === 1) {
      return schema.nullable ? variants[0].nullable() : variants[0];
    }
    if (variants.length >= 2) {
      const tuple = variants as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]];
      return schema.nullable ? z.union(tuple).nullable() : z.union(tuple);
    }
  }

  if (schema.allOf?.length) {
    const mergedProperties: Record<string, JsonSchemaProperty> = {};
    const mergedRequired: string[] = [];
    for (const sub of schema.allOf) {
      if (sub.properties) Object.assign(mergedProperties, sub.properties);
      if (sub.required) mergedRequired.push(...sub.required);
    }
    if (schema.properties) Object.assign(mergedProperties, schema.properties);
    if (schema.required) mergedRequired.push(...schema.required);
    const merged: JsonSchemaProperty = {
      type: 'object',
      properties: mergedProperties,
      required: mergedRequired.length ? mergedRequired : undefined,
      nullable: schema.nullable,
    };
    return jsonSchemaToZod(merged);
  }

  let result: z.ZodTypeAny;
  switch (schema.type) {
    case 'string': {
      if (schema.enum?.length) {
        const stringValues = schema.enum.filter((v): v is string => typeof v === 'string');
        if (stringValues.length > 0) {
          result = z.enum(stringValues as [string, ...string[]]);
          break;
        }
      }
      let str: z.ZodTypeAny = z.string();
      if (schema.format && FORMAT_REFINERS[schema.format]) {
        str = FORMAT_REFINERS[schema.format](str as z.ZodString);
      }
      result = str;
      break;
    }
    case 'integer':
    case 'number': {
      if (schema.enum?.length) {
        const numValues = schema.enum.filter((v): v is number => typeof v === 'number');
        if (numValues.length === 1) {
          result = z.literal(numValues[0]);
          break;
        }
        if (numValues.length > 1) {
          const literals = numValues.map((v) => z.literal(v));
          result = z.union(
            literals as [z.ZodLiteral<number>, z.ZodLiteral<number>, ...z.ZodLiteral<number>[]],
          );
          break;
        }
      }
      result = schema.type === 'integer' ? z.number().int() : z.number();
      break;
    }
    case 'boolean':
      result = z.boolean();
      break;
    case 'array':
      result = schema.items ? z.array(jsonSchemaToZod(schema.items)) : z.array(z.unknown());
      break;
    case 'object': {
      if (schema.properties) {
        const shape: Record<string, z.ZodTypeAny> = {};
        const required = schema.required ?? [];
        for (const [key, propSchema] of Object.entries(schema.properties)) {
          const zodType = jsonSchemaToZod(propSchema);
          const hasDefault = 'default' in propSchema;
          const isReadOnly = propSchema.readOnly === true;
          shape[key] =
            required.includes(key) && !hasDefault && !isReadOnly ? zodType : zodType.optional();
        }
        result = z.object(shape);
        break;
      }
      result = z.record(z.string(), z.unknown());
      break;
    }
    default:
      result = z.unknown();
      break;
  }

  return schema.nullable ? result.nullable() : result;
}
