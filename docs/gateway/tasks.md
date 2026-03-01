# Tasks

The `TaskAggregatorService` proxies MCP task operations (list, get, cancel, get payload) from downstream clients to the appropriate upstream servers. Task IDs are prefixed with the upstream name so the gateway can route them back to the correct upstream.

## Task ID format

Gateway task IDs use the format:

```
{upstreamName}::{originalTaskId}
```

For example, a task with ID `abc-123` from the `weather` upstream becomes `weather::abc-123` in the gateway.

When a downstream client references a task ID, the gateway parses it to extract the upstream name and original ID, then forwards the operation to that upstream.

## Task status notifications

When an upstream server emits a `notifications/tasks/status` notification, the gateway:

1. Prefixes the `taskId` with the upstream name
2. Broadcasts the notification to all downstream sessions

This ensures downstream clients receive real-time task status updates with gateway-scoped task IDs.

## Operations

### List tasks

Fans out `tasks/list` to all healthy upstreams in parallel and merges the results. Task IDs in the response are prefixed.

```typescript
import { Injectable } from '@nestjs/common';
import { TaskAggregatorService } from '@nest-mcp/gateway';

@Injectable()
export class MyService {
  constructor(private readonly taskAggregator: TaskAggregatorService) {}

  async listAllTasks() {
    const result = await this.taskAggregator.listTasks();
    for (const task of result.tasks) {
      console.log(`Task: ${task.taskId}, status: ${task.status}`);
      // task.taskId is "weather::abc-123" format
    }
  }
}
```

### Get task

Parses the prefixed task ID, checks upstream health, and forwards `tasks/get` to the correct upstream.

```typescript
const task = await this.taskAggregator.getTask('weather::abc-123');
if (task) {
  console.log(`Status: ${task.status}`);
}
```

Returns `undefined` if:
- The task ID format is invalid (no `::` separator)
- The upstream is unhealthy
- The upstream client is not connected
- The upstream returns an error

### Cancel task

Forwards `tasks/cancel` to the correct upstream after unprefixing the task ID.

```typescript
const cancelled = await this.taskAggregator.cancelTask('weather::abc-123');
if (cancelled) {
  console.log(`Cancelled task: ${cancelled.taskId}`);
}
```

Returns `undefined` on failure, same conditions as `getTask`.

### Get task payload

Forwards `tasks/result` to the correct upstream. Unlike the other operations, this method throws errors instead of returning `undefined`:

```typescript
try {
  const payload = await this.taskAggregator.getTaskPayload('weather::abc-123');
  console.log('Payload:', payload);
} catch (error) {
  // Thrown if: invalid ID, unhealthy upstream, or upstream not connected
  console.error(error.message);
}
```

## Gateway registration

The gateway module automatically registers task handlers during bootstrap so that downstream clients can use the standard MCP task protocol:

```typescript
this.registry.registerTaskHandlers({
  listTasks: (cursor) => this.taskAggregator.listTasks(cursor),
  getTask: (taskId) => this.taskAggregator.getTask(taskId),
  cancelTask: (taskId) => this.taskAggregator.cancelTask(taskId),
  getTaskPayload: (taskId) => this.taskAggregator.getTaskPayload(taskId),
});
```

The gateway also enables the `tasks` capability automatically on the underlying MCP server, regardless of whether it was set in the `server` options.

## Key methods

| Method | Description |
|--------|-------------|
| `buildTaskId(upstreamName, taskId)` | Create a prefixed gateway task ID. |
| `parseTaskId(prefixedId)` | Parse a gateway task ID into `{ upstreamName, originalId }`. Returns `undefined` if invalid. |
| `listTasks(cursor?)` | Fan out to all healthy upstreams and merge results. |
| `getTask(prefixedId)` | Forward to the correct upstream. Returns `undefined` on failure. |
| `cancelTask(prefixedId)` | Forward cancel to the correct upstream. Returns `undefined` on failure. |
| `getTaskPayload(prefixedId)` | Forward to the correct upstream. Throws on failure. |

## See Also

- [Upstreams](./upstreams.md) -- upstream health affects task operations
- [Health](./health.md) -- how health status is determined
- [Module](./module.md) -- bootstrap lifecycle and task handler registration
