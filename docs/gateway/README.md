# @nest-mcp/gateway

The gateway package lets you aggregate multiple upstream MCP servers behind a single NestJS endpoint. Downstream clients see one unified server with tools, resources, prompts, and resource templates collected from all connected upstreams.

## Features

- **Upstream aggregation** -- connect to multiple MCP servers via Streamable HTTP, SSE, or STDIO
- **Prefix-based routing** -- tools and prompts are namespaced by upstream (e.g. `weather_forecast`)
- **Policy engine** -- allow, deny, or require approval for tool calls based on glob patterns and RBAC/ABAC context
- **Response caching** -- optional TTL-based caching with per-tool rules and max-size eviction
- **Request/response transforms** -- hook into the call pipeline with custom functions
- **Health checks** -- periodic ping-based health monitoring with configurable interval and timeout
- **Task proxying** -- downstream clients can list, get, cancel, and fetch payloads for upstream tasks
- **Sampling and elicitation forwarding** -- upstream servers can request sampling/elicitation during tool calls and the gateway forwards these to the downstream client

## Installation

```bash
npm install @nest-mcp/gateway @nest-mcp/server @nest-mcp/client @nest-mcp/common
```

Peer dependencies:

```bash
npm install @modelcontextprotocol/sdk @nestjs/common @nestjs/core reflect-metadata rxjs
```

## Quick start

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
        {
          name: 'github',
          transport: 'streamable-http',
          url: 'http://localhost:4002/mcp',
          toolPrefix: 'gh',
        },
      ],
    }),
  ],
})
export class AppModule {}
```

With this configuration a downstream client connecting to the gateway will see tools like `weather_forecast` and `gh_search` -- calls are transparently forwarded to the correct upstream.

## Documentation

| Topic | Description |
|-------|-------------|
| [Getting Started](./getting-started.md) | Minimal gateway example with two upstreams |
| [Module](./module.md) | `forRoot` / `forRootAsync` full option reference |
| [Upstreams](./upstreams.md) | `UpstreamConfig`: transport, auth, health, reconnect |
| [Routing](./routing.md) | Prefix-based naming for tools, resources, and prompts |
| [Policies](./policies.md) | Allow/deny/require_approval rules with RBAC/ABAC |
| [Caching](./caching.md) | TTL, maxSize, per-tool rules, invalidation |
| [Transforms](./transforms.md) | Request and response transform hooks |
| [Health](./health.md) | HealthCheckerService: interval, timeout, setHealthy |
| [Sampling & Elicitation](./sampling-elicitation.md) | How sampling/elicitation is forwarded upstream to downstream |
| [Tasks](./tasks.md) | TaskAggregatorService: ID prefixing, list/get/cancel |

## See Also

- [@nest-mcp/server](../server/README.md) -- the underlying MCP server the gateway builds on
- [@nest-mcp/client](../client/README.md) -- standalone MCP client package
- [@nest-mcp/common](../common/README.md) -- shared types and utilities
