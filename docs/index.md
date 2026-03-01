# nest-mcp Documentation

**nest-mcp** is a NestJS toolkit for building [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) applications. It provides three independent packages that cover the full MCP stack: a server that exposes tools and resources to AI clients, a client that consumes remote MCP servers, and a gateway that aggregates multiple servers behind a single endpoint.

## Packages

| Package | npm | Description |
|---------|-----|-------------|
| [`@nest-mcp/server`](./server/README.md) | `npm install @nest-mcp/server` | Build MCP servers with NestJS decorators, auth, resilience, and multi-transport support |
| [`@nest-mcp/client`](./client/README.md) | `npm install @nest-mcp/client` | Connect to and consume MCP servers with typed injection, notifications, and health checks |
| [`@nest-mcp/gateway`](./gateway/README.md) | `npm install @nest-mcp/gateway` | Aggregate multiple upstream servers behind one unified MCP endpoint |

A shared `@nest-mcp/common` package provides types and utilities used across all packages.

## Architecture

```
┌─────────────────────────────────────────────┐
│              AI Client (LLM host)            │
└──────────────────────┬──────────────────────┘
                       │ MCP (Streamable HTTP / SSE / STDIO)
          ┌────────────▼────────────┐
          │   @nest-mcp/gateway     │  ← optional aggregation layer
          │  (NestJS application)   │
          └──┬──────────────┬───────┘
             │              │ upstream MCP connections (@nest-mcp/client)
  ┌──────────▼──┐    ┌──────▼──────┐
  │  @nest-mcp/ │    │  @nest-mcp/ │  ← MCP servers built with @nest-mcp/server,
  │   server A  │    │   server B  │     or any other MCP-compatible server
  └─────────────┘    └─────────────┘
```

### When to use each package

**Use `@nest-mcp/server`** when you want to expose tools, resources, and prompts from a NestJS service to AI clients. The server handles authentication, rate limiting, circuit breaking, retries, middleware, and multiple transport protocols.

**Use `@nest-mcp/client`** when your NestJS application needs to call tools or read resources from an existing MCP server. You can inject named clients, handle server-sent notifications, and monitor connection health.

**Use `@nest-mcp/gateway`** when you have multiple upstream MCP servers and want to present a single unified server to downstream clients. The gateway handles prefix-based routing, policy enforcement, caching, and request/response transforms.

## Quick installation

```bash
# Server only
npm install @nest-mcp/server @nest-mcp/common @modelcontextprotocol/sdk

# Client only
npm install @nest-mcp/client @modelcontextprotocol/sdk

# Gateway (includes server + client)
npm install @nest-mcp/gateway @nest-mcp/server @nest-mcp/client @nest-mcp/common @modelcontextprotocol/sdk
```

Peer dependencies (required for all packages):

```bash
npm install @nestjs/common @nestjs/core reflect-metadata rxjs
```

## Minimal examples

### Server

```typescript
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { McpModule } from '@nest-mcp/server';
import { McpTransportType } from '@nest-mcp/common';
import { ToolsService } from './tools.service';

@Module({
  imports: [
    McpModule.forRoot({
      name: 'my-server',
      version: '1.0.0',
      transports: [{ type: McpTransportType.STREAMABLE_HTTP }],
    }),
  ],
  providers: [ToolsService],
})
export class AppModule {}
```

```typescript
import { Injectable } from '@nestjs/common';
import { Tool } from '@nest-mcp/server';
import { z } from 'zod';

@Injectable()
export class ToolsService {
  @Tool({ name: 'greet', description: 'Greet a user', schema: z.object({ name: z.string() }) })
  async greet({ name }: { name: string }) {
    return `Hello, ${name}!`;
  }
}
```

See [server/getting-started.md](./server/getting-started.md) for the full walkthrough.

### Client

```typescript
import { Module } from '@nestjs/common';
import { McpClientModule } from '@nest-mcp/client';
import { McpTransportType } from '@nest-mcp/common';

@Module({
  imports: [
    McpClientModule.forRoot({
      connections: [
        {
          name: 'my-server',
          transport: { type: McpTransportType.STREAMABLE_HTTP, url: 'http://localhost:3000/mcp' },
        },
      ],
    }),
  ],
})
export class AppModule {}
```

```typescript
import { Injectable } from '@nestjs/common';
import { InjectMcpClient, McpClient } from '@nest-mcp/client';

@Injectable()
export class MyService {
  constructor(@InjectMcpClient('my-server') private client: McpClient) {}

  async greet(name: string) {
    return this.client.callTool({ name: 'greet', arguments: { name } });
  }
}
```

See [client/getting-started.md](./client/getting-started.md) for the full walkthrough.

### Gateway

