# Transports

The server supports three MCP transport types: **Streamable HTTP**, **SSE** (Server-Sent Events), and **STDIO**. You can enable one or multiple transports simultaneously.

## Streamable HTTP

The recommended transport for HTTP-based MCP servers. Uses a single endpoint for POST (JSON-RPC requests), GET (SSE streaming), and DELETE (session termination).

```typescript
import { McpModule } from '@nest-mcp/server';
import { McpTransportType } from '@nest-mcp/common';

McpModule.forRoot({
  name: 'my-server',
  version: '1.0.0',
  transport: McpTransportType.STREAMABLE_HTTP,
  transportOptions: {
    streamableHttp: {
      endpoint: '/mcp',   // default: '/mcp'
      stateless: false,     // default: false
    },
  },
});
```

### Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `endpoint` | `string` | `'/mcp'` | HTTP path for the MCP endpoint |
| `stateless` | `boolean` | `false` | Stateless mode (no session tracking) |

### Endpoints

The controller created by `createStreamableHttpController` registers three routes at the configured endpoint:

- **POST** `{endpoint}` -- Handle JSON-RPC requests. New sessions are created automatically.
- **GET** `{endpoint}` -- Open an SSE stream for server-initiated messages (stateful mode only).
- **DELETE** `{endpoint}` -- Close and clean up a session. Requires `mcp-session-id` header.

### Stateful vs Stateless

In **stateful** mode (default), each client gets a session identified by a `mcp-session-id` header. Sessions track state across requests.

In **stateless** mode, each POST request creates a temporary transport that is discarded after the response. GET requests return `405 Method Not Allowed`.

## SSE (Server-Sent Events)

Legacy transport using separate endpoints for the SSE connection and JSON-RPC messages.

```typescript
McpModule.forRoot({
  name: 'my-server',
  version: '1.0.0',
  transport: McpTransportType.SSE,
  transportOptions: {
    sse: {
      endpoint: '/sse',               // default: '/sse'
      messagesEndpoint: '/messages',   // default: '/messages'
      pingInterval: 30000,             // default: 30000 ms
    },
  },
});
```

### Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `endpoint` | `string` | `'/sse'` | SSE connection endpoint |
| `messagesEndpoint` | `string` | `'/messages'` | JSON-RPC message endpoint |
| `pingInterval` | `number` | `30000` | Ping interval in ms (0 to disable) |

### Endpoints

Two controllers are created by `createSseController`:

- **GET** `{endpoint}` -- Opens an SSE connection. Returns a `sessionId` used for subsequent messages.
- **POST** `{messagesEndpoint}?sessionId=...` -- Send JSON-RPC messages for an existing session.

### Ping Keep-alive

The SSE transport sends `:ping\n\n` comments at the configured interval to keep the connection alive through proxies and load balancers. Set `pingInterval: 0` to disable.

## STDIO

For CLI-based MCP servers that communicate over standard input/output.

```typescript
McpModule.forRoot({
  name: 'my-server',
  version: '1.0.0',
  transport: McpTransportType.STDIO,
});
```

### Bootstrap

`StdioService` auto-starts via the `OnApplicationBootstrap` lifecycle hook. The simplest setup disables logging to keep stdout clean for JSON-RPC:

```typescript
import { McpModule } from '@nest-mcp/server';
import { McpTransportType } from '@nest-mcp/common';
import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { ToolsService } from './tools.service';

@Module({
  imports: [
    McpModule.forRoot({
      name: 'cli-server',
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

For stderr-redirected logging with optional level filtering, use the `bootstrapStdioApp` helper:

```typescript
import { bootstrapStdioApp } from '@nest-mcp/server';

const app = await bootstrapStdioApp(AppModule, {
  logLevels: ['error', 'warn'], // optional: filter log levels
});
```

`bootstrapStdioApp` uses `NestFactory.createApplicationContext` with a `StderrLogger` so that stdout is reserved exclusively for JSON-RPC messages.

### StdioBootstrapOptions

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `logLevels` | `LogLevel[]` | all levels | Which NestJS log levels to emit to stderr |

## Multiple Transports

You can enable multiple transports simultaneously:

```typescript
McpModule.forRoot({
  name: 'my-server',
  version: '1.0.0',
  transport: [McpTransportType.STREAMABLE_HTTP, McpTransportType.SSE],
  transportOptions: {
    streamableHttp: { endpoint: '/mcp' },
    sse: { endpoint: '/sse', messagesEndpoint: '/messages' },
  },
});
```

Each transport manages its own sessions independently. All transports share the same registry of tools, resources, and prompts.

## Session Lifecycle

All transport implementations follow the same session lifecycle:

1. **Connection** -- A new `McpServer` instance is created per session with handlers registered from the registry.
2. **Request handling** -- Incoming JSON-RPC requests are routed through the execution pipeline.
3. **Dynamic updates** -- When tools/resources/prompts are registered or unregistered at runtime, all active sessions are updated and `list_changed` notifications are sent.
4. **Cleanup** -- When a session closes, its subscriptions (via `ResourceSubscriptionManager`) and tasks (via `TaskManager`) are cleaned up.

## See Also

- [Module](./module.md) -- Transport configuration in `McpModule.forRoot`
- [Sessions](./sessions.md) -- Session management details
- [Getting Started](./getting-started.md) -- Quick start examples for each transport
