import type { McpMiddleware } from '@btwld/mcp-server';

export const timingMiddleware: McpMiddleware = async (ctx, args, next) => {
  const start = performance.now();
  try {
    const result = await next();
    const duration = (performance.now() - start).toFixed(2);
    console.log(`[Timing] ${ctx.type}:${ctx.name} took ${duration}ms`);
    return result;
  } catch (error) {
    const duration = (performance.now() - start).toFixed(2);
    console.error(`[Timing] ${ctx.type}:${ctx.name} errored after ${duration}ms`);
    throw error;
  }
};
