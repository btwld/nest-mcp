# @nest-mcp/gateway

NestJS module for aggregating multiple upstream [MCP](https://modelcontextprotocol.io/) servers behind a single unified endpoint, with routing, caching, policies, and transforms.

## Installation

```bash
npm install @nest-mcp/gateway @nest-mcp/server @nest-mcp/client @nest-mcp/common @modelcontextprotocol/sdk
npm install @nestjs/common @nestjs/core reflect-metadata rxjs
```

## Quick start

```typescript
// app.module.ts
import { Module } from '@nestjs/common';
import { McpGatewayModule } from '@nest-mcp/gateway';
import { McpTransportType } from '@nest-mcp/common';

@Module({
  imports: [
    McpGatewayModule.forRoot({
      name: 'my-gateway',
      version: '1.0.0',
      upstreams: [
        {
          name: 'weather',
          transport: {
            type: McpTransportType.STREAMABLE_HTTP,
            url: 'http://weather-service/mcp',
          },
        },
        {
          name: 'search',
          transport: {
            type: McpTransportType.STREAMABLE_HTTP,
            url: 'http://search-service/mcp',
          },
        },
      ],
    }),
  ],
})
export class AppModule {}
```

Tools from upstream servers are exposed with a prefix (`weather_forecast`, `search_query`). Downstream clients see one unified MCP server.

## Features

- **Automatic prefixing** — tools, resources, and prompts are namespaced by upstream name
- **Policy engine** — allow/deny/require-approval rules per tool or upstream
- **Response caching** — TTL-based cache for tool results
- **Request/response transforms** — custom hooks to rewrite calls
- **Health monitoring** — periodic ping per upstream
- **Task proxying** — long-running tasks forwarded with upstream prefix
- **Sampling & elicitation** — forwarded transparently to the correct upstream

## Documentation

Full documentation: [github.com/btwld/nest-mcp/docs/gateway](https://github.com/btwld/nest-mcp/blob/main/docs/gateway/README.md)

## License

MIT
