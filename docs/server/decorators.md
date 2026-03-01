# Decorators

The server package provides five method decorators for declaring MCP handlers: `@Tool`, `@Resource`, `@ResourceTemplate`, `@Prompt`, and `@Completion`. All are applied to methods on NestJS `@Injectable()` providers.

## @Tool

Declares a method as an MCP tool handler.

```typescript
import { Injectable } from '@nestjs/common';
import { Tool } from '@nest-mcp/server';
import { z } from 'zod';
import type { McpExecutionContext } from '@nest-mcp/common';

@Injectable()
export class MathService {
  @Tool({
    name: 'multiply',
    description: 'Multiply two numbers',
    parameters: z.object({
      a: z.number().describe('First factor'),
      b: z.number().describe('Second factor'),
    }),
  })
  async multiply(args: { a: number; b: number }, ctx: McpExecutionContext) {
    return { content: [{ type: 'text', text: String(args.a * args.b) }] };
  }
}
```

### ToolOptions

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `name` | `string` | No | Tool name (defaults to the method name) |
| `title` | `string` | No | Human-readable display title |
| `description` | `string` | Yes | Tool description for the AI client |
| `parameters` | `ZodType` | No | Zod schema for input validation |
| `outputSchema` | `ZodType` | No | Zod schema describing the output |
| `annotations` | `ToolAnnotations` | No | Behavioral hints for the client |
| `icons` | `Icon[]` | No | Icons for UI display |
| `execution` | `ToolExecution` | No | Execution hints (e.g., task support) |
| `_meta` | `Record<string, unknown>` | No | Opaque metadata passed through to clients |

### ToolAnnotations

```typescript
@Tool({
  name: 'delete-file',
  description: 'Delete a file from the filesystem',
  parameters: z.object({ path: z.string() }),
  annotations: {
    destructiveHint: true,
    readOnlyHint: false,
    idempotentHint: true,
  },
})
```

| Annotation | Type | Description |
|------------|------|-------------|
| `title` | `string` | Display title |
| `readOnlyHint` | `boolean` | Tool only reads data |
| `destructiveHint` | `boolean` | Tool performs destructive operations |
| `idempotentHint` | `boolean` | Calling multiple times has same effect |
| `openWorldHint` | `boolean` | Tool interacts with the outside world |
| `streamingHint` | `boolean` | Tool emits incremental content via `streamContent` |

### Handler Signature

Tool handlers receive two arguments:

1. `args` -- Validated input parameters
2. `ctx` -- `McpExecutionContext` with session info, user, logging, progress reporting, etc.

