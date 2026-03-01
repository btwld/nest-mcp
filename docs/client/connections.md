# Connections

Each entry in the `connections` array configures a single MCP server connection. The `transport` field determines the transport type and the available options.

## Transport types

### Streamable HTTP

```typescript
{
  name: 'my-server',
  transport: 'streamable-http',
  url: 'http://localhost:3001/mcp',
}
```

Uses `StreamableHTTPClientTransport` from the MCP SDK. This is the recommended transport for HTTP-based servers.

### SSE (Server-Sent Events)

```typescript
{
  name: 'my-server',
  transport: 'sse',
  url: 'http://localhost:3001/sse',
}
```

Uses `SSEClientTransport` from the MCP SDK. Suitable for servers that expose an SSE endpoint.

### STDIO

```typescript
{
  name: 'my-server',
  transport: 'stdio',
  command: 'node',
  args: ['./dist/server.js'],
  env: { NODE_ENV: 'production' },
  cwd: '/path/to/server',
}
```

Uses `StdioClientTransport` from the MCP SDK. Spawns a child process and communicates over stdin/stdout.

## Common options

All transport types share these base options:

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `name` | `string` | (required) | Unique connection name, used with `@InjectMcpClient` |
| `connectTimeout` | `number` | -- | Connection timeout in milliseconds |
| `reconnect` | `McpClientReconnectOptions` | -- | Auto-reconnect configuration (see [Reconnection](./reconnection.md)) |
| `capabilities` | `ClientCapabilities` | `{}` | Client capabilities to advertise during initialization |
| `samplingHandler` | `McpSamplingHandler` | -- | Handler for server `sampling/createMessage` requests |
| `elicitationHandler` | `McpElicitationHandler` | -- | Handler for server `elicitation/create` requests |
| `rootsHandler` | `McpRootsHandler` | -- | Handler for server `roots/list` requests |

## HTTP-specific options (Streamable HTTP and SSE)

Both `streamable-http` and `sse` transports share these additional options:

| Property | Type | Description |
|----------|------|-------------|
| `url` | `string` | Server URL (required) |
| `auth` | `McpClientAuthOptions` | Bearer token auth (see below) |
| `authProvider` | `OAuthClientProvider` | OAuth client provider from the MCP SDK (see [OAuth](./oauth.md)) |
| `requestInit` | `RequestInit` | Custom fetch `RequestInit` options (headers, etc.) |

## STDIO-specific options

| Property | Type | Description |
|----------|------|-------------|
| `command` | `string` | Command to execute (required) |
| `args` | `string[]` | Command arguments |
| `env` | `Record<string, string>` | Environment variables for the child process |
| `cwd` | `string` | Working directory for the child process |

## Authentication

### Bearer token

The simplest authentication method. The token is sent as an `Authorization: Bearer <token>` header on every request:

```typescript
{
  name: 'secure-server',
  transport: 'streamable-http',
  url: 'https://api.example.com/mcp',
  auth: {
    type: 'bearer',
    token: 'my-secret-token',
  },
}
```

The `auth` option is merged with any custom headers provided via `requestInit`. The `Authorization` header set by `auth` takes precedence.

### OAuth

For OAuth-based authentication, provide an `authProvider` that implements the `OAuthClientProvider` interface from the MCP SDK. See [OAuth](./oauth.md) for details.

### Custom headers

Use `requestInit` to set arbitrary headers:

```typescript
{
  name: 'custom-server',
  transport: 'sse',
  url: 'http://localhost:3001/sse',
  requestInit: {
    headers: { 'X-API-Key': 'my-key' },
  },
}
```

## Server-to-client handlers

You can register handlers for server-initiated requests directly in the connection config:

```typescript
{
  name: 'my-server',
  transport: 'streamable-http',
  url: 'http://localhost:3001/mcp',
  samplingHandler: async (request) => {
    // Handle sampling/createMessage from the server
    return { model: 'gpt-4', role: 'assistant', content: { type: 'text', text: '...' } };
  },
  rootsHandler: async () => {
    return { roots: [{ uri: 'file:///workspace', name: 'workspace' }] };
  },
}
```

Setting these handlers automatically declares the corresponding client capabilities (`sampling`, `elicitation`, `roots`) during the MCP initialization handshake.

## Interface reference

```typescript
type McpClientConnection =
  | McpClientStreamableHttpConnection
  | McpClientSseConnection
  | McpClientStdioConnection;

interface McpClientAuthOptions {
  type: 'bearer';
  token: string;
}

interface McpClientReconnectOptions {
  maxAttempts?: number; // default: 5
  delay?: number;       // default: 1000 (ms)
}
```

## See Also

- [Module Configuration](./module.md) -- registering connections
- [Reconnection](./reconnection.md) -- auto-reconnect behavior
- [OAuth](./oauth.md) -- OAuth provider setup
- [Client API](./client-api.md) -- methods available on each client
