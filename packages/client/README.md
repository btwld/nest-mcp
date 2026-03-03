# @nest-mcp/client

[![npm version](https://img.shields.io/npm/v/@nest-mcp/client.svg)](https://www.npmjs.com/package/@nest-mcp/client)
[![npm downloads](https://img.shields.io/npm/dm/@nest-mcp/client.svg)](https://www.npmjs.com/package/@nest-mcp/client)
[![License](https://img.shields.io/npm/l/@nest-mcp/client)](https://github.com/btwld/nest-mcp/blob/main/LICENSE)
[![CI](https://github.com/btwld/nest-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/btwld/nest-mcp/actions/workflows/ci.yml)

NestJS module for connecting to and consuming [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) servers with typed injection, notifications, health checks, and reconnection support.

## Installation

```bash
npm install @nest-mcp/client @modelcontextprotocol/sdk zod@^4
npm install @nestjs/common @nestjs/core reflect-metadata rxjs
```

## Quick start

```typescript
// app.module.ts
import { Module } from '@nestjs/common';
import { McpClientModule } from '@nest-mcp/client';
import { McpTransportType } from '@nest-mcp/client';

@Module({
  imports: [
    McpClientModule.forRoot({
      connections: [
        {
          name: 'my-server',
          transport: {
            type: McpTransportType.STREAMABLE_HTTP,
            url: 'http://localhost:3000/mcp',
          },
        },
      ],
    }),
  ],
})
export class AppModule {}
```

```typescript
// my.service.ts
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

## Features

- **`@InjectMcpClient(name)`** — inject a named client into any service
- **`McpClientsService`** — programmatic access to all clients by name
- **`@OnMcpNotification(method)`** — subscribe to server-sent notifications
- **`McpClientHealthIndicator`** — health check integration (NestJS Terminus)
- **Automatic reconnection** with configurable backoff
- **OAuth** support for authenticated servers

## Transports

- Streamable HTTP (`McpTransportType.STREAMABLE_HTTP`)
- SSE (`McpTransportType.SSE`)
- STDIO (`McpTransportType.STDIO`)

## Documentation

Full documentation: [github.com/btwld/nest-mcp/docs/client](https://github.com/btwld/nest-mcp/blob/main/docs/client/README.md)

## License

BSD-3-Clause
