# McpGatewayModule

The `McpGatewayModule` is the main entry point for configuring the MCP gateway. It provides two static methods for registration: `forRoot` (synchronous) and `forRootAsync` (factory-based).

## forRoot

Use `forRoot` when all configuration values are available at module declaration time.

```typescript
import { Module } from '@nestjs/common';
import { McpGatewayModule } from '@nest-mcp/gateway';

@Module({
  imports: [
    McpGatewayModule.forRoot({
      server: {
        name: 'my-gateway',
        version: '1.0.0',
      },
      upstreams: [
        {
          name: 'weather',
          transport: 'streamable-http',
          url: 'http://localhost:4001/mcp',
          toolPrefix: 'weather',
        },
      ],
    }),
  ],
})
export class AppModule {}
```

### McpGatewayOptions

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `server` | `McpModuleOptions` | Yes | Options passed to the underlying `McpModule.forRoot`. Must include `name` and `version`. |
| `upstreams` | `UpstreamConfig[]` | Yes | List of upstream MCP servers to connect to. See [Upstreams](./upstreams.md). |
| `routing` | `RoutingConfig` | No | Routing strategy configuration. Defaults to `{ toolRouting: 'prefix', aggregateToolLists: true }`. See [Routing](./routing.md). |
| `policies` | `PoliciesConfig` | No | Policy rules for tool access control. Defaults to `{ defaultEffect: 'allow', rules: [] }`. See [Policies](./policies.md). |
| `cache` | `CacheConfig` | No | Response caching configuration. Defaults to `{ enabled: false, defaultTtl: 60000 }`. See [Caching](./caching.md). |
| `roots` | `Root[]` | No | Roots advertised to upstream servers when they send a `roots/list` request. |

### Server options

The `server` property accepts the same `McpModuleOptions` used by `@nest-mcp/server`. The gateway automatically sets the transport to `streamable-http` if not specified and enables the `tasks` capability so that downstream clients can interact with upstream tasks.

```typescript
server: {
  name: 'my-gateway',
  version: '1.0.0',
  transport: 'streamable-http',    // default
  capabilities: { logging: {} },   // tasks: { enabled: true } is added automatically
}
```

## forRootAsync

Use `forRootAsync` when configuration depends on other NestJS providers (e.g. `ConfigService`).

```typescript
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { McpGatewayModule } from '@nest-mcp/gateway';

@Module({
  imports: [
    McpGatewayModule.forRootAsync({
      imports: [ConfigModule],
      server: { transport: 'streamable-http' },
      useFactory: (config: ConfigService) => ({
        server: {
          name: config.get('GATEWAY_NAME', 'my-gateway'),
          version: '1.0.0',
        },
        upstreams: [
          {
            name: 'weather',
            transport: 'streamable-http',
            url: config.get('WEATHER_URL'),
            toolPrefix: 'weather',
          },
        ],
      }),
      inject: [ConfigService],
    }),
  ],
})
export class AppModule {}
```

### McpGatewayAsyncOptions

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `imports` | `any[]` | No | NestJS modules to import (e.g. `ConfigModule`). |
| `server` | `{ transport, transportOptions? }` | Yes | Transport type(s) for the underlying MCP server. Needed before the factory runs. |
| `useFactory` | `(...args) => McpGatewayOptions \| Promise<McpGatewayOptions>` | Yes | Factory function that returns the full gateway options. |
| `inject` | `any[]` | No | Providers to inject into the factory function. |

## Bootstrap lifecycle

On application bootstrap (`onApplicationBootstrap`), the module runs the following steps in order:

1. **Configure routing** -- sets up prefix mappings from `UpstreamConfig[]`
2. **Configure policies** -- loads policy rules into the `PolicyEngineService`
3. **Configure cache** -- initializes the `ResponseCacheService`
4. **Connect to upstreams** -- calls `UpstreamManagerService.connectAll()` with the configured upstreams and optional roots
5. **Start health checks** -- starts periodic ping-based health checks for each upstream
6. **Register task handlers** -- sets up task list/get/cancel/payload proxy handlers
7. **Register tools** -- aggregates tools from all upstreams and registers them on the MCP server
8. **Register resources** -- aggregates resources from all upstreams
9. **Register prompts** -- aggregates prompts from all upstreams
10. **Register resource templates** -- aggregates resource templates from all upstreams
11. **Register completion handlers** -- sets up autocompletion for prompts and resource templates

## Exported providers

The module exports all core services so they can be injected in other modules:

- `GatewayService`
- `UpstreamManagerService`
- `HealthCheckerService`
- `RouterService`
- `ToolAggregatorService`
- `PolicyEngineService`
- `ResponseCacheService`
- `RequestTransformService`
- `ResponseTransformService`
- `ResourceAggregatorService`
- `PromptAggregatorService`
- `ResourceTemplateAggregatorService`
- `TaskAggregatorService`
- `MCP_GATEWAY_OPTIONS` (injection token)

## See Also

- [Getting Started](./getting-started.md) -- minimal working example
- [Upstreams](./upstreams.md) -- upstream configuration reference
- [Routing](./routing.md) -- how prefix routing works
