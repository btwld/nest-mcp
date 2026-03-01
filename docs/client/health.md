# Health Checks

`McpClientHealthIndicator` provides a health check mechanism for monitoring the status of MCP client connections.

## Setup

Create a `McpClientHealthIndicator` with your array of clients:

```typescript
import { Injectable } from '@nestjs/common';
import { McpClientsService, McpClientHealthIndicator } from '@nest-mcp/client';

@Injectable()
export class HealthService {
  private readonly healthIndicator: McpClientHealthIndicator;

  constructor(clients: McpClientsService) {
    this.healthIndicator = new McpClientHealthIndicator(clients.getClients());
  }

  async check() {
    return this.healthIndicator.check();
  }
}
```

## McpClientHealthResult

The `check()` method returns a `McpClientHealthResult`:

```typescript
interface McpClientHealthResult {
  status: 'up' | 'down';
  connections: McpClientHealthStatus[];
}
```

- `status` is `'up'` only when there is at least one connection **and** all connections are healthy.
- `status` is `'down'` if there are no connections, or if any connection is unhealthy.

## McpClientHealthStatus

Each connection entry in the `connections` array has the following shape:

```typescript
interface McpClientHealthStatus {
  name: string;
  connected: boolean;
  serverVersion?: { name: string; version: string };
  error?: string;
}
```

| Field | Description |
|-------|-------------|
| `name` | The connection name |
| `connected` | `true` if the client responded to a ping |
| `serverVersion` | Server name and version (present when connected and the server provides version info) |
| `error` | Error message if the ping failed |

## How it works

For each client, `check()` does the following:

1. If `client.isConnected()` is `false`, the connection is reported as disconnected immediately.
2. If connected, it sends a `ping()` to the server.
3. On successful ping, it also retrieves the server version via `client.getServerVersion()`.
4. On ping failure, the connection is reported as disconnected with the error message.

## Example: HTTP health endpoint

```typescript
import { Controller, Get } from '@nestjs/common';
import { HealthService } from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  async check() {
    const result = await this.health.check();
    return result;
  }
}
```

Example response:

```json
{
  "status": "up",
  "connections": [
    {
      "name": "server-a",
      "connected": true,
      "serverVersion": { "name": "my-mcp-server", "version": "1.0.0" }
    },
    {
      "name": "server-b",
      "connected": true
    }
  ]
}
```

## See Also

- [Client API](./client-api.md) -- `ping()`, `isConnected()`, `getServerVersion()`
- [Reconnection](./reconnection.md) -- auto-reconnect behavior
- [Injection](./injection.md) -- `McpClientsService`
