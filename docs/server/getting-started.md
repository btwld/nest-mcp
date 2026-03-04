# Getting Started

This guide walks through creating a minimal MCP server that exposes a tool and a resource.

## 1. Install dependencies

```bash
npm install @nest-mcp/server @nest-mcp/common \
  @modelcontextprotocol/sdk @nestjs/common @nestjs/core \
  @nestjs/platform-express reflect-metadata rxjs zod
```

## 2. Create a tool provider

```typescript
// tools.service.ts
import { Injectable } from '@nestjs/common';
import { Tool } from '@nest-mcp/server';
import { z } from 'zod';

@Injectable()
export class ToolsService {
  @Tool({
    name: 'add',
    description: 'Add two numbers',
    parameters: z.object({
      a: z.number().describe('First number'),
      b: z.number().describe('Second number'),
    }),
  })
  async add(args: { a: number; b: number }) {
    return { content: [{ type: 'text', text: String(args.a + args.b) }] };
  }
}
```

## 3. Create the app module

```typescript
// app.module.ts
import { Module } from '@nestjs/common';
import { McpModule } from '@nest-mcp/server';
import { McpTransportType } from '@nest-mcp/common';
import { ToolsService } from './tools.service';

@Module({
  imports: [
    McpModule.forRoot({
      name: 'calculator',
      version: '1.0.0',
      transport: McpTransportType.STREAMABLE_HTTP,
    }),
  ],
  providers: [ToolsService],
})
export class AppModule {}
```

## 4. Bootstrap the application

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

The server is now available at `POST http://localhost:3000/mcp` (the default Streamable HTTP endpoint).

## 5. Add a resource

```typescript
// config.service.ts
import { Injectable } from '@nestjs/common';
import { Resource } from '@nest-mcp/server';

@Injectable()
export class ConfigService {
  @Resource({
    uri: 'config://app/version',
    name: 'app-version',
    description: 'Current application version',
    mimeType: 'text/plain',
  })
  async getVersion() {
    return '1.0.0';
  }
}
```

Register it in the module:

```typescript
@Module({
  imports: [
    McpModule.forRoot({
      name: 'calculator',
      version: '1.0.0',
      transport: McpTransportType.STREAMABLE_HTTP,
    }),
  ],
  providers: [ToolsService, ConfigService],
})
export class AppModule {}
```

## Using STDIO Transport

For CLI-based MCP servers, use the STDIO transport. `StdioService` auto-starts via the `OnApplicationBootstrap` lifecycle hook — no manual `.start()` call required:

```typescript
// main.ts
import { McpModule } from '@nest-mcp/server';
import { McpTransportType } from '@nest-mcp/common';
import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { ToolsService } from './tools.service';

@Module({
  imports: [
    McpModule.forRoot({
      name: 'calculator',
      version: '1.0.0',
      transport: McpTransportType.STDIO,
    }),
  ],
  providers: [ToolsService],
})
class AppModule {}

async function main() {
  await NestFactory.createApplicationContext(AppModule, { logger: false });
}
main().catch(console.error);
```

Setting `logger: false` prevents NestJS log output from corrupting the JSON-RPC stream on stdout. For finer control over log levels, use the optional `bootstrapStdioApp` helper which redirects logs to stderr instead:

```typescript
import { bootstrapStdioApp } from '@nest-mcp/server';

const app = await bootstrapStdioApp(AppModule);
```

## Return Value Normalization

Tool handlers support flexible return types. The framework normalizes them:

| Return type | Normalized to |
|---|---|
| `string` | `{ content: [{ type: 'text', text: value }] }` |
| `{ content: [...] }` | Passed through as-is |
| `null` / `undefined` | `{ content: [{ type: 'text', text: '' }] }` |
| Other objects | `{ content: [{ type: 'text', text: JSON.stringify(value) }] }` |

Resource handlers are similarly normalized: a string return becomes `{ contents: [{ uri, text: value }] }`.

## See Also

- [Module](./module.md) -- Full module configuration options
- [Decorators](./decorators.md) -- All available decorators
- [Transports](./transports.md) -- Transport configuration details
