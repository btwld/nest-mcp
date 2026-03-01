# Upstreams

An upstream is a remote MCP server that the gateway connects to, aggregates, and proxies. Each upstream is defined by an `UpstreamConfig` object in the `upstreams` array.

## UpstreamConfig

```typescript
import type { UpstreamConfig } from '@nest-mcp/gateway';

const upstream: UpstreamConfig = {
  name: 'weather',
  transport: 'streamable-http',
  url: 'http://localhost:4001/mcp',
  toolPrefix: 'weather',
  timeout: 30000,
  enabled: true,
  healthCheck: {
    enabled: true,
    intervalMs: 30000,
    timeoutMs: 5000,
  },
  reconnect: {
    enabled: true,
    maxRetries: 3,
    delayMs: 1000,
  },
};
```

### Properties

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `name` | `string` | Yes | -- | Unique identifier for this upstream. Used as the default tool prefix if `toolPrefix` is not set. |
| `transport` | `'streamable-http' \| 'sse' \| 'stdio'` | Yes | -- | Transport protocol to use when connecting to this upstream. |
| `url` | `string` | For HTTP/SSE | -- | URL of the upstream server. Required when transport is `streamable-http` or `sse`. |
| `command` | `string` | For STDIO | -- | Command to spawn. Required when transport is `stdio`. |
| `args` | `string[]` | No | -- | Arguments passed to the spawned command (STDIO only). |
| `env` | `Record<string, string>` | No | -- | Environment variables for the spawned process (STDIO only). |
| `cwd` | `string` | No | -- | Working directory for the spawned process (STDIO only). |
| `toolPrefix` | `string` | No | `name` | Prefix added to tool and prompt names from this upstream. Falls back to `name` if not set. |
| `timeout` | `number` | No | -- | Timeout in milliseconds for upstream calls (callTool, readResource, getPrompt). |
| `enabled` | `boolean` | No | `true` | Set to `false` to skip this upstream during connection and health checks. |
| `healthCheck` | object | No | See below | Health check configuration. |
| `reconnect` | object | No | See below | Reconnection configuration. |

### Health check options

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Enable periodic health checks for this upstream. Disabled upstreams skip health checks regardless. |
| `intervalMs` | `number` | `30000` | Interval in milliseconds between health check pings. |
| `timeoutMs` | `number` | `5000` | Timeout in milliseconds for each health check ping. |

### Reconnect options

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `enabled` | `boolean` | -- | Enable automatic reconnection on disconnect. |
| `maxRetries` | `number` | -- | Maximum number of reconnection attempts. |
| `delayMs` | `number` | -- | Delay in milliseconds between reconnection attempts. |

## Transport types

### Streamable HTTP

Connects to an upstream MCP server over HTTP using the Streamable HTTP transport from the MCP SDK.

```typescript
{
  name: 'api-server',
  transport: 'streamable-http',
  url: 'http://localhost:4001/mcp',
}
```

### SSE (Server-Sent Events)

Connects using the legacy SSE transport.

```typescript
{
  name: 'legacy-server',
  transport: 'sse',
  url: 'http://localhost:4002/sse',
}
```

### STDIO

Spawns a child process and communicates over stdin/stdout.

```typescript
{
  name: 'local-tool',
  transport: 'stdio',
  command: 'node',
  args: ['./mcp-server.js'],
  env: { NODE_ENV: 'production' },
  cwd: '/opt/tools',
}
```

## UpstreamManagerService

The `UpstreamManagerService` manages the lifecycle of upstream connections. It is injected by the gateway module and can also be injected in your own services.

```typescript
import { Injectable } from '@nestjs/common';
import { UpstreamManagerService } from '@nest-mcp/gateway';

@Injectable()
export class MyService {
  constructor(private readonly upstreamManager: UpstreamManagerService) {}

  checkStatus() {
    const statuses = this.upstreamManager.getAllStatuses();
    for (const status of statuses) {
      console.log(`${status.name}: connected=${status.connected}, healthy=${status.healthy}`);
    }
  }
}
```

### Key methods

| Method | Description |
|--------|-------------|
| `connectAll(configs, roots?)` | Connect to all enabled upstreams. Optionally advertise `roots` during the handshake. |
| `connect(config, roots?)` | Connect to a single upstream. |
| `disconnect(name)` | Disconnect and remove an upstream. |
| `disconnectAll()` | Disconnect all upstreams. |
| `getClient(name)` | Get the raw MCP SDK `Client` for an upstream. |
| `isConnected(name)` | Check if an upstream is connected. |
| `isHealthy(name)` | Check if an upstream is healthy. |
| `setHealthy(name, healthy, error?)` | Manually override the health status of an upstream. |
| `getStatus(name)` | Get the `UpstreamStatus` for a specific upstream. |
| `getAllStatuses()` | Get statuses for all upstreams. |
| `getAllNames()` | Get the names of all connected upstreams. |
| `getConfig(name)` | Get the `UpstreamConfig` for an upstream. |

### UpstreamStatus

```typescript
interface UpstreamStatus {
  name: string;
  connected: boolean;
  healthy: boolean;
  lastHealthCheck?: Date;
  toolCount: number;
  error?: string;
}
```

## See Also

- [Health](./health.md) -- health check details
- [Routing](./routing.md) -- how `toolPrefix` affects tool names
- [Module](./module.md) -- full module option reference
