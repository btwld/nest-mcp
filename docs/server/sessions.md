# Sessions

The server package provides three managers for session-scoped state: `SessionManager`, `ResourceSubscriptionManager`, and `TaskManager`.

## SessionManager

Manages MCP session lifecycle with configurable timeouts and concurrency limits.

### Configuration

The `SessionManager` is configured automatically from `McpModule.forRoot` session options, or can be configured manually:

```typescript
import { Injectable, OnModuleInit } from '@nestjs/common';
import { SessionManager } from '@nest-mcp/server';

@Injectable()
export class AppService implements OnModuleInit {
  constructor(private readonly sessions: SessionManager) {}

  onModuleInit() {
    this.sessions.configure({
      timeout: 30 * 60 * 1000,     // 30 minutes (default)
      maxConcurrent: 1000,          // max sessions (default)
      cleanupInterval: 5 * 60 * 1000, // 5 minutes (default)
    });
  }
}
```

Or via module options:

```typescript
McpModule.forRoot({
  name: 'my-server',
  version: '1.0.0',
  transport: McpTransportType.STREAMABLE_HTTP,
  session: {
    timeout: 60 * 60 * 1000,   // 1 hour
    maxConcurrent: 500,
    cleanupInterval: 60 * 1000, // 1 minute
  },
});
```

### API

```typescript
// Create a new session
const session = sessions.createSession('session-id');
// Returns: { id, createdAt, lastActivityAt, metadata }

// Retrieve (and touch) a session
const session = sessions.getSession('session-id');
// Returns undefined if not found; updates lastActivityAt on access

// Remove a session
sessions.removeSession('session-id');

// Get count of active sessions
const count = sessions.getActiveSessions();
```

### Concurrency Limits

When `createSession` is called and the session count has reached `maxConcurrent`, the manager:

1. Runs an immediate cleanup of expired sessions.
2. If still at capacity, throws `McpError('Maximum concurrent sessions exceeded')`.

### Automatic Cleanup

Expired sessions (where `now - lastActivityAt > timeout`) are removed automatically at the configured `cleanupInterval`.

## ResourceSubscriptionManager

Tracks per-session resource subscriptions and dispatches `notifications/resources/updated` to subscribed clients.

### How It Works

Clients subscribe to resource URIs via the `resources/subscribe` JSON-RPC method. The manager tracks which sessions are subscribed to which URIs. When a resource changes, the manager sends an update notification to all subscribed sessions.

### API

```typescript
import { ResourceSubscriptionManager } from '@nest-mcp/server';

// Subscribe a session to a resource URI
manager.subscribe(sessionId, 'data://users/count', mcpServer);

// Unsubscribe
manager.unsubscribe(sessionId, 'data://users/count');

// Remove all subscriptions for a session (called on session close)
manager.removeSession(sessionId);

// Notify all subscribers that a resource has been updated
await manager.notifyResourceUpdated('data://users/count');
```

### Triggering Notifications

Tools can notify subscribers of resource changes through the execution context:

```typescript
@Tool({
  name: 'update-config',
  description: 'Update a config value',
  parameters: z.object({ key: z.string(), value: z.string() }),
})
async updateConfig(args: { key: string; value: string }, ctx: McpExecutionContext) {
  // ... update the config ...

  // Notify subscribers that the resource changed
  await ctx.notifyResourceUpdated?.('config://app/settings');

  return { content: [{ type: 'text', text: 'Updated' }] };
}
```

### Enabling Subscriptions

Resource subscriptions require the `resources.subscribe` capability:

```typescript
McpModule.forRoot({
  name: 'my-server',
  version: '1.0.0',
  transport: McpTransportType.STREAMABLE_HTTP,
  capabilities: {
    resources: { subscribe: true },
  },
});
```

## TaskManager

Manages long-running task lifecycle and session-scoped task tracking. Wraps the MCP SDK's `InMemoryTaskStore` and `InMemoryTaskMessageQueue`.

### How It Works

The `TaskManager` provides a `TaskStore` and `TaskMessageQueue` that are passed to the SDK's `McpServer` constructor. The SDK automatically registers handlers for `tasks/get`, `tasks/list`, `tasks/cancel`, and `tasks/result`.

Additionally, the `TaskManager` tracks which tasks belong to which sessions, so non-terminal tasks can be cancelled when a session closes.

### API

```typescript
import { TaskManager } from '@nest-mcp/server';

// Access the underlying store and queue (passed to McpServer)
const store = taskManager.store;
const queue = taskManager.queue;

// Associate a task with a session
taskManager.trackTask(taskId, sessionId);

// Clean up all tasks for a session (cancels non-terminal tasks)
await taskManager.removeSession(sessionId);
```

### Task States

| Status | Terminal | Description |
|--------|----------|-------------|
| `running` | No | Task is in progress |
| `completed` | Yes | Task finished successfully |
| `failed` | Yes | Task finished with an error |
| `cancelled` | Yes | Task was cancelled |

When `removeSession` is called, tasks in non-terminal states (`running`) are moved to `cancelled` with the message "Session closed".

### Enabling Tasks

Tasks require the `tasks.enabled` capability:

```typescript
McpModule.forRoot({
  name: 'my-server',
  version: '1.0.0',
  transport: McpTransportType.STREAMABLE_HTTP,
  capabilities: {
    tasks: { enabled: true },
  },
});
```

## Session Cleanup Across Transports

All three transport implementations (SSE, Streamable HTTP, STDIO) call both `subscriptionManager.removeSession` and `taskManager.removeSession` when a session closes. This ensures:

- Subscriptions are removed so no stale notifications are sent.
- Running tasks are cancelled so no orphaned work remains.

## See Also

- [Transports](./transports.md) -- Session lifecycle per transport
- [Module](./module.md) -- Session configuration options
- [Execution Pipeline](./execution-pipeline.md) -- How context propagates through the pipeline
