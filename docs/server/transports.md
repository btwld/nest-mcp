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
| `sessionIdGenerator` | `() => string` | `randomUUID` | Custom session-ID generator (ignored when `stateless`) |
| `enableJsonResponse` | `boolean` | `false` | Respond with plain JSON instead of SSE streams |
| `eventStore` | `McpEventStore` | — | Event store enabling resumability (reconnect + replay via `Last-Event-ID`) |
| `onsessioninitialized` | `(sessionId) => void \| Promise<void>` | — | Callback when a new session is initialized |
| `onsessionclosed` | `(sessionId) => void \| Promise<void>` | — | Callback when a session is closed |
| `retryInterval` | `number` | — | `retry:` interval (ms) advertised on SSE streams |
| `allowedHosts` | `string[]` | — | Hostnames accepted by DNS-rebinding protection |
| `allowedOrigins` | `string[]` | — | Origins accepted by DNS-rebinding protection |
| `enableDnsRebindingProtection` | `boolean` | `false` | Enable the SDK transport's DNS-rebinding protection |
| `oauth` | `object` | — | Bearer-token gate for the endpoint (see below) |
| `controllerGuards` | `unknown[]` | — | NestJS guards applied to the generated controller |
| `controllerDecorators` | `ClassDecorator[]` | — | Class decorators applied to the generated controller |

### OAuth Bearer Gate

Setting `oauth.enabled: true` applies `McpBearerGuard` to the generated
controller — a bearer-token check performed before any JSON-RPC processing.
The gate is **inactive unless `enabled` is true**, so existing deployments are
unaffected. The same gate is available for the SSE transport via
`transportOptions.sse.oauth.enabled`.

```typescript
transportOptions: {
  streamableHttp: {
    oauth: {
      enabled: true,
      bindSessionToUser: true,        // default true
    },
  },
},
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | `boolean` | — | Activates the gate |
| `bindSessionToUser` | `boolean` | `true` | Bind each session to the principal that initialized it |

Everything else — the verifier, the advertised metadata, optional-auth mode
(`required: false`), and required scopes — is configured on
`McpAuthModule.forRoot(...)`; see [auth.md](./auth.md).

**401 discovery flow.** When a request has no valid token, the server
responds `401` with an SDK-compatible `WWW-Authenticate` challenge:

```
WWW-Authenticate: Bearer error="invalid_token", error_description="Missing Authorization header", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"
```

MCP clients follow `resource_metadata` to the RFC 9728 protected-resource
document, discover the authorization server from `authorization_servers`,
fetch its RFC 8414 metadata, run the OAuth flow, and retry with a Bearer
token. The `resource_metadata` URL is derived from the `resource` configured
on `McpAuthModule` (path-insertion form), so scheme and host never depend on
request headers.

**Session binding.** With `bindSessionToUser` (default when oauth is
enabled), the principal (`clientId` + `sub`) that initializes a stateful
session is recorded, and every subsequent request for that `mcp-session-id`
must present a token for the same principal — otherwise the server responds
`403`. Binding only applies when `oauth.enabled` is true, so existing
stateful servers never start rejecting requests; set
`bindSessionToUser: false` to opt out. The verified identity is surfaced to
handlers and guards as `ctx.authInfo`.

### DNS-Rebinding Protection

`allowedHosts`, `allowedOrigins`, and `enableDnsRebindingProtection` are
forwarded to the SDK's `StreamableHTTPServerTransport`, which validates the
`Host`/`Origin` headers of every request when protection is enabled:

```typescript
transportOptions: {
  streamableHttp: {
    enableDnsRebindingProtection: true,
    allowedHosts: ['api.example.com'],
    allowedOrigins: ['https://app.example.com'],
  },
},
```

### Controller Guards and Decorators

`controllerGuards` and `controllerDecorators` are applied to the generated
NestJS controller — useful to plug in existing HTTP guards (e.g. an
organization-wide `AuthGuard`) or decorators like Swagger's `@ApiTags`:

```typescript
transportOptions: {
  streamableHttp: {
    controllerGuards: [MyHttpAuthGuard],
    controllerDecorators: [ApiTags('mcp')],
  },
},
```

> **`forRootAsync` note:** the controller class is created when the module is
> *defined*, before the async factory runs. Controller-shape configuration —
> `endpoint`, `oauth.enabled`, `controllerGuards`, `controllerDecorators` —
> must therefore be provided statically on the `forRootAsync` options object
> (`transportOptions`), while all runtime options resolved by `useFactory`
> flow through `MCP_OPTIONS`. A mismatch between the static and resolved
> `oauth.enabled` values fails the bootstrap with an error — the gate cannot
> be toggled from the factory result.

### Resumability

Provide an `eventStore` to let clients resume an interrupted SSE stream: the
SDK assigns event IDs, and on reconnect (with `Last-Event-ID`) replays missed
messages through `replayEventsAfter`. Any object matching the `McpEventStore`
interface (structural mirror of the SDK `EventStore`) works.

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
| `oauth` | `{ enabled: boolean }` | — | Apply `McpBearerGuard` to both SSE endpoints (see [auth.md](./auth.md)) |

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
