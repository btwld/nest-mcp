# Dependency Injection

MCP feature providers (`@Tool`, `@Resource`, `@ResourceTemplate`, `@Prompt`,
`@Completion`) are plain NestJS providers: constructor injection, module
imports, and `forFeature` scoping all work as usual. This page covers the two
scoping models and how per-request data reaches your handlers.

## Singleton providers (default)

Providers with the default scope are discovered once at boot and invoked as
singletons. This is the right choice for almost all tools:

```typescript
@Injectable()
export class WeatherTools {
  constructor(private readonly weather: WeatherService) {}

  @Tool({ name: 'get-forecast', description: 'Get forecast', parameters: z.object({ city: z.string() }) })
  getForecast({ city }: { city: string }, ctx: McpExecutionContext) {
    // per-request data comes in through the context, not the constructor
    ctx.log.info(`forecast for ${city}`, { user: ctx.user?.id });
    return this.weather.forecast(city);
  }
}
```

### Per-request data on the context

Singleton handlers receive everything request-specific through the
`McpExecutionContext` second argument:

| Field | Contents |
|-------|----------|
| `ctx.request` | The HTTP request info that delivered this JSON-RPC message (`{ headers }` on streamable HTTP) |
| `ctx.user` | Authenticated user derived from the verified bearer token |
| `ctx.authInfo` | Raw verified token identity (scopes, clientId, claims) |
| `ctx.sessionId` / `ctx.transport` | Session and transport of the call |
| `ctx.signal` | Abort signal (client cancellation) |

Prefer the context over request-scoped DI — it has no per-call instantiation
cost and works identically on every transport (including STDIO, which has no
HTTP request).

## Request-scoped providers

Providers declared with `Scope.REQUEST` (or `Scope.TRANSIENT`, or any provider
whose dependency tree contains one) are also discovered at boot — by class —
and a **fresh instance is resolved for every call**. The MCP request info is
registered as the `REQUEST` token, so `@Inject(REQUEST)` works:

```typescript
import { Inject, Injectable, Scope } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

@Injectable({ scope: Scope.REQUEST })
export class TenantTools {
  constructor(@Inject(REQUEST) private readonly request: { headers?: Record<string, unknown> }) {}

  @Tool({ name: 'whoami', description: 'Echo the calling tenant', parameters: z.object({}) })
  whoami() {
    return `tenant:${this.request?.headers?.['x-tenant'] ?? 'anonymous'}`;
  }
}
```

Notes:

- The injected `REQUEST` value is the **MCP request info** (`{ headers }`),
  not a full Express/Fastify request object. On transports without per-message
  HTTP requests (STDIO), it is the transport-level request or `undefined` —
  guard accordingly.
- Resolution happens per capability call (`tools/call`, `resources/read`,
  `prompts/get`, `completion/complete`), so request-scoped dependencies (e.g.
  a per-tenant database connection) are constructed per call and garbage
  collected afterwards. Expect the usual request-scope instantiation overhead.
- Listing endpoints (`tools/list` etc.) never instantiate providers; they use
  the metadata captured at scan time.

## See Also

- [Module configuration](./module.md)
- [Decorators](./decorators.md)
- [Execution pipeline](./execution-pipeline.md)
