import { paginate } from '@nest-mcp/common';
import type { ToolMetadata } from '@nest-mcp/common';
import { z } from 'zod';

export const DEFAULT_LIST_TOOL_NAME = 'list_available_tools';

export const DEFAULT_LIST_TOOL_DESCRIPTION = [
  'Returns a paginated index of available tools (name, short description, tags).',
  'Does not include JSON schemas — call `get_tool_schema` once you pick a tool.',
  'Use this to discover tools without bloating the conversation with full schemas.',
].join(' ');

export const listAvailableToolsSchema = z.object({
  query: z
    .string()
    .optional()
    .describe('Case-insensitive substring match over tool name and description.'),
  tags: z
    .array(z.string())
    .optional()
    .describe('Restrict results to tools that carry ALL of these tags.'),
  cursor: z.string().optional().describe('Pagination cursor returned by a previous call.'),
  limit: z
    .number()
    .int()
    .positive()
    .max(200)
    .optional()
    .describe('Maximum tools to return. Default 50, max 200.'),
});

export type ListAvailableToolsArgs = z.infer<typeof listAvailableToolsSchema>;

export interface ListAvailableToolsResult {
  tools: Array<{ name: string; description: string; tags?: string[] }>;
  nextCursor?: string;
  total?: number;
}

export interface IndexEntry {
  meta: ToolMetadata;
  oneLineDescription: string;
}

/**
 * Execute the index lookup. Pure function — takes the eligible tools and
 * query params, returns the paginated response.
 */
export function listAvailableTools(
  entries: IndexEntry[],
  args: ListAvailableToolsArgs,
): ListAvailableToolsResult {
  const { query, tags, cursor, limit = 50 } = args;

  let filtered = entries;
  if (tags?.length) {
    filtered = filtered.filter((e) => {
      const have = e.meta.tags ?? [];
      return tags.every((t) => have.includes(t));
    });
  }
  if (query) {
    const q = query.toLowerCase();
    filtered = filtered.filter(
      (e) => e.meta.name.toLowerCase().includes(q) || e.meta.description.toLowerCase().includes(q),
    );
  }

  const mapped = filtered.map((e) => ({
    name: e.meta.name,
    description: e.oneLineDescription,
    ...(e.meta.tags?.length ? { tags: e.meta.tags } : {}),
  }));

  const page = paginate(mapped, cursor, limit);
  return {
    tools: page.items,
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    total: filtered.length,
  };
}
