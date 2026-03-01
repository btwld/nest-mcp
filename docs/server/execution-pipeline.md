# Execution Pipeline

The `ExecutionPipelineService` orchestrates the full lifecycle of every tool call, resource read, and prompt request. It coordinates auth, middleware, resilience, and the actual handler execution.

## Tool Call Lifecycle

When a client calls a tool, the request passes through these stages:

```
1. Request context (AsyncLocalStorage)
2. Global guards (populate ctx.user)
3. Per-tool auth check (@Public / @Scopes / @Roles / @Guards)
4. Middleware chain (global + per-tool)
   4a. Rate limit check
   4b. Circuit breaker wrapper
   4c. Retry wrapper
   4d. Timeout wrapper
   4e. Handler execution (McpExecutorService.callTool)
5. Metrics recording
6. Response
```

### 1. Request Context

The pipeline wraps execution in `McpRequestContextService.run()`, which uses Node.js `AsyncLocalStorage` to make the `McpExecutionContext` available anywhere in the call stack:

```typescript
import { Injectable } from '@nestjs/common';
import { McpRequestContextService } from '@nest-mcp/server';

@Injectable()
export class MyService {
  constructor(private readonly requestContext: McpRequestContextService) {}

  getCurrentSession(): string | undefined {
    return this.requestContext.getContext()?.sessionId;
  }
}
```

### 2. Global Guards

Guards configured in `McpModule.forRoot({ guards: [...] })` are executed first. They are resolved from the DI container (via `ModuleRef.get`), falling back to direct instantiation.

Global guards typically validate JWT tokens and populate `ctx.user`. After all global guards run, `guardContext.user` is synced back to the execution context.

### 3. Per-tool Auth Check

The `ToolAuthGuardService` performs authorization in order:

1. If `@Public()` is set, skip all checks.
2. If `@Scopes([...])` is set, verify the user has **all** required scopes.
3. If `@Roles([...])` is set, verify the user has **at least one** required role.
4. If `@Guards([...])` is set, run each custom guard class.

Any failure throws an `AuthorizationError`.

### 4. Middleware Chain

The `MiddlewareService` builds a chain of global middleware (from `McpModule.forRoot`) followed by per-tool middleware (from `@UseMiddleware`). Each middleware calls `next()` to proceed.

Inside the innermost middleware, resilience wrappers are applied:

#### 4a. Rate Limit

If `@RateLimit` or global `resilience.rateLimit` is configured, the `RateLimiterService` checks the request against the limit before execution.

#### 4b-c. Circuit Breaker and Retry

The pipeline builds an execution chain:
- The base function calls `McpExecutorService.callTool`
- If retry is configured, it wraps the base function
- If circuit breaker is configured, it wraps the retry function

```
circuitBreaker.execute(toolName, config,
  () => retry.execute(toolName, config,
    () => executor.callTool(name, args, ctx)
  )
)
```

#### 4d. Timeout

If `@Timeout` or global `resilience.timeout` is configured, the entire execution promise is wrapped with a timeout. The timeout also listens for the `AbortSignal` from client cancellation.

#### 4e. Handler Execution

`McpExecutorService.callTool` validates input against the Zod schema, calls the handler method, and normalizes the return value.

### 5. Metrics

The `MetricsService` records the call duration and success/failure status, regardless of whether the call succeeded or failed.

## Resource Read Lifecycle

```
1. Request context
2. Global guards
3. Per-resource auth check (if resource found in registry)
4. Global middleware chain
   4a. Timeout wrapper (if configured)
   4b. McpExecutorService.readResource
       - Exact URI match, or
       - URI template match (with parameter extraction)
5. Response normalization
```

Resources do not support per-item middleware, retry, rate limiting, or circuit breaker decorators.

## Prompt Get Lifecycle

```
1. Request context
2. Global guards
3. Per-prompt auth check (if prompt found in registry)
4. Global middleware chain
   4a. Timeout wrapper (if configured)
   4b. McpExecutorService.getPrompt
       - Input validation against Zod schema
       - Handler invocation
5. Response validation (must return { messages: [...] })
```

Prompts do not support per-item middleware, retry, rate limiting, or circuit breaker decorators.

## McpExecutionContext

The execution context is created per-session by `McpContextFactory` and carries:

| Property | Type | Description |
|----------|------|-------------|
| `sessionId` | `string` | Unique session identifier |
| `transport` | `McpTransportType` | Active transport type |
| `request` | `unknown` | Raw HTTP request (for HTTP transports) |
| `user` | `McpAuthenticatedUser` | Populated by guards |
| `metadata` | `Record<string, unknown>` | Arbitrary key-value store |
| `signal` | `AbortSignal` | Cancellation signal from the client |
| `reportProgress` | `(progress) => Promise<void>` | Report execution progress |
| `streamContent` | `(content) => Promise<void>` | Stream incremental tool output |
| `elicit` | `(params) => Promise<ElicitResult>` | Request user input during execution |
| `createMessage` | `(params) => Promise<McpSamplingResult>` | LLM sampling via the client |
| `notifyResourceUpdated` | `(uri) => Promise<void>` | Notify subscribers of resource changes |
| `log` | `{ debug, info, warn, error }` | Structured logging (also sends to client) |

### Progress Reporting

Tools can report progress when the client provides a `progressToken`:

```typescript
@Tool({ name: 'long-task', description: 'A long task' })
async longTask(args: {}, ctx: McpExecutionContext) {
  for (let i = 0; i <= 100; i += 10) {
    await ctx.reportProgress({ progress: i, total: 100, message: `${i}% done` });
  }
  return { content: [{ type: 'text', text: 'Complete' }] };
}
```

### Cancellation

The `signal` property is an `AbortSignal` that becomes aborted when the client sends a `notifications/cancelled` message. Tools can check `ctx.signal?.aborted` or listen for the abort event.

## Completion Pipeline

Completion requests (`completion/complete`) are handled by `McpExecutorService.complete`:

1. Look up a custom `@Completion` handler for the ref type and name.
2. If found, call the handler and normalize the result (cap at 100 values).
3. If not found, use default completion:
   - For prompts: auto-complete `ZodEnum` fields by filtering values by prefix.
   - For resources: return empty results.

## See Also

- [Decorators](./decorators.md) -- Handler registration
- [Auth Decorators](./auth-decorators.md) -- Auth decorator details
- [Resilience Decorators](./resilience-decorators.md) -- Resilience decorator details
- [Middleware](./middleware.md) -- Middleware chain details
- [Resilience](./resilience.md) -- Resilience service internals
