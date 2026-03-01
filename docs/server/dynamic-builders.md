# Dynamic Builders

Dynamic builders allow you to register and unregister tools, resources, and prompts at runtime, without using decorators. This is useful for plugin systems, gateway proxies, or any scenario where the set of available handlers is determined dynamically.

## McpToolBuilder

Register and unregister tools at runtime.

```typescript
import { Injectable, OnModuleInit } from '@nestjs/common';
import { McpToolBuilder } from '@nest-mcp/server';
import { z } from 'zod';

@Injectable()
export class PluginLoader implements OnModuleInit {
  constructor(private readonly toolBuilder: McpToolBuilder) {}

  onModuleInit() {
    this.toolBuilder.register({
      name: 'dynamic-tool',
      description: 'A dynamically registered tool',
      parameters: z.object({ input: z.string() }),
      handler: async (args, ctx) => {
        return { content: [{ type: 'text', text: `Echo: ${args.input}` }] };
      },
    });
  }
}
```

### DynamicToolConfig

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `name` | `string` | Yes | Tool name |
| `description` | `string` | Yes | Tool description |
| `parameters` | `ZodType` | No | Zod schema for input validation |
| `inputSchema` | `Record<string, unknown>` | No | Raw JSON schema (alternative to Zod) |
| `outputSchema` | `ZodType` | No | Zod schema for output |
| `rawOutputSchema` | `Record<string, unknown>` | No | Raw JSON schema for output |
| `annotations` | `ToolAnnotations` | No | Behavioral hints |
| `handler` | `(args, ctx) => Promise<ToolCallResult \| string \| unknown>` | Yes | Tool handler function |
| `scopes` | `string[]` | No | Required OAuth scopes |
| `roles` | `string[]` | No | Required roles |
| `isPublic` | `boolean` | No | Mark as public (skip auth) |

### Unregistering

```typescript
this.toolBuilder.unregister('dynamic-tool'); // returns true if found
```

When a tool is unregistered, active sessions receive a `notifications/tools/list_changed` notification automatically.

## McpResourceBuilder

Register and unregister resources at runtime.

```typescript
import { Injectable, OnModuleInit } from '@nestjs/common';
import { McpResourceBuilder } from '@nest-mcp/server';

@Injectable()
export class ResourceLoader implements OnModuleInit {
  constructor(private readonly resourceBuilder: McpResourceBuilder) {}

  onModuleInit() {
    this.resourceBuilder.register({
      uri: 'config://dynamic/setting',
      name: 'dynamic-setting',
      description: 'A dynamically registered resource',
      mimeType: 'application/json',
      handler: async (uri, ctx) => {
        return JSON.stringify({ key: 'value' });
      },
    });
  }
}
```

### DynamicResourceConfig

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `uri` | `string` | Yes | Resource URI |
| `name` | `string` | Yes | Resource name |
| `description` | `string` | No | Resource description |
| `mimeType` | `string` | No | MIME type |
| `handler` | `(uri: URL, ctx) => Promise<ResourceReadResult \| string \| unknown>` | Yes | Resource handler |

### Unregistering

```typescript
this.resourceBuilder.unregister('config://dynamic/setting'); // by URI
```

## McpPromptBuilder

Register and unregister prompts at runtime.

```typescript
import { Injectable, OnModuleInit } from '@nestjs/common';
import { McpPromptBuilder } from '@nest-mcp/server';
import { z } from 'zod';

@Injectable()
export class PromptLoader implements OnModuleInit {
  constructor(private readonly promptBuilder: McpPromptBuilder) {}

  onModuleInit() {
    this.promptBuilder.register({
      name: 'dynamic-prompt',
      description: 'A dynamically registered prompt',
      parameters: z.object({
        topic: z.string().describe('The topic to discuss'),
      }),
      handler: async (args, ctx) => {
        return {
          messages: [
            {
              role: 'user',
              content: { type: 'text', text: `Let's discuss: ${args.topic}` },
            },
          ],
        };
      },
    });
  }
}
```

### DynamicPromptConfig

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `name` | `string` | Yes | Prompt name |
| `description` | `string` | Yes | Prompt description |
| `parameters` | `ZodObject` | No | Zod schema for prompt arguments |
| `handler` | `(args, ctx) => Promise<PromptGetResult>` | Yes | Prompt handler |

### Unregistering

```typescript
this.promptBuilder.unregister('dynamic-prompt');
```

## Registry Events

When items are registered or unregistered through builders, the `McpRegistryService` emits events that all active transport sessions listen to:

| Event | Payload | Description |
|-------|---------|-------------|
| `tool.registered` | `RegisteredTool` | New tool available |
| `tool.unregistered` | `string` (name) | Tool removed |
| `resource.registered` | `RegisteredResource` | New resource available |
| `resource.unregistered` | `string` (URI) | Resource removed |
| `prompt.registered` | `RegisteredPrompt` | New prompt available |
| `prompt.unregistered` | `string` (name) | Prompt removed |
| `resourceTemplate.registered` | `RegisteredResourceTemplate` | New template available |
| `resourceTemplate.unregistered` | `string` (uriTemplate) | Template removed |

This ensures that all connected clients are notified of changes via `list_changed` notifications.

## See Also

- [Decorators](./decorators.md) -- Static handler registration via decorators
- [Sessions](./sessions.md) -- How dynamic changes propagate to sessions
- [Module](./module.md) -- Builder services are exported globally
