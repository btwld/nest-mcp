# Testing

`@nest-mcp/client` provides `MockMcpClient` for unit testing services that depend on `McpClient`.

## MockMcpClient

`MockMcpClient` implements the same interface as `McpClient` with controllable return values and no real network connections. Import it from `@nest-mcp/client`:

```typescript
import { MockMcpClient } from '@nest-mcp/client';
```

## Basic usage

```typescript
import { MockMcpClient } from '@nest-mcp/client';

describe('MyService', () => {
  let service: MyService;
  let mockClient: MockMcpClient;

  beforeEach(() => {
    mockClient = new MockMcpClient('my-server');
    service = new MyService(mockClient as any);
  });

  it('should call a tool', async () => {
    mockClient.setCallToolResult({
      content: [{ type: 'text', text: 'Hello, World!' }],
    });

    const result = await service.doSomething();
    expect(result.content[0].text).toBe('Hello, World!');
  });
});
```

## Constructor

```typescript
const mock = new MockMcpClient(name?: string);
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `name` | `string` | `'mock'` | The connection name |

## Connection methods

| Method | Behavior |
|--------|----------|
| `connect()` | Sets internal connected state to `true` |
| `disconnect()` | Sets internal connected state to `false` |
| `isConnected()` | Returns the internal connected state |
| `getClient()` | Returns `null` (no real SDK client) |

## Configuring return values

All setter methods return `this` for chaining:

```typescript
const mock = new MockMcpClient('test')
  .setCallToolResult({ content: [{ type: 'text', text: 'result' }] })
  .setListToolsResult({ tools: [{ name: 'my-tool', inputSchema: { type: 'object' } }] })
  .setServerVersion({ name: 'test-server', version: '1.0.0' });
```

### Available setters

| Method | Controls return value of |
|--------|------------------------|
| `setCallToolResult(result)` | `callTool()` |
| `setReadResourceResult(result)` | `readResource()` |
| `setListToolsResult(result)` | `listTools()` and `listAllTools()` |
| `setListResourcesResult(result)` | `listResources()` and `listAllResources()` |
| `setListResourceTemplatesResult(result)` | `listResourceTemplates()` and `listAllResourceTemplates()` |
| `setGetPromptResult(result)` | `getPrompt()` |
| `setListPromptsResult(result)` | `listPrompts()` and `listAllPrompts()` |
| `setCompleteResult(result)` | `complete()` |
| `setServerCapabilities(capabilities)` | `getServerCapabilities()` |
| `setServerVersion(version)` | `getServerVersion()` |
| `setInstructions(instructions)` | `getInstructions()` |

### Default return values

If no setter is called, methods return sensible empty defaults:

| Method | Default |
|--------|---------|
| `callTool()` | `{ content: [] }` |
| `readResource()` | `{ contents: [] }` |
| `listTools()` | `{ tools: [] }` |
| `listResources()` | `{ resources: [] }` |
| `listResourceTemplates()` | `{ resourceTemplates: [] }` |
| `getPrompt()` | `{ messages: [] }` |
| `listPrompts()` | `{ prompts: [] }` |
| `complete()` | `{ completion: { values: [] } }` |
| `ping()` | `{}` |

## No-op methods

These methods are no-ops on the mock and do not throw:

- `subscribeResource()` -- returns `{}`
- `unsubscribeResource()` -- returns `{}`
- `setLoggingLevel()` -- returns `{}`
- `sendRootsListChanged()` -- returns `void`
- `setSamplingHandler()` -- no-op
- `setElicitationHandler()` -- no-op
- `setRootsHandler()` -- no-op

## Notification handlers

`MockMcpClient` stores notification handlers registered via `onNotification()` internally, matching the real client behavior:

```typescript
const mock = new MockMcpClient('test');
mock.onNotification('notifications/tools/list_changed', (n) => {
  console.log('Tools changed');
});
```

## Using with NestJS DI in tests

To replace a real client with the mock in a NestJS testing module:

```typescript
import { Test } from '@nestjs/testing';
import { getMcpClientToken, MockMcpClient } from '@nest-mcp/client';

const mockClient = new MockMcpClient('my-server');

const module = await Test.createTestingModule({
  providers: [
    MyService,
    {
      provide: getMcpClientToken('my-server'),
      useValue: mockClient,
    },
  ],
}).compile();

const service = module.get(MyService);
```

## See Also

- [Client API](./client-api.md) -- methods that `MockMcpClient` mirrors
- [Injection](./injection.md) -- `getMcpClientToken` for DI replacement
