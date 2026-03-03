# @nest-mcp/server

[![npm version](https://img.shields.io/npm/v/@nest-mcp/server.svg)](https://www.npmjs.com/package/@nest-mcp/server)
[![npm downloads](https://img.shields.io/npm/dm/@nest-mcp/server.svg)](https://www.npmjs.com/package/@nest-mcp/server)
[![License](https://img.shields.io/npm/l/@nest-mcp/server)](https://github.com/btwld/nest-mcp/blob/main/LICENSE)
[![CI](https://github.com/btwld/nest-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/btwld/nest-mcp/actions/workflows/ci.yml)

NestJS module for building [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) servers with decorators, auth, resilience, and multi-transport support.

## Installation

```bash
npm install @nest-mcp/server @modelcontextprotocol/sdk zod@^4
npm install @nestjs/common @nestjs/core reflect-metadata rxjs
```

## Quick start

```typescript
// tools.service.ts
import { Injectable } from '@nestjs/common';
import { Tool } from '@nest-mcp/server';
import { z } from 'zod';

@Injectable()
export class ToolsService {
  @Tool({
    name: 'greet',
    description: 'Greet a user by name',
    schema: z.object({ name: z.string() }),
  })
  async greet({ name }: { name: string }) {
    return `Hello, ${name}!`;
  }
}
```

```typescript
// app.module.ts
import { Module } from '@nestjs/common';
import { McpModule } from '@nest-mcp/server';
import { McpTransportType } from '@nest-mcp/server';

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

## Decorators

| Decorator | Description |
|-----------|-------------|
| `@Tool` | Expose a method as an MCP tool |
| `@Resource` | Expose a method as a static MCP resource |
| `@ResourceTemplate` | Expose a method as a URI-template resource |
| `@Prompt` | Expose a method as an MCP prompt |
| `@Completion` | Provide argument completions for a prompt or resource |

## Transports

- **Streamable HTTP** (`McpTransportType.STREAMABLE_HTTP`) — recommended, supports stateful and stateless modes
- **SSE** (`McpTransportType.SSE`) — Server-Sent Events (legacy)
- **STDIO** (`McpTransportType.STDIO`) — for CLI/subprocess use

## Documentation

Full documentation: [github.com/btwld/nest-mcp/docs/server](https://github.com/btwld/nest-mcp/blob/main/docs/server/README.md)

## License

BSD-3-Clause
