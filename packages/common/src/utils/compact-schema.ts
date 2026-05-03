import type { JsonSchemaProperty } from './json-schema-to-zod';

const STRUCTURAL_KEYS = new Set([
  'type',
  'properties',
  'items',
  'required',
  'enum',
  'allOf',
  'oneOf',
  'anyOf',
  'nullable',
  'default',
  'additionalProperties',
  'format',
]);

export function compactSchema(
  properties: Record<string, JsonSchemaProperty>,
): Record<string, JsonSchemaProperty> {
  const compacted: Record<string, JsonSchemaProperty> = {};
  for (const [key, value] of Object.entries(properties)) {
    const compact: JsonSchemaProperty = {};
    for (const [k, v] of Object.entries(value)) {
      if (!STRUCTURAL_KEYS.has(k)) continue;
      if (k === 'properties') {
        compact.properties = compactSchema(v as Record<string, JsonSchemaProperty>);
      } else if (k === 'items' && v && typeof v === 'object') {
        const itemValue = v as JsonSchemaProperty;
        compact.items = itemValue.properties
          ? { ...itemValue, properties: compactSchema(itemValue.properties) }
          : itemValue;
      } else {
        (compact as Record<string, unknown>)[k] = v;
      }
    }
    if (!compact.type) compact.type = 'string';
    compacted[key] = compact;
  }
  return compacted;
}

export function truncateDescription(description: string, maxLength: number): string {
  if (maxLength === 0) return '';
  if (description.length <= maxLength) return description;
  return `${description.slice(0, maxLength)}...`;
}
