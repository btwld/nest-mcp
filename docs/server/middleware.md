# Middleware

Middleware functions intercept tool, resource, and prompt requests. They execute in a chain before the handler, with the ability to modify context, arguments, or short-circuit the request.

## McpMiddleware Type

```typescript
type McpMiddleware = (
  ctx: McpExecutionContext,
  args: unknown,
  next: () => Promise<unknown>,
) => Promise<unknown>;
```

- `ctx` -- The execution context with session info, user, logging, etc.
- `args` -- The request arguments (tool parameters, resource URI, etc.)
- `next` -- Call to proceed to the next middleware or the handler

You **must** call `next()` to continue the chain. Omitting it short-circuits the request.

## @UseMiddleware

Apply middleware to a specific tool handler:

```typescript
import { Injectable } from '@nestjs/common';
import { Tool, UseMiddleware } from '@nest-mcp/server';
import type { McpExecutionContext, McpMiddleware } from '@nest-mcp/common';
import { z } from 'zod';

const loggingMiddleware: McpMiddleware = async (ctx, args, next) => {
  ctx.log.info('Tool called', { args });
  const startTime = Date.now();
  const result = await next();
  ctx.log.info('Tool completed', { duration: Date.now() - startTime });
  return result;
};

@Injectable()
export class ToolsService {
  @Tool({
    name: 'process',
    description: 'Process data',
    parameters: z.object({ data: z.string() }),
  })
  @UseMiddleware(loggingMiddleware)
  async process(args: { data: string }) {
    return { content: [{ type: 'text', text: `Processed: ${args.data}` }] };
  }
}
```

Multiple middleware can be passed to `@UseMiddleware`:

```typescript
@UseMiddleware(authMiddleware, loggingMiddleware, validationMiddleware)
```

They execute in the order provided (left to right).

## Global Middleware

Apply middleware to all requests via `McpModule.forRoot`:

```typescript
import { McpModule } from '@nest-mcp/server';
import { McpTransportType } from '@nest-mcp/common';

const auditMiddleware: McpMiddleware = async (ctx, args, next) => {
  ctx.log.info(`Request from session ${ctx.sessionId}`);
  return next();
};

McpModule.forRoot({
  name: 'my-server',
  version: '1.0.0',
  transport: McpTransportType.STREAMABLE_HTTP,
  middleware: [auditMiddleware],
});
```

## Execution Order

Global middleware runs before per-tool middleware:

```
Global middleware[0] -> Global middleware[1] -> ... ->
  Per-tool middleware[0] -> Per-tool middleware[1] -> ... ->
    Handler
```

Per-tool middleware is only supported for tools (via `@UseMiddleware`). Resource and prompt handlers only receive global middleware.

## MiddlewareService

The `MiddlewareService` executes middleware chains internally. It is used by the `ExecutionPipelineService` and generally does not need to be used directly.

```typescript
@Injectable()
export class MiddlewareService {
  async executeChain(
    middleware: McpMiddleware[],
    ctx: McpExecutionContext,
    args: unknown,
    handler: () => Promise<unknown>,
  ): Promise<unknown>;
}
```

If the middleware array is empty, the handler is called directly.

## Common Patterns

### Request Timing

```typescript
const timingMiddleware: McpMiddleware = async (ctx, args, next) => {
  const start = Date.now();
  try {
    return await next();
  } finally {
    ctx.log.info(`Duration: ${Date.now() - start}ms`);
  }
};
```

### Argument Transformation

```typescript
const normalizeMiddleware: McpMiddleware = async (ctx, args, next) => {
  const normalized = { ...(args as Record<string, unknown>) };
  if (typeof normalized.query === 'string') {
    normalized.query = normalized.query.trim().toLowerCase();
  }
  // Note: args is passed by reference through the chain,
  // but the handler receives the original validated args.
  return next();
};
```

### Error Handling

```typescript
const errorMiddleware: McpMiddleware = async (ctx, args, next) => {
  try {
    return await next();
  } catch (error) {
    ctx.log.error('Request failed', { error: String(error) });
    return {
      content: [{ type: 'text', text: 'An error occurred' }],
      isError: true,
    };
  }
};
```

## See Also

- [Decorators](./decorators.md) -- Core decorators
- [Execution Pipeline](./execution-pipeline.md) -- How middleware fits in the request lifecycle
- [Module](./module.md) -- Global middleware configuration
