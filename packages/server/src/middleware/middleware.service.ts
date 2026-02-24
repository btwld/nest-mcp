import type { McpExecutionContext, McpMiddleware } from '@btwld/mcp-common';
import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class MiddlewareService {
  private readonly logger = new Logger(MiddlewareService.name);

  async executeChain(
    middleware: McpMiddleware[],
    ctx: McpExecutionContext,
    args: unknown,
    handler: () => Promise<unknown>,
  ): Promise<unknown> {
    if (middleware.length === 0) {
      return handler();
    }

    let index = 0;

    const next = async (): Promise<unknown> => {
      if (index >= middleware.length) {
        return handler();
      }
      const mw = middleware[index++];
      return mw(ctx, args, next);
    };

    return next();
  }
}
