import { ZodObject, type ZodType, z } from 'zod';

/**
 * Converts a Zod schema to JSON Schema compatible with MCP specification.
 * Uses Zod v4's native z.toJSONSchema() for accurate conversion.
 */
export function zodToJsonSchema(schema: ZodType): Record<string, unknown> {
  const result = z.toJSONSchema(schema) as Record<string, unknown>;
  // Strip $schema metadata — not needed for MCP tool/resource schemas
  delete result.$schema;
  return result;
}

/**
 * Validates that a Zod schema and all its fields have `.describe()` set.
 * Logs warnings for any missing descriptions. Does NOT throw.
 * Intended to be called during tool/prompt registration for dev-time feedback.
 */
export function warnMissingDescriptions(schema: ZodType, label: string): void {
  if (!z.globalRegistry.get(schema)?.description) {
    console.warn(`[nest-mcp] ${label}: schema is missing a top-level .describe() call`);
  }

  if (schema instanceof ZodObject) {
    for (const [key, field] of Object.entries(schema.shape)) {
      if (!z.globalRegistry.get(field as ZodType)?.description) {
        console.warn(`[nest-mcp] ${label}: field '${key}' is missing a .describe() call`);
      }
    }
  }
}

/**
 * Extract parameter descriptions from a Zod schema for prompt argument metadata.
 */
export function extractZodDescriptions(
  schema: ZodType,
): Array<{ name: string; description?: string; required: boolean }> {
  if (!(schema instanceof ZodObject)) return [];

  const result: Array<{ name: string; description?: string; required: boolean }> = [];

  for (const [key, field] of Object.entries(schema.shape)) {
    const zodField = field as ZodType;
    result.push({
      name: key,
      description: z.globalRegistry.get(zodField)?.description,
      required: !zodField.isOptional(),
    });
  }

  return result;
}
