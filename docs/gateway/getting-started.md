# Getting Started

This guide walks through a minimal MCP gateway that aggregates two upstream servers and exposes their tools through a single endpoint.

## Prerequisites

Install the gateway and its peer dependencies:

```bash
npm install @nest-mcp/gateway @nest-mcp/server @nest-mcp/client @nest-mcp/common
npm install @modelcontextprotocol/sdk @nestjs/common @nestjs/core reflect-metadata rxjs
```

## Example: Two upstreams

Assume you have two MCP servers running:

- **Weather server** at `http://localhost:4001/mcp` exposing a `forecast` tool
- **GitHub server** at `http://localhost:4002/mcp` exposing a `search` tool

### 1. Create the gateway module

```typescript
// app.module.ts
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

### 2. Bootstrap the application

```typescript
// main.ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(3000);
}
bootstrap();
```

### 3. Connect a client

A downstream MCP client connecting to `http://localhost:3000/mcp` will see two tools:

| Gateway tool name | Upstream | Original tool name |
|---|---|---|
| `weather_forecast` | weather | `forecast` |
| `gh_search` | github | `search` |

When the client calls `weather_forecast`, the gateway:

1. Strips the `weather_` prefix to recover the original tool name `forecast`
2. Resolves the route to the `weather` upstream
3. Checks policies (default: allow)
4. Checks the response cache
5. Applies any registered request transforms
6. Forwards the call to the weather server
7. Applies any registered response transforms
8. Caches the response (if caching is enabled and the call succeeded)
9. Returns the result to the downstream client

## Using STDIO upstreams

You can also connect to upstream servers via STDIO:

```typescript
McpGatewayModule.forRoot({
  server: { name: 'my-gateway', version: '1.0.0' },
  upstreams: [
    {
      name: 'local-tool',
      transport: 'stdio',
      command: 'node',
      args: ['./mcp-server.js'],
      toolPrefix: 'local',
    },
  ],
})
```

## Adding policies and caching

```typescript
McpGatewayModule.forRoot({
  server: { name: 'my-gateway', version: '1.0.0' },
  upstreams: [
    {
      name: 'weather',
      transport: 'streamable-http',
      url: 'http://localhost:4001/mcp',
      toolPrefix: 'weather',
    },
  ],
  policies: {
    defaultEffect: 'allow',
    rules: [
      { pattern: 'weather_dangerous*', effect: 'deny', reason: 'Blocked by policy' },
    ],
  },
  cache: {
    enabled: true,
    defaultTtl: 30000,
    rules: [
      { pattern: 'weather_forecast', ttl: 60000 },
    ],
  },
})
```

## See Also

- [Module](./module.md) -- full `forRoot` / `forRootAsync` option reference
- [Upstreams](./upstreams.md) -- transport types, health checks, and reconnection
- [Routing](./routing.md) -- how prefix-based naming works
