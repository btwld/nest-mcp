import type { McpExecutionContext, McpMiddleware } from '@nest-mcp/common';
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
    if (middleware.length === 0) return handler();

    const dispatch = (i: number): Promise<unknown> => {
      if (i >= middleware.length) return handler();
      return middleware[i](ctx, args, () => dispatch(i + 1));
    };

    return dispatch(0);
  }
}
