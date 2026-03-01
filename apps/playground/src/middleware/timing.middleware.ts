import type { McpMiddleware } from '@nest-mcp/server';

export const timingMiddleware: McpMiddleware = async (ctx, args, next) => {
  const start = performance.now();
  try {
    const result = await next();
    const duration = (performance.now() - start).toFixed(2);
    console.log(`[Timing] ${ctx.transport} took ${duration}ms (session: ${ctx.sessionId})`);
    return result;
  } catch (error) {
    const duration = (performance.now() - start).toFixed(2);
    console.error(`[Timing] ${ctx.transport} errored after ${duration}ms`);
    throw error;
  }
};
