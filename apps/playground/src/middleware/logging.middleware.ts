import type { McpMiddleware } from '@btwld/mcp-server';

export const loggingMiddleware: McpMiddleware = async (ctx, args, next) => {
  const start = Date.now();
  console.log(`[MCP] ${ctx.transport} started (session: ${ctx.sessionId})`);
  try {
    const result = await next();
    console.log(`[MCP] ${ctx.transport} completed in ${Date.now() - start}ms`);
    return result;
  } catch (error) {
    console.error(`[MCP] ${ctx.transport} failed in ${Date.now() - start}ms`);
    throw error;
  }
};
