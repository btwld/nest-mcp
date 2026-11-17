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
| `timeout` | `number` | No | `60000` (SDK default) | Timeout in milliseconds for upstream requests (tool calls, resource reads, prompt gets, completions). See [Timeouts, cancellation and progress](#timeouts-cancellation-and-progress). |
| `enabled` | `boolean` | No | `true` | Set to `false` to skip this upstream during connection and health checks. |
| `healthCheck` | object | No | See below | Health check configuration. |
| `reconnect` | object | No | See below | Reconnection configuration. See [Reconnection](#reconnection). |

### Health check options

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Enable periodic health checks for this upstream. Disabled upstreams skip health checks regardless. |
| `intervalMs` | `number` | `30000` | Interval in milliseconds between health check pings. |
| `timeoutMs` | `number` | `5000` | Timeout in milliseconds for each health check ping. |

### Reconnect options

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `enabled` | `boolean` | `false` | Enable automatic reconnection. |
| `maxRetries` | `number` | `5` | Maximum number of attempts per reconnect cycle. |
| `delayMs` | `number` | `1000` | Delay in milliseconds before the first attempt. The delay doubles with each attempt, capped at 30 seconds. |

## Timeouts, cancellation and progress

- **Timeout.** `timeout` is passed to the MCP SDK as the request timeout of each upstream request. When it elapses, the SDK sends `notifications/cancelled` to the upstream and the call fails: a tool call returns an `isError` result (`request timed out after <timeout>ms`), and a resource read or prompt get fails with a `-32603` error. Without `timeout`, the SDK default of 60 seconds applies; set a larger value for long-running upstream tools.
- **Cancellation.** When the downstream client cancels a request, the gateway aborts the matching upstream request, and the upstream receives `notifications/cancelled`.
- **Progress.** The gateway asks upstreams for progress on proxied tool calls and relays every upstream `notifications/progress` to the downstream client, as long as the downstream request carried a progress token. Each progress notification resets the upstream timeout, so `timeout` bounds the time between progress updates, not the total duration of a tool call that keeps reporting progress.

## Reconnection

With `reconnect.enabled: true`, the gateway re-establishes the connection to an upstream when:

- the upstream connection closes (for example a STDIO upstream process exits),
- the initial connection at startup fails, or
- a health check fails (useful for HTTP upstreams, where a server restart does not close the client transport).

While reconnecting, the upstream is reported as disconnected and unhealthy, and calls routed to it fail fast with an "unhealthy" error. Each attempt uses a fresh MCP client and transport. Attempts are spaced by `delayMs`, doubling each time (capped at 30 seconds), up to `maxRetries` attempts. If every attempt fails, the upstream stays unhealthy; the next failed health check starts a new cycle.

After a successful reconnect the gateway re-aggregates all of the upstream's lists, because the restarted upstream may expose a different catalog (see below).

Without `reconnect.enabled`, a closed upstream stays disconnected and unhealthy until the application restarts.

## Runtime list changes

The gateway re-aggregates an upstream's tools, resources and resource templates, or prompts when that upstream sends `notifications/tools/list_changed`, `notifications/resources/list_changed` or `notifications/prompts/list_changed`, and re-aggregates all of them after a reconnect. It then reconciles its registry for that upstream only:

- items the upstream no longer lists are unregistered,
- new items are registered,
- items whose definition changed are re-registered with the new definition,

and sends the matching `notifications/<list>/list_changed` to downstream sessions so clients re-fetch the list. If the upstream cannot be listed at that moment, the gateway keeps its previous items.

Known limitations of the current server transports:

- Downstream sessions that connected before an item changed keep their original handler registration for that item. Calls still reach the current definition (the gateway resolves them by name), and `tools/list` / `prompts/list` / `resources/list` show the current definitions, but such a session keeps validating `prompts/get` arguments against the prompt's argument list as it was when the session connected.
- An item that is removed and later re-added under the same name may stay unavailable for calls in sessions that connected while it was registered the first time, until those sessions reconnect.
- The broadcast `list_changed` notifications reach Streamable HTTP and SSE sessions. STDIO sessions are notified when new items are added, but not when items are removed or changed.

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
| `reconnect(name)` | Start (or join) a reconnect cycle. Resolves to `true` once the upstream is connected again. |
| `isReconnecting(name)` | Whether a reconnect cycle is in progress. |
| `onUpstreamChange(listener)` | Subscribe to `UpstreamChangeEvent`s (`{ upstreamName, kinds, reason: 'list_changed' \| 'reconnected' }`). Returns an unsubscribe function. |

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
