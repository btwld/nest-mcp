# Client API

`McpClient` wraps the MCP SDK `Client` and provides a typed, connection-aware interface for interacting with an MCP server. All request methods throw if the client is not connected.

## Connection lifecycle

| Method | Returns | Description |
|--------|---------|-------------|
| `connect()` | `Promise<void>` | Establishes the transport connection and performs the MCP handshake (bounded by `connectTimeout` when set) |
| `disconnect()` | `Promise<void>` | Ends the session (HTTP `DELETE` for Streamable HTTP, errors ignored), closes the transport, stops any reconnection in progress and forgets tracked resource subscriptions |
| `isConnected()` | `boolean` | Returns `true` if the client is currently connected |

Connection is managed automatically by `McpClientBootstrap` during the NestJS application lifecycle. You typically do not need to call `connect()` or `disconnect()` manually.

A client closed with `disconnect()` is never reconnected automatically, even if a reconnection attempt was already under way; call `connect()` to open it again.

## Tools

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `callTool(params, options?)` | `CallToolRequest['params']` | `Promise<CallToolResult>` | Calls a tool on the server |
| `listTools(params?, options?)` | `ListToolsRequest['params']` | `Promise<ListToolsResult>` | Lists tools (single page) |
| `listAllTools(options?)` | `RequestOptions` | `Promise<Tool[]>` | Lists all tools across all pages |

### Example: calling a tool

```typescript
const result = await client.callTool({
  name: 'calculate',
  arguments: { expression: '2 + 2' },
});
// result.content contains the tool output
```

### Example: listing all tools

```typescript
const tools = await client.listAllTools();
for (const tool of tools) {
  console.log(tool.name, tool.inputSchema);
}
```

## Resources

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `readResource(params, options?)` | `ReadResourceRequest['params']` | `Promise<ReadResourceResult>` | Reads a resource by URI |
| `listResources(params?, options?)` | `ListResourcesRequest['params']` | `Promise<ListResourcesResult>` | Lists resources (single page) |
| `listAllResources(options?)` | `RequestOptions` | `Promise<Resource[]>` | Lists all resources across all pages |
| `listResourceTemplates(params?, options?)` | `ListResourceTemplatesRequest['params']` | `Promise<ListResourceTemplatesResult>` | Lists resource templates (single page) |
| `listAllResourceTemplates(options?)` | `RequestOptions` | `Promise<ResourceTemplate[]>` | Lists all resource templates across all pages |
| `subscribeResource(params, options?)` | `SubscribeRequest['params']` | `Promise<...>` | Subscribes to resource change notifications |
| `unsubscribeResource(params, options?)` | `UnsubscribeRequest['params']` | `Promise<...>` | Unsubscribes from resource change notifications |

Successful `subscribeResource` calls are remembered and sent again after the client reconnects, so subscriptions survive a lost connection or an expired session. `unsubscribeResource` removes the URI from that list (even if the request itself fails). A re-subscription that fails after a reconnect is logged as a warning and does not fail the reconnect.

### Example: reading a resource

```typescript
const resource = await client.readResource({ uri: 'file:///data.json' });
for (const content of resource.contents) {
  console.log(content.text);
}
```

## Prompts

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `getPrompt(params, options?)` | `GetPromptRequest['params']` | `Promise<GetPromptResult>` | Retrieves a prompt by name |
| `listPrompts(params?, options?)` | `ListPromptsRequest['params']` | `Promise<ListPromptsResult>` | Lists prompts (single page) |
| `listAllPrompts(options?)` | `RequestOptions` | `Promise<Prompt[]>` | Lists all prompts across all pages |

### Example: getting a prompt

```typescript
const prompt = await client.getPrompt({
  name: 'code-review',
  arguments: { language: 'typescript' },
});
console.log(prompt.messages);
```

## Completion

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `complete(params, options?)` | `CompleteRequest['params']` | `Promise<CompleteResult>` | Requests argument completions |

```typescript
const result = await client.complete({
  ref: { type: 'ref/prompt', name: 'code-review' },
  argument: { name: 'language', value: 'type' },
});
console.log(result.completion.values); // ['typescript', 'typelevel', ...]
```

## Logging

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `setLoggingLevel(level, options?)` | `LoggingLevel` | `Promise<...>` | Sets the server's logging level |

## Ping

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `ping(options?)` | `RequestOptions` | `Promise<...>` | Sends a ping to verify the server is responsive |

## Server-to-client handlers

These methods register handlers for requests initiated by the server. Each automatically declares the corresponding client capability.

| Method | Parameters | Description |
|--------|-----------|-------------|
| `setSamplingHandler(handler)` | `McpSamplingHandler` | Handles `sampling/createMessage` requests |
| `setElicitationHandler(handler, options?)` | `McpElicitationHandler`, `{ modes?: Array<'form' \| 'url'> }` | Handles `elicitation/create` requests; form mode only unless `modes` lists `'url'` |
| `setRootsHandler(handler)` | `McpRootsHandler` | Handles `roots/list` requests |
| `sendRootsListChanged()` | -- | Notifies the server that the roots list has changed |

Handlers receive the SDK's per-request context (`extra`: abort `signal`, `requestId`, `_meta`, `sendNotification`, `sendRequest`) as an optional extra argument. Declared capabilities are merged per key with the connection's `capabilities`, so explicit nested flags are kept. Register handlers before `connect()` so their capabilities are part of the handshake.

These can also be set via the connection config (see [Connections](./connections.md)).

## Notifications

| Method | Parameters | Description |
|--------|-----------|-------------|
| `onNotification(method, handler)` | method string, handler function | Adds a handler for a specific notification method |

Several handlers can be registered for the same method, and they persist across reconnects. See [Notifications](./notifications.md) for details and the decorator-based approach.

## Server info

| Method | Returns | Description |
|--------|---------|-------------|
| `getServerCapabilities()` | `ServerCapabilities \| undefined` | Returns capabilities advertised by the server |
| `getServerVersion()` | `Implementation \| undefined` | Returns the server's name and version |
| `getInstructions()` | `string \| undefined` | Returns server-provided instructions |
| `getClient()` | `Client` | Returns the underlying MCP SDK `Client` instance |

## Pagination

The `listAll*` methods (`listAllTools`, `listAllResources`, `listAllResourceTemplates`, `listAllPrompts`) handle pagination automatically using `drainAllPages` from `@nest-mcp/common`. They follow `nextCursor` tokens until all pages are fetched and return the complete array. As a safety limit they stop after 100 pages; when that happens while the server still reports more pages, a warning is logged and the partial list is returned.

`drainAllPages(fetchPage, maxPagesOrOptions?)` accepts either the page cap or `{ maxPages?, onTruncated? }`, where `onTruncated({ maxPages, itemCount, nextCursor })` is called when the cap cuts the listing short.

The single-page `list*` methods return the raw paginated result including the `nextCursor` field if you need manual pagination control.

## See Also

- [Injection](./injection.md) -- how to get an `McpClient` instance
- [Notifications](./notifications.md) -- `@OnMcpNotification` decorator
- [Connections](./connections.md) -- connection-level handler config
