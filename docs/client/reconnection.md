# Reconnection

`McpClient` supports automatic reconnection with a linearly increasing delay when a transport connection is lost or the server expires the session.

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

Each attempt's `initialize` handshake is bounded by the connection's `connectTimeout`, when set.

## Backoff behavior

The delay before each reconnection attempt increases linearly with the attempt number:

```
Attempt 1: delay * 1  (e.g., 1000ms)
Attempt 2: delay * 2  (e.g., 2000ms)
Attempt 3: delay * 3  (e.g., 3000ms)
...
Attempt N: delay * N
```

For example, with `delay: 1000` and `maxAttempts: 5`, the reconnection attempts occur at approximately 1s, 2s, 3s, 4s, and 5s after the previous attempt.

## What triggers a reconnection

- **The transport closes** (its `onclose` callback fires): the server went away, the child process exited, the stream ended.
- **The session expired** (Streamable HTTP): the server answered a request with HTTP 404, which per the MCP specification means the `Mcp-Session-Id` is no longer valid and the client must start a new session. The SDK reports this as an error without closing the transport, so the client closes it and follows the same path as a closed transport. The request that received the 404 still fails; requests made after the reconnect use the new session.

## What happens during reconnection

1. The client is set to a disconnected state.
2. If `reconnect` is configured, the client enters the reconnection loop. Without it, the client stays disconnected (see below).
3. On each attempt:
   - A new MCP SDK `Client` instance is created with the same `clientInfo` and capabilities (including nested flags from the `capabilities` option)
   - All request handlers (sampling, elicitation, roots) are re-applied to the new client
   - All notification handlers are re-applied
   - A new transport is created and a new `initialize` handshake is performed. A configured `sessionId` is not reused: every reconnection starts a new session
4. On success, the reconnect counter resets to 0, resource subscriptions are re-sent (see below), and the client is fully operational.
5. On failure after all attempts are exhausted, an error is logged and the client remains disconnected.

## Closing stops reconnection

`disconnect()` (called on application shutdown and by `McpClientsService.removeConnection()`) cancels reconnection:

- A pending attempt is abandoned before or after its backoff delay.
- If an attempt's handshake was already in flight, the new connection is closed as soon as it completes, and the client stays disconnected.
- A transport closing after `disconnect()` does not start a reconnection.

Calling `connect()` again re-enables automatic reconnection for later connection losses.

## Resource subscriptions

URIs passed to successful `subscribeResource()` calls are tracked and re-subscribed on the new session after every successful reconnect. `unsubscribeResource()` removes a URI from that list, and `disconnect()` clears it. A re-subscription that fails is logged as a warning; it does not fail the reconnect.

## State during reconnection

- `client.isConnected()` returns `false` while reconnecting.
- Any calls to `callTool`, `listTools`, etc. will throw with `McpClient "<name>" is not connected`.
- Only one reconnection loop runs at a time per client (concurrent disconnect events do not trigger parallel reconnection attempts).

## Without reconnection

If `reconnect` is not set, a lost connection or an expired session logs a warning and the client stays disconnected. You would need to call `client.connect()` manually to re-establish the connection; resource subscriptions are re-sent when it succeeds.

## Handler persistence

Both notification handlers (registered via `@OnMcpNotification` or `onNotification()`) and request handlers (`setSamplingHandler`, `setElicitationHandler`, `setRootsHandler`) are preserved across reconnections. They are automatically re-registered on the new client instance.

## Transport-level stream reconnection

The Streamable HTTP transport separately re-opens dropped SSE streams within a session. That behavior is configured with the connection's `reconnectionOptions` (see [Connections](./connections.md#streamable-http-specific-options)) and is independent of the `reconnect` option described here.

## See Also

- [Connections](./connections.md) -- connection configuration
- [Notifications](./notifications.md) -- handler persistence
- [Health Checks](./health.md) -- monitoring connection status
