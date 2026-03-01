# Module Configuration

`McpClientModule` provides two static methods for registration: `forRoot` (synchronous) and `forRootAsync` (factory-based). Both register the module globally so clients are available across the entire application.

## forRoot

Use `forRoot` when connection options are known at compile time:

```typescript
import { Module } from '@nestjs/common';
import { McpClientModule } from '@nest-mcp/client';

@Module({
  imports: [
    McpClientModule.forRoot({
      connections: [
        {
          name: 'server-a',
          transport: 'streamable-http',
          url: 'http://localhost:3001/mcp',
        },
        {
          name: 'server-b',
          transport: 'sse',
          url: 'http://localhost:3002/sse',
        },
      ],
    }),
  ],
})
export class AppModule {}
```

### What forRoot does

1. Creates an `McpClient` instance for each entry in `connections`.
2. Registers each client as a named provider using the token `MCP_CLIENT_{name}` (via `getMcpClientToken`).
3. Registers `McpClientsService` for looking up clients by name at runtime.
4. Registers `McpClientBootstrap` which connects all clients on application bootstrap and disconnects them on shutdown.

## forRootAsync

Use `forRootAsync` when connection options depend on runtime configuration (e.g., `ConfigService`):

```typescript
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { McpClientModule } from '@nest-mcp/client';

@Module({
  imports: [
    ConfigModule.forRoot(),
    McpClientModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        connections: [
          {
            name: 'api-server',
            transport: 'streamable-http',
            url: config.getOrThrow('MCP_SERVER_URL'),
            auth: { type: 'bearer', token: config.getOrThrow('MCP_TOKEN') },
          },
        ],
      }),
      inject: [ConfigService],
      connectionNames: ['api-server'],
    }),
  ],
})
export class AppModule {}
```

### Options

| Property | Type | Description |
|----------|------|-------------|
| `useFactory` | `(...args: any[]) => McpClientModuleOptions \| Promise<McpClientModuleOptions>` | Factory function that returns the module options |
| `inject` | `InjectionToken[]` | Tokens to inject into the factory |
| `imports` | `ModuleMetadata['imports']` | Modules to import (makes their providers available to `inject`) |
| `connectionNames` | `string[]` | Connection names to register as named providers for `@InjectMcpClient` |

### connectionNames

With `forRootAsync`, connection configs are resolved at runtime. The `connectionNames` option pre-registers named providers so that `@InjectMcpClient('name')` works:

```typescript
McpClientModule.forRootAsync({
  useFactory: () => ({
    connections: [
      { name: 'alpha', transport: 'sse', url: 'http://localhost:3001/sse' },
      { name: 'beta', transport: 'sse', url: 'http://localhost:3002/sse' },
    ],
  }),
  connectionNames: ['alpha', 'beta'],
})
```

Each name in `connectionNames` creates a provider that resolves the matching client from the connections array. If no connection matches a declared name, an error is thrown at runtime.

Without `connectionNames`, you can still access clients via `McpClientsService.getClient('name')`.

## McpClientModuleOptions

```typescript
interface McpClientModuleOptions {
  connections: McpClientConnection[];
}
```

The `connections` array accepts `McpClientStreamableHttpConnection`, `McpClientSseConnection`, or `McpClientStdioConnection` objects. See [Connections](./connections.md) for details on each transport type.

## See Also

- [Connections](./connections.md) -- transport-specific options
- [Injection](./injection.md) -- accessing clients in your services
- [Getting Started](./getting-started.md)
