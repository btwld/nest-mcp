# Injection

There are three ways to access MCP clients in your NestJS services:

## @InjectMcpClient

The `@InjectMcpClient` decorator injects a named `McpClient` instance by connection name:

```typescript
import { Injectable } from '@nestjs/common';
import { InjectMcpClient, McpClient } from '@nest-mcp/client';

@Injectable()
export class MyService {
  constructor(@InjectMcpClient('my-server') private readonly mcp: McpClient) {}

  async listTools() {
    return this.mcp.listAllTools();
  }
}
```

Under the hood, `@InjectMcpClient(name)` resolves the injection token `MCP_CLIENT_{name}` using `@Inject()`.

### With forRootAsync

When using `forRootAsync`, you must declare the connection names upfront via the `connectionNames` option for `@InjectMcpClient` to work:

```typescript
McpClientModule.forRootAsync({
  useFactory: () => ({
    connections: [{ name: 'api', transport: 'sse', url: 'http://localhost:3001/sse' }],
  }),
  connectionNames: ['api'], // Required for @InjectMcpClient('api')
})
```

## McpClientsService

`McpClientsService` is an injectable service that provides runtime access to all registered clients:

```typescript
import { Injectable } from '@nestjs/common';
import { McpClientsService, McpClient } from '@nest-mcp/client';

@Injectable()
export class DynamicService {
  constructor(private readonly clients: McpClientsService) {}

  getClient(name: string): McpClient {
    return this.clients.getClient(name);
  }

  getAllClients(): McpClient[] {
    return this.clients.getClients();
  }
}
```

### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `getClient(name)` | `McpClient` | Returns the client with the given name. Throws if not found. |
| `getClients()` | `McpClient[]` | Returns all registered clients. |

`McpClientsService` is useful when:
- You need to iterate over all clients
- The connection name is determined at runtime
- You are using `forRootAsync` without `connectionNames`

## getMcpClientToken

The `getMcpClientToken` function returns the injection token string for a given connection name. This is useful when building custom providers:

```typescript
import { getMcpClientToken } from '@nest-mcp/client';

const token = getMcpClientToken('my-server');
// Returns: 'MCP_CLIENT_my-server'
```

Example usage in a custom provider:

```typescript
{
  provide: 'MY_CUSTOM_SERVICE',
  useFactory: (client: McpClient) => new MyCustomService(client),
  inject: [getMcpClientToken('my-server')],
}
```

## See Also

- [Module Configuration](./module.md) -- `connectionNames` in `forRootAsync`
- [Client API](./client-api.md) -- methods available on `McpClient`
- [Getting Started](./getting-started.md)
