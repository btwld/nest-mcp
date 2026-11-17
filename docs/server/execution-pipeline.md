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

With the [`nestEnhancers`](#nestjs-enhancers) option on, the handler call itself runs through NestJS guards, interceptors, pipes and exception filters.

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

## NestJS Enhancers

By default a capability handler is a plain method call: `@UseGuards`, `@UseInterceptors` and `@UsePipes` on it do nothing, and cross-cutting concerns are expressed with `@Scopes`, `@Roles`, `@Guards` and `@UseMiddleware`. Set `nestEnhancers: true` to run tool, resource, resource-template and prompt handlers through NestJS's own enhancer pipeline as well:

```typescript
McpModule.forRoot({
  name: 'my-server',
  version: '1.0.0',
  transport: McpTransportType.STREAMABLE_HTTP,
  nestEnhancers: true,
});
```

```typescript
import { Injectable, UseFilters, UseGuards, UseInterceptors } from '@nestjs/common';
import { Tool } from '@nest-mcp/server';
import type { McpExecutionContext } from '@nest-mcp/common';
import { z } from 'zod';

@Injectable()
@UseInterceptors(AuditInterceptor)
export class OrderTools {
  @Tool({
    name: 'cancel-order',
    description: 'Cancel an order',
    parameters: z.object({ orderId: z.string() }),
  })
  @UseGuards(OrderOwnerGuard)
  @UseFilters(OrderErrorFilter)
  async cancel(args: { orderId: string }, ctx: McpExecutionContext) {
    // ...
  }
}
```

Nest resolves the enhancers, so constructor injection works, and all three registration levels apply: method, class, and application (`APP_GUARD`, `APP_INTERCEPTOR`, `APP_PIPE`, `APP_FILTER`, `app.useGlobalGuards()` and friends).

### The `'mcp'` Context Type

Enhancers receive a regular `ExecutionContext`:

| Method | Value |
|--------|-------|
| `getType()` | `'mcp'` |
| `getClass()` / `getHandler()` | The provider class and handler method, so `Reflector` and custom metadata decorators work |
| `getArgs()` | The handler's own arguments: `(args, ctx)` for tools and prompts, `(uri, ctx)` for resources, `(uri, params, ctx)` for resource templates |

`McpArgumentsHost` reads those without indexing into `getArgs()`. It works with the `ExecutionContext` of a guard or interceptor and with the `ArgumentsHost` of an exception filter:

| Method | Returns |
|--------|---------|
| `McpArgumentsHost.create(host)` | The MCP view of `host`. Throws when `host.getType()` is not `'mcp'` |
| `getKind()` | `'tool'`, `'resource'` (resource templates included) or `'prompt'` |
| `getName()` | Tool or prompt name; for resources, the requested URI |
| `getArgs<T>()` | Validated tool or prompt arguments; for resources, the URI template variables (`{}` for fixed URIs) |
| `getContext()` | The `McpExecutionContext` of the call — the same object the handler receives |

```typescript
import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { McpArgumentsHost, type McpContextType } from '@nest-mcp/server';

@Injectable()
export class AdminToolsGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    // Not an MCP call (for example the HTTP request itself): nothing to decide here.
    if (context.getType<McpContextType>() !== 'mcp') return true;

    const mcp = McpArgumentsHost.create(context);
    if (mcp.getKind() !== 'tool') return true;
    return mcp.getContext().user?.roles?.includes('admin') === true;
  }
}
```

`McpContextType` is Nest's `ContextType` plus `'mcp'`, so the comparison type-checks.

### Where Enhancers Run

Everything described above keeps running, in the same order, and the enhancers wrap the handler call at the innermost position:

```
1. Request context
2. Module guards (McpModule.forRoot({ guards }))
3. Auth check (@Public / @Scopes / @Roles / @Guards)
4. Middleware chain (global + @UseMiddleware)
   4a-d. Rate limit, circuit breaker, retry, timeout
   4e. McpExecutorService
       - Input validation (Zod `parameters`)
       - Nest guards        (application, class, method)
       - Nest interceptors  (application, class, method)
       - Nest pipes
       - Handler
       - Nest exception filters, around guards, interceptors, pipes and handler
       - Result normalization and `outputSchema` validation
5. Metrics
```

Consequences worth knowing:

- A call rejected by `@Scopes`, `@Roles`, `@Guards` or a module guard never reaches a Nest guard.
- Input is validated first, so guards and interceptors see validated arguments, and a call with invalid arguments is answered before any Nest guard runs.
- Enhancers sit inside the retry wrapper: with `@Retry`, guards and interceptors run again on every attempt.
- List requests and `@Completion` handlers do not go through the enhancers.

### Pipes

Pipes run for every handler parameter, as in other non-HTTP Nest contexts. `ArgumentMetadata.type` tells them apart:

| Parameter | `metadata.type` |
|-----------|-----------------|
| Tool and prompt arguments | `'body'` |
| URI template variables | `'param'` |
| Resource URI, execution context | `'custom'` |

`metadata.metatype` is the parameter's declared type, so `ValidationPipe` validates arguments typed with a class. Pipes that transform should leave everything but the input alone:

```typescript
@Injectable()
export class TrimPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata) {
    return metadata.type === 'body' ? trimStrings(value) : value;
  }
}
```

### Exception Filters

Filters wrap guards, interceptors, pipes and the handler, and follow Nest's rules for non-HTTP contexts:

- **Return a value** to answer the call with it. For a tool, return a tool result — usually `{ isError: true, content: [...] }` — or a string; for a resource or prompt, return what the handler would have returned.
- **Throw** to answer with an error. Throw an `McpError` to choose the JSON-RPC code.
- A filter that returns nothing has not handled the exception; it continues as if no filter matched.

```typescript
@Catch(OutOfStockError)
export class OutOfStockFilter implements ExceptionFilter {
  constructor(private readonly i18n: I18nService) {}

  catch(error: OutOfStockError, host: ArgumentsHost) {
    const mcp = McpArgumentsHost.create(host);
    return {
      isError: true,
      content: [{ type: 'text', text: this.i18n.t('out-of-stock', { tool: mcp.getName() }) }],
    };
  }
}
```

Exceptions that no filter handles are reported as follows:

| Exception | Tool call | Resource read / prompt get |
|-----------|-----------|----------------------------|
| Guard returns `false`, `ForbiddenException` | `AuthorizationError`, like a `@Scopes` / `@Roles` / `@Guards` denial | `AuthorizationError` |
| `UnauthorizedException` | `AuthenticationError` | `AuthenticationError` |
| `BadRequestException` (for example from `ValidationPipe`) | Tool result with `isError: true` and the validation messages | `ValidationError` (invalid params) |
| `AuthorizationError`, `AuthenticationError`, `ToolExecutionError`, `ValidationError` | Unchanged | Unchanged |
| Other `McpError` | `ToolExecutionError` | Unchanged |
| Anything else | `ToolExecutionError` | Unchanged |

Nest logs exceptions that no filter handles through its `ExceptionsHandler` logger before they are reported.

With `nestEnhancers` off, `@UseFilters` on a capability is handled by a simpler built-in runner instead: filters are created with `new` (no injection), only method- and class-level filters are considered, and whatever the filter returns is sent as the message of a JSON-RPC error. With the option on that runner is skipped, so a filter never runs twice.

### Application-Level Enhancers and Why This Is Opt-In

Once `nestEnhancers` is on, application-level enhancers run for MCP calls too — including the ones that were written with only HTTP in mind. A guard like this would throw on the first tool call, because there is no HTTP request to read:

```typescript
canActivate(context: ExecutionContext) {
  const request = context.switchToHttp().getRequest();
  return Boolean(request.session?.userId);
}
```

Before enabling the option, make every application-level guard, interceptor, pipe and filter decide what to do with an `'mcp'` context — typically by returning early:

```typescript
canActivate(context: ExecutionContext) {
  if (context.getType<McpContextType>() === 'mcp') return true; // MCP calls are authorized by their own guards
  const request = context.switchToHttp().getRequest();
  return Boolean(request.session?.userId);
}
```

The same guard also still runs for the HTTP request that carries the MCP message, with the `'http'` context type, exactly as it does today.

### Limitations

- **Request- or transient-scoped application-level enhancers** (`{ provide: APP_GUARD, useClass: X, scope: Scope.REQUEST }`) are only instantiated by Nest for controllers. Rather than skip them for MCP calls, the application refuses to start while `nestEnhancers` is on. Request-scoped enhancers attached to a method or class are supported.
- **Enhancers referenced by class** (`@UseGuards(MyGuard)`) are resolved from the module that lists the capability's provider class in `providers` (`McpModule.forFeature([OrderTools])` does). If the provider is registered under a custom token (`{ provide: TOKEN, useClass: OrderTools }`), Nest cannot resolve them, and the call fails instead of running unguarded.
- **Capabilities registered through the dynamic builders** have no class or method to decorate. Application-level guards, interceptors and filters apply to them; pipes do not.

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