```typescript
import { Module } from '@nestjs/common';
import { McpGatewayModule } from '@nest-mcp/gateway';
import { McpTransportType } from '@nest-mcp/common';

@Module({
  imports: [
    McpGatewayModule.forRoot({
      name: 'my-gateway',
      version: '1.0.0',
      upstreams: [
        { name: 'weather', transport: { type: McpTransportType.STREAMABLE_HTTP, url: 'http://weather-service/mcp' } },
        { name: 'search',  transport: { type: McpTransportType.STREAMABLE_HTTP, url: 'http://search-service/mcp' } },
      ],
    }),
  ],
})
export class AppModule {}
```

See [gateway/getting-started.md](./gateway/getting-started.md) for the full walkthrough.

---

## Documentation

### @nest-mcp/server

| Page | Description |
|------|-------------|
| [README](./server/README.md) | Overview, install, quick start |
| [Getting Started](./server/getting-started.md) | Minimal working example |
| [Module](./server/module.md) | `McpModule.forRoot` / `forRootAsync` / `forFeature` options |
| [Decorators](./server/decorators.md) | `@Tool`, `@Resource`, `@ResourceTemplate`, `@Prompt`, `@Completion` |
| [Auth Decorators](./server/auth-decorators.md) | `@Public`, `@Scopes`, `@Roles`, `@Guards` |
| [Resilience Decorators](./server/resilience-decorators.md) | `@RateLimit`, `@Retry`, `@CircuitBreaker`, `@Timeout` |
| [Transports](./server/transports.md) | Streamable HTTP, SSE, STDIO config |
| [Auth](./server/auth.md) | `McpAuthModule`, OAuth 2.1, JWT, custom stores |
| [Resilience](./server/resilience.md) | `RateLimiterService`, `CircuitBreakerService`, `RetryService` |
| [Middleware](./server/middleware.md) | `@UseMiddleware`, `McpMiddleware`, `MiddlewareService` |
| [Dynamic Builders](./server/dynamic-builders.md) | `McpToolBuilder`, `McpResourceBuilder`, `McpPromptBuilder` |
| [Execution Pipeline](./server/execution-pipeline.md) | Request lifecycle, context, cancellation |
| [Sessions](./server/sessions.md) | `SessionManager`, `ResourceSubscriptionManager`, `TaskManager` |
| [Testing](./server/testing.md) | `createMcpTestApp`, `mockMcpContext`, testing patterns |

### @nest-mcp/client

| Page | Description |
|------|-------------|
| [README](./client/README.md) | Overview, install, quick start |
| [Getting Started](./client/getting-started.md) | Minimal example: connect + call tool |
| [Module](./client/module.md) | `McpClientModule.forRoot` / `forRootAsync` |
| [Connections](./client/connections.md) | SSE, Streamable HTTP, STDIO configs and auth |
| [Injection](./client/injection.md) | `@InjectMcpClient`, `McpClientsService`, `getMcpClientToken` |
| [Client API](./client/client-api.md) | `callTool`, `listAllTools`, `readResource`, and more |
| [Notifications](./client/notifications.md) | `@OnMcpNotification` handler wiring |
| [Reconnection](./client/reconnection.md) | Auto-reconnect config, backoff behavior |
| [OAuth](./client/oauth.md) | OAuth utilities, `OAuthClientProvider` |
| [Health](./client/health.md) | `McpClientHealthIndicator`, `McpClientHealthStatus` |
| [Testing](./client/testing.md) | `MockMcpClient`, NestJS DI integration |

### @nest-mcp/gateway

| Page | Description |
|------|-------------|
| [README](./gateway/README.md) | Overview, install, quick start |
| [Getting Started](./gateway/getting-started.md) | Minimal 2-upstream gateway example |
| [Module](./gateway/module.md) | `McpGatewayModule.forRoot` / `forRootAsync` |
| [Upstreams](./gateway/upstreams.md) | `UpstreamConfig`, health, reconnect, `UpstreamManagerService` |
| [Routing](./gateway/routing.md) | Prefix-based naming, `RouterService`, aggregators |
| [Policies](./gateway/policies.md) | Allow/deny/require-approval rules, RBAC/ABAC |
| [Caching](./gateway/caching.md) | `CacheConfig`, TTL rules, eviction, invalidation |
| [Transforms](./gateway/transforms.md) | `RequestTransformService`, `ResponseTransformService` |
| [Health](./gateway/health.md) | `HealthCheckerService`, interval, timeout |
| [Sampling & Elicitation](./gateway/sampling-elicitation.md) | Forwarding upstream→downstream |
| [Tasks](./gateway/tasks.md) | `TaskAggregatorService`, ID prefixing, list/get/cancel |

---

## See Also

- [Model Context Protocol specification](https://modelcontextprotocol.io/)
- [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk)
- [NestJS documentation](https://docs.nestjs.com/)
