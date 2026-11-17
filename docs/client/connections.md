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
| `connectTimeout` | `number` | SDK default (60000) | Timeout in milliseconds for the `initialize` handshake, applied to `connect()` and to every reconnection attempt |
| `reconnect` | `McpClientReconnectOptions` | -- | Auto-reconnect configuration (see [Reconnection](./reconnection.md)) |
| `clientInfo` | `McpClientInfo` | `{ name: 'nestjs-mcp-client-<name>', version: '1.0.0' }` | Identity sent as `clientInfo` in the `initialize` request (see below) |
| `capabilities` | `ClientCapabilities` | `{}` | Client capabilities to advertise during initialization (see [Capabilities](#capabilities)) |
| `samplingHandler` | `McpSamplingHandler` | -- | Handler for server `sampling/createMessage` requests |
| `elicitationHandler` | `McpElicitationHandler` | -- | Handler for server `elicitation/create` requests |
| `elicitationModes` | `Array<'form' \| 'url'>` | form only | Elicitation modes to declare for `elicitationHandler` (see [Elicitation modes](#elicitation-modes)) |
| `rootsHandler` | `McpRootsHandler` | -- | Handler for server `roots/list` requests |

### Client info

`clientInfo` accepts every field of the MCP `Implementation` type. Any field you leave out keeps its default:

```typescript
{
  name: 'my-server',
  transport: 'streamable-http',
  url: 'http://localhost:3001/mcp',
  clientInfo: {
    name: 'billing-service',
    version: '2.4.0',
    title: 'Billing Service',
    description: 'Internal billing backend',
    websiteUrl: 'https://example.com',
    icons: [{ src: 'https://example.com/icon.png', mimeType: 'image/png' }],
  },
}
```

## HTTP-specific options (Streamable HTTP and SSE)

Both `streamable-http` and `sse` transports share these additional options:

| Property | Type | Description |
|----------|------|-------------|
| `url` | `string` | Server URL (required) |
| `auth` | `McpClientAuthOptions` | Bearer token auth (see below) |
| `authProvider` | `OAuthClientProvider` | OAuth client provider from the MCP SDK (see [OAuth](./oauth.md)) |
| `requestInit` | `RequestInit` | Custom fetch `RequestInit` options (headers, etc.) |
| `fetch` | `FetchLike` | Custom `fetch` implementation the transport uses for its HTTP requests (proxies, instrumentation, tests) |

## Streamable HTTP-specific options

| Property | Type | Description |
|----------|------|-------------|
| `reconnectionOptions` | `StreamableHTTPReconnectionOptions` | How the SDK transport re-opens dropped SSE streams (`initialReconnectionDelay`, `maxReconnectionDelay`, `reconnectionDelayGrowFactor`, `maxRetries`). Independent of the client-level `reconnect` option |
| `sessionId` | `string` | Resume an existing session instead of starting a new one (see below) |

When `sessionId` is set, the SDK skips the `initialize` handshake on the first connect, so `getServerCapabilities()`, `getServerVersion()` and `getInstructions()` return `undefined` for that connection. The session ID is only used for the first connect: every reconnection starts a new session with a new `initialize`.

### Session lifecycle

- **Expired sessions.** When the server answers a request with HTTP 404 (its way of saying the `Mcp-Session-Id` is no longer valid), the client closes the transport and goes through the disconnect path: with `reconnect` configured it starts a new session with a fresh `initialize`; without it, the client is marked disconnected. See [Reconnection](./reconnection.md).
- **Closing.** `disconnect()` (also called on application shutdown and by `McpClientsService.removeConnection()`) first ends the session with an HTTP `DELETE`, then closes the transport. Errors from the `DELETE` are ignored, including the `405` returned by servers that do not support explicit termination, and the client waits at most 5 seconds for it.

## STDIO-specific options

| Property | Type | Description |
|----------|------|-------------|
| `command` | `string` | Command to execute (required) |
| `args` | `string[]` | Command arguments |
| `env` | `Record<string, string>` | Environment variables for the child process |
| `cwd` | `string` | Working directory for the child process |
| `stderr` | `IOType \| Stream \| number` | How the child's stderr is handled. The SDK default is `'inherit'`; use `'pipe'` to read it from the transport's `stderr` stream, or `'ignore'` to discard it |

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

For OAuth-based authentication, provide an `authProvider` that implements the `OAuthClientProvider` interface from the MCP SDK. See [OAuth](./oauth.md) for details. Use either `auth` or `authProvider` on a connection, not both: the static header from `auth` would replace the OAuth access token on every request.

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

Each handler also receives the SDK's per-request context as an optional second argument (`extra`; for `rootsHandler` it is the only argument). It carries the abort `signal` (fired when the server cancels the request), `requestId`, the request `_meta`, and `sendNotification` / `sendRequest` for messages tied to the request:

```typescript
samplingHandler: async (request, extra) => {
  const reply = await llm.generate(request.params.messages, { signal: extra?.signal });
  return { model: reply.model, role: 'assistant', content: { type: 'text', text: reply.text } };
},
```

The type of that argument is exported as `McpClientRequestHandlerExtra`.

### Elicitation modes

By default `elicitationHandler` declares form-mode elicitation only (`elicitation: {}`), and the SDK rejects URL-mode requests. List the modes you support to accept URL mode as well:

```typescript
{
  name: 'my-server',
  transport: 'streamable-http',
  url: 'http://localhost:3001/mcp',
  elicitationHandler: async (params) => {
    if (params.mode === 'url') {
      await openInBrowser(params.url);
      return { action: 'accept' };
    }
    return { action: 'accept', content: await askUser(params.requestedSchema) };
  },
  elicitationModes: ['form', 'url'], // declares { form: {}, url: {} }
}
```

The programmatic equivalent is `client.setElicitationHandler(handler, { modes: ['form', 'url'] })`.

### Capabilities

`capabilities` is merged per key with the capabilities the handlers declare, using the same rules as the SDK: nested objects are combined, and values you set explicitly win. Nested flags such as `sampling.tools`, `elicitation.form.applyDefaults` or `roots.listChanged` are kept when a handler is registered and on every reconnect:

```typescript
{
  name: 'my-server',
  transport: 'stdio',
  command: 'node',
  args: ['server.js'],
  capabilities: { sampling: { tools: {} }, roots: { listChanged: false } },
  samplingHandler,  // advertised as sampling: { tools: {} }
  rootsHandler,     // advertised as roots: { listChanged: false }
}
```

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

type McpClientInfo = Partial<Implementation>; // name, version, title, description, icons, websiteUrl

type McpElicitationMode = 'form' | 'url';

interface McpElicitationHandlerOptions {
  modes?: McpElicitationMode[]; // default: form only
}

type McpSamplingHandler = (
  request: CreateMessageRequest,
  extra?: McpClientRequestHandlerExtra,
) => CreateMessageResult | Promise<CreateMessageResult>;

type McpElicitationHandler = (
  params: ElicitRequestFormParams | ElicitRequestURLParams,
  extra?: McpClientRequestHandlerExtra,
) => ElicitResult | Promise<ElicitResult>;

type McpRootsHandler = (
  extra?: McpClientRequestHandlerExtra,
) => ListRootsResult | Promise<ListRootsResult>;
```

## See Also

- [Module Configuration](./module.md) -- registering connections
- [Reconnection](./reconnection.md) -- auto-reconnect behavior
- [OAuth](./oauth.md) -- OAuth provider setup
- [Client API](./client-api.md) -- methods available on each client
