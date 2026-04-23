import { type ToolAnnotations, type ToolMetadata, zodToJsonSchema } from '@nest-mcp/common';
import { z } from 'zod';

export const DEFAULT_SCHEMA_TOOL_NAME = 'get_tool_schema';

export const DEFAULT_SCHEMA_TOOL_DESCRIPTION = [
  'Fetch full JSON schemas for one or more tools discovered via `list_available_tools`.',
  'Batch multiple names in a single call to save round-trips.',
  'Unknown names are returned in `notFound`, not as errors.',
].join(' ');

export const getToolSchemaSchema = z.object({
  names: z
    .array(z.string())
    .min(1)
    .describe('Tool names to fetch schemas for. Batch to save round-trips.'),
});

export type GetToolSchemaArgs = z.infer<typeof getToolSchemaSchema>;

export interface ToolSchemaEntry {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: ToolAnnotations;
}

export interface GetToolSchemaResult {
  schemas: ToolSchemaEntry[];
  notFound: string[];
}

/**
 * Execute the schema fetch. Pure function — given the full tool pool and a
 * list of names, returns resolved schemas + unresolved names.
 */
export function getToolSchema(
  pool: Map<string, ToolMetadata>,
  args: GetToolSchemaArgs,
  maxBatchSize: number,
): GetToolSchemaResult {
  const requested = args.names.slice(0, maxBatchSize);
  const schemas: ToolSchemaEntry[] = [];
  const notFound: string[] = [];

  for (const name of requested) {
    const meta = pool.get(name);
    if (!meta) {
      notFound.push(name);
      continue;
    }
    const inputSchema = meta.parameters
      ? (zodToJsonSchema(meta.parameters) as Record<string, unknown>)
      : (meta.inputSchema ?? { type: 'object' });
    schemas.push({
      name: meta.name,
      description: meta.description,
      inputSchema,
      ...(meta.outputSchema
        ? { outputSchema: zodToJsonSchema(meta.outputSchema) as Record<string, unknown> }
        : meta.rawOutputSchema
          ? { outputSchema: meta.rawOutputSchema }
          : {}),
      ...(meta.annotations ? { annotations: meta.annotations } : {}),
    });
  }
  return { schemas, notFound };
}