The return value is automatically normalized (see [Getting Started](./getting-started.md#return-value-normalization)).

## @Resource

Declares a method as an MCP resource handler.

```typescript
import { Injectable } from '@nestjs/common';
import { Resource } from '@nest-mcp/server';

@Injectable()
export class DataService {
  @Resource({
    uri: 'data://users/count',
    name: 'user-count',
    description: 'Total number of registered users',
    mimeType: 'text/plain',
  })
  async getUserCount() {
    return '42';
  }
}
```

### ResourceOptions

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `uri` | `string` | Yes | Resource URI |
| `name` | `string` | No | Resource name (defaults to method name) |
| `title` | `string` | No | Human-readable display title |
| `description` | `string` | No | Resource description |
| `mimeType` | `string` | No | MIME type of the resource content |
| `icons` | `Icon[]` | No | Icons for UI display |
| `_meta` | `Record<string, unknown>` | No | Opaque metadata |

### Handler Signature

Resource handlers receive:

1. `uri` -- `URL` object of the requested resource
2. `ctx` -- `McpExecutionContext`

## @ResourceTemplate

Declares a method as an MCP resource template handler. Templates use URI patterns with parameters.

```typescript
import { Injectable } from '@nestjs/common';
import { ResourceTemplate } from '@nest-mcp/server';

@Injectable()
export class UserService {
  @ResourceTemplate({
    uriTemplate: 'users://{userId}/profile',
    name: 'user-profile',
    description: 'User profile by ID',
    mimeType: 'application/json',
  })
  async getProfile(uri: URL, params: { userId: string }) {
    return JSON.stringify({ id: params.userId, name: 'Alice' });
  }
}
```

### ResourceTemplateOptions

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `uriTemplate` | `string` | Yes | URI template with `{param}` placeholders |
| `name` | `string` | No | Template name (defaults to method name) |
| `title` | `string` | No | Human-readable display title |
| `description` | `string` | No | Template description |
| `mimeType` | `string` | No | MIME type of the resource content |
| `icons` | `Icon[]` | No | Icons for UI display |
| `_meta` | `Record<string, unknown>` | No | Opaque metadata |

### Handler Signature

Resource template handlers receive:

1. `uri` -- `URL` object of the resolved URI
2. `params` -- Extracted template parameters as a key-value object
3. `ctx` -- `McpExecutionContext`

## @Prompt

Declares a method as an MCP prompt handler.

```typescript
import { Injectable } from '@nestjs/common';
import { Prompt } from '@nest-mcp/server';
import { z } from 'zod';

@Injectable()
export class PromptService {
  @Prompt({
    name: 'code-review',
    description: 'Generate a code review prompt',
    parameters: z.object({
      language: z.string().describe('Programming language'),
      code: z.string().describe('Code to review'),
    }),
  })
  async codeReview(args: { language: string; code: string }) {
    return {
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Review this ${args.language} code:\n\n${args.code}`,
          },
        },
      ],
    };
  }
}
```

### PromptOptions

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `name` | `string` | No | Prompt name (defaults to method name) |
| `title` | `string` | No | Human-readable display title |
| `description` | `string` | No | Prompt description |
| `parameters` | `ZodObject` | No | Zod schema for prompt arguments |
| `icons` | `Icon[]` | No | Icons for UI display |
| `_meta` | `Record<string, unknown>` | No | Opaque metadata |

### Handler Signature

Prompt handlers receive:

1. `args` -- Validated prompt arguments
2. `ctx` -- `McpExecutionContext`

Prompt handlers must return `{ messages: [...] }`.

## @Completion

Declares a method as a completion handler for prompt arguments or resource template parameters. Provides auto-complete suggestions to clients.

```typescript
import { Injectable } from '@nestjs/common';
import { Completion } from '@nest-mcp/server';

@Injectable()
export class CompletionService {
  @Completion({
    refType: 'ref/prompt',
    refName: 'code-review',
  })
  async completeCodeReview(argName: string, argValue: string) {
    if (argName === 'language') {
      const languages = ['typescript', 'python', 'rust', 'go', 'java'];
      return {
        values: languages.filter(l => l.startsWith(argValue.toLowerCase())),
      };
    }
    return { values: [] };
  }
}
```

### CompletionOptions

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `refType` | `'ref/prompt' \| 'ref/resource'` | Yes | Whether this completes a prompt or resource template |
| `refName` | `string` | Yes | The prompt name or resource template URI |

### Handler Signature

Completion handlers receive:

1. `argName` -- Name of the argument being completed
2. `argValue` -- Current value (prefix) typed by the user
3. `context` -- Optional context from the completion request

Return `{ values: string[], hasMore?: boolean, total?: number }`.

If no custom `@Completion` handler is registered, the framework provides default completion for `ZodEnum` fields on prompts.

## See Also

- [Auth Decorators](./auth-decorators.md) -- `@Public`, `@Scopes`, `@Roles`, `@Guards`
- [Resilience Decorators](./resilience-decorators.md) -- `@RateLimit`, `@Retry`, `@CircuitBreaker`, `@Timeout`
- [Middleware](./middleware.md) -- `@UseMiddleware`
- [Execution Pipeline](./execution-pipeline.md) -- How decorators interact in the request lifecycle
