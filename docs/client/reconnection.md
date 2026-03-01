# Reconnection

`McpClient` supports automatic reconnection with exponential backoff when a transport connection is lost.

## Configuration

Add a `reconnect` option to any connection configuration:

```typescript
McpClientModule.forRoot({
  connections: [
    {
      name: 'my-server',
      transport: 'streamable-http',
      url: 'http://localhost:3001/mcp',
      reconnect: {
        maxAttempts: 10,
        delay: 2000,
      },
    },
  ],
})
```

### Options

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `maxAttempts` | `number` | `5` | Maximum number of reconnection attempts before giving up |
| `delay` | `number` | `1000` | Base delay in milliseconds between reconnection attempts |

## Backoff behavior

The delay between reconnection attempts increases linearly with the attempt number:

```
Attempt 1: delay * 1  (e.g., 1000ms)
Attempt 2: delay * 2  (e.g., 2000ms)
Attempt 3: delay * 3  (e.g., 3000ms)
...
Attempt N: delay * N
```

For example, with `delay: 1000` and `maxAttempts: 5`, the reconnection attempts occur at approximately 1s, 2s, 3s, 4s, and 5s after the previous attempt.

## What happens during reconnection

1. The transport's `onclose` callback fires, setting the client to a disconnected state.
2. If `reconnect` is configured, the client enters the reconnection loop.
3. On each attempt:
   - A new MCP SDK `Client` instance is created
   - All request handlers (sampling, elicitation, roots) are re-applied to the new client
   - A new transport is created and connected
   - All notification handlers are re-applied
4. On success, the reconnect counter resets to 0 and the client is fully operational.
5. On failure after all attempts are exhausted, an error is logged and the client remains disconnected.

## State during reconnection

- `client.isConnected()` returns `false` while reconnecting.
- Any calls to `callTool`, `listTools`, etc. will throw with `McpClient "<name>" is not connected`.
- Only one reconnection loop runs at a time per client (concurrent disconnect events do not trigger parallel reconnection attempts).

## Without reconnection

If `reconnect` is not set, a lost connection simply logs a warning and the client stays disconnected. You would need to call `client.connect()` manually to re-establish the connection.

## Handler persistence

Both notification handlers (registered via `@OnMcpNotification` or `onNotification()`) and request handlers (`setSamplingHandler`, `setElicitationHandler`, `setRootsHandler`) are preserved across reconnections. They are automatically re-registered on the new client instance.

## See Also

- [Connections](./connections.md) -- connection configuration
- [Notifications](./notifications.md) -- handler persistence
- [Health Checks](./health.md) -- monitoring connection status
