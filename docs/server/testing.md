# Testing

The `@nest-mcp/server/testing` subpath export provides utilities for testing MCP handlers without starting a transport or HTTP server.

## Installation

The testing utilities are available from the `/testing` subpath:

```typescript
import { createMcpTestApp, mockMcpContext } from '@nest-mcp/server/testing';
```

## createMcpTestApp

Creates a lightweight NestJS testing module with the MCP registry and executor wired up. Handlers decorated with `@Tool`, `@Resource`, `@Prompt`, etc. are automatically discovered and registered.

```typescript
import { describe, it, expect, afterAll } from 'vitest';
import { createMcpTestApp } from '@nest-mcp/server/testing';
import type { McpTestApp } from '@nest-mcp/server/testing';
import { MCP_OPTIONS } from '@nest-mcp/common';
import { McpTransportType } from '@nest-mcp/common';
import { ToolsService } from './tools.service';

describe('ToolsService', () => {
  let app: McpTestApp;

  beforeAll(async () => {
    app = await createMcpTestApp({
      providers: [
        ToolsService,
        {
          provide: MCP_OPTIONS,
          useValue: {
            name: 'test',
            version: '1.0.0',
            transport: McpTransportType.STDIO,
          },
        },
      ],
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('should list the tool', async () => {
    const result = await app.listTools();
    expect(result.items).toContainEqual(
      expect.objectContaining({ name: 'add' }),
    );
  });

  it('should call the tool', async () => {
    const result = await app.callTool('add', { a: 2, b: 3 });
    expect(result.content[0]).toEqual({ type: 'text', text: '5' });
  });
});
```

### CreateTestAppOptions

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `providers` | `Provider[]` | Yes | NestJS providers (must include your services and `MCP_OPTIONS`) |
| `imports` | `Array<Type \| DynamicModule \| ForwardReference>` | No | Additional modules to import |

### McpTestApp API

| Method | Return Type | Description |
|--------|-------------|-------------|
| `callTool(name, args?)` | `Promise<ToolCallResult>` | Execute a tool handler |
| `readResource(uri)` | `Promise<ResourceReadResult>` | Read a resource |
| `listTools()` | `Promise<PaginatedResult>` | List all registered tools |
| `listResources()` | `Promise<PaginatedResult>` | List all registered resources |
| `listPrompts()` | `Promise<PaginatedResult>` | List all registered prompts |
| `getPrompt(name, args?)` | `Promise<PromptGetResult>` | Execute a prompt handler |
| `close()` | `Promise<void>` | Shut down the testing module |

`createMcpTestApp` bypasses the execution pipeline (auth, middleware, resilience). It calls `McpExecutorService` directly, which is ideal for unit-testing handler logic.

## mockMcpContext

Creates a mock `McpExecutionContext` for direct handler testing without the DI container:

```typescript
import { mockMcpContext } from '@nest-mcp/server/testing';

const ctx = mockMcpContext();
// Returns:
// {
//   sessionId: 'test-session',
//   transport: McpTransportType.STDIO,
//   reportProgress: async () => {},
//   log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
//   metadata: {},
// }
```

### Custom Overrides

Pass partial overrides to customize the context:

```typescript
import { mockMcpContext } from '@nest-mcp/server/testing';
import { McpTransportType } from '@nest-mcp/common';

const ctx = mockMcpContext({
  sessionId: 'custom-session',
  transport: McpTransportType.STREAMABLE_HTTP,
  user: { id: 'user-1', scopes: ['tools:read'] },
  metadata: { custom: 'value' },
});
```

### Direct Handler Testing

For lightweight unit tests, you can instantiate services directly and call handler methods with a mock context:

```typescript
import { describe, it, expect } from 'vitest';
import { mockMcpContext } from '@nest-mcp/server/testing';
import { ToolsService } from './tools.service';

describe('ToolsService (direct)', () => {
  const service = new ToolsService();
  const ctx = mockMcpContext();

  it('should add numbers', async () => {
    const result = await service.add({ a: 2, b: 3 }, ctx);
    expect(result).toEqual({
      content: [{ type: 'text', text: '5' }],
    });
  });
});
```

## Testing Patterns

### Testing with Dependencies

When your service has injected dependencies, provide them as additional providers:

```typescript
app = await createMcpTestApp({
  providers: [
    ToolsService,
    { provide: DatabaseService, useValue: mockDatabaseService },
    { provide: MCP_OPTIONS, useValue: { name: 'test', version: '1.0.0', transport: McpTransportType.STDIO } },
  ],
});
```

### Testing Resource Templates

```typescript
it('should read a templated resource', async () => {
  const result = await app.readResource('users://123/profile');
  expect(result.contents[0].text).toContain('123');
});
```

### Testing Prompts

```typescript
it('should generate a prompt', async () => {
  const result = await app.getPrompt('code-review', {
    language: 'typescript',
    code: 'const x = 1;',
  });
  expect(result.messages).toHaveLength(1);
  expect(result.messages[0].role).toBe('user');
});
```

### Testing Error Cases

```typescript
it('should throw for unknown tool', async () => {
  await expect(app.callTool('nonexistent')).rejects.toThrow('not found');
});

it('should throw for invalid parameters', async () => {
  await expect(app.callTool('add', { a: 'not-a-number' })).rejects.toThrow();
});
```

## See Also

- [Decorators](./decorators.md) -- Declaring handlers to test
- [Getting Started](./getting-started.md) -- Full working examples
- [Execution Pipeline](./execution-pipeline.md) -- Understanding what `createMcpTestApp` bypasses
