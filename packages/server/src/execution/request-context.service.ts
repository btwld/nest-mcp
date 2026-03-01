import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { McpExecutionContext } from '@nest-mcp/common';

@Injectable()
export class McpRequestContextService {
  private readonly storage = new AsyncLocalStorage<McpExecutionContext>();

  run<T>(context: McpExecutionContext, fn: () => T): T {
    return this.storage.run(context, fn);
  }

  getContext(): McpExecutionContext | undefined {
    return this.storage.getStore();
  }
}
