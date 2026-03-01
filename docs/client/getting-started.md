# Getting Started

This guide walks through a minimal example: register the client module, connect to an MCP server, and call a tool.

## 1. Install dependencies

```bash
pnpm add @nest-mcp/client @modelcontextprotocol/sdk
```

## 2. Register the module

Import `McpClientModule` and call `forRoot` with at least one connection:

```typescript
import { Module } from '@nestjs/common';
import { McpClientModule } from '@nest-mcp/client';

@Module({
  imports: [
    McpClientModule.forRoot({
      connections: [
        {
          name: 'my-server',
          transport: 'streamable-http',
          url: 'http://localhost:3001/mcp',
        },
      ],
    }),
  ],
})
export class AppModule {}
```

The module is registered globally -- you do not need to import it in every feature module.

## 3. Inject the client

Use the `@InjectMcpClient` decorator to inject a named `McpClient` instance:

```typescript
import { Injectable } from '@nestjs/common';
import { InjectMcpClient, McpClient } from '@nest-mcp/client';

@Injectable()
export class WeatherService {
  constructor(@InjectMcpClient('my-server') private readonly mcp: McpClient) {}

  async getForecast(city: string) {
    const result = await this.mcp.callTool({
      name: 'get-forecast',
      arguments: { city },
    });
    return result;
  }
}
```

## 4. What happens at startup

When the NestJS application boots:

1. `McpClientModule` creates an `McpClient` instance for each connection.
2. `McpClientBootstrap.onApplicationBootstrap()` calls `client.connect()` on every client.
3. After all clients connect, any `@OnMcpNotification` handlers are wired up automatically.
4. On application shutdown, `McpClientBootstrap.onApplicationShutdown()` disconnects all clients.

If a connection fails during bootstrap, an error is logged but the application continues to start. The client will remain in a disconnected state until manually reconnected or until auto-reconnect triggers (if configured).

## 5. Listing tools

Use `listAllTools()` to fetch every tool across all pages (handles pagination automatically):

```typescript
const tools = await this.mcp.listAllTools();
for (const tool of tools) {
  console.log(tool.name, tool.description);
}
```

## 6. Reading a resource

```typescript
const resource = await this.mcp.readResource({ uri: 'file:///config.json' });
console.log(resource.contents);
```

## Next steps

- [Module Configuration](./module.md) -- `forRootAsync` for dynamic config
- [Connections](./connections.md) -- transport types and auth options
- [Client API](./client-api.md) -- full method reference

## See Also

- [README](./README.md)
- [Injection](./injection.md)
- [Reconnection](./reconnection.md)
