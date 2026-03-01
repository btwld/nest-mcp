# Notifications

MCP servers can send notifications to clients. `@nest-mcp/client` provides the `@OnMcpNotification` decorator to handle these notifications declaratively.

## @OnMcpNotification

Decorate a method on any NestJS injectable to handle a specific notification from a named connection:

```typescript
import { Injectable } from '@nestjs/common';
import { OnMcpNotification } from '@nest-mcp/client';

@Injectable()
export class NotificationHandler {
  @OnMcpNotification('my-server', 'notifications/resources/updated')
  async onResourceUpdated(notification: {
    method: string;
    params?: Record<string, unknown>;
  }) {
    console.log('Resource updated:', notification.params);
  }

  @OnMcpNotification('my-server', 'notifications/tools/list_changed')
  async onToolsChanged(notification: {
    method: string;
    params?: Record<string, unknown>;
  }) {
    console.log('Tools list changed');
  }
}
```

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `connectionName` | `string` | The name of the client connection (must match a connection name in module config) |
| `method` | `string` | The MCP notification method to handle |

### Handler signature

The decorated method receives a notification object:

```typescript
{
  method: string;               // The notification method name
  params?: Record<string, unknown>; // Optional notification parameters
}
```

## How it works

1. During application bootstrap, after all clients are connected, `McpClientBootstrap` scans all NestJS providers for methods decorated with `@OnMcpNotification`.
2. For each decorated method, it finds the matching client by `connectionName` and calls `client.onNotification(method, handler)`.
3. The handler is bound to the provider instance, so `this` references work correctly.
4. If no client matches the `connectionName`, a warning is logged and the handler is skipped.

## Persistence across reconnects

Notification handlers registered via `@OnMcpNotification` (or the programmatic `client.onNotification()` method) are stored internally and automatically re-applied after a reconnection. You do not need to re-register handlers when a client reconnects.

## Programmatic alternative

You can also register notification handlers programmatically using the `onNotification` method on `McpClient`:

```typescript
import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectMcpClient, McpClient } from '@nest-mcp/client';

@Injectable()
export class MyService implements OnModuleInit {
  constructor(@InjectMcpClient('my-server') private readonly mcp: McpClient) {}

  onModuleInit() {
    this.mcp.onNotification('notifications/resources/updated', (notification) => {
      console.log('Resource updated:', notification.params);
    });
  }
}
```

## Common notification methods

These are standard MCP notification methods that servers may send:

| Method | Description |
|--------|-------------|
| `notifications/resources/updated` | A subscribed resource has changed |
| `notifications/resources/list_changed` | The list of available resources has changed |
| `notifications/tools/list_changed` | The list of available tools has changed |
| `notifications/prompts/list_changed` | The list of available prompts has changed |
| `notifications/message` | A log message from the server |

## See Also

- [Client API](./client-api.md) -- `onNotification` method
- [Reconnection](./reconnection.md) -- handler persistence across reconnects
- [Injection](./injection.md) -- getting a client reference
