import type { McpExecutionContext } from './mcp-context.interface';

export type McpMiddleware = (
  ctx: McpExecutionContext,
  args: unknown,
  next: () => Promise<unknown>,
) => Promise<unknown>;
