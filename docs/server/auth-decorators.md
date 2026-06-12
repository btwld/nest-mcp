# Auth Decorators

Auth decorators control access to individual tools, resources, and prompts. They are applied alongside `@Tool`, `@Resource`, `@ResourceTemplate`, or `@Prompt` on the same method.

## @Public

Marks a handler as publicly accessible, bypassing all auth checks (scopes, roles, and guards).

```typescript
import { Injectable } from '@nestjs/common';
import { Tool, Public } from '@nest-mcp/server';
import { z } from 'zod';

@Injectable()
export class HealthService {
  @Tool({
    name: 'health-check',
    description: 'Check server health',
  })
  @Public()
  async healthCheck() {
    return { content: [{ type: 'text', text: 'OK' }] };
  }
}
```

When `@Public()` is applied, the `ToolAuthGuardService` skips all authorization checks for that handler.

## @Scopes

Requires the authenticated user to have all specified OAuth scopes.

```typescript
import { Injectable } from '@nestjs/common';
import { Tool, Scopes } from '@nest-mcp/server';
import { z } from 'zod';

@Injectable()
export class AdminService {
  @Tool({
    name: 'delete-user',
    description: 'Delete a user account',
    parameters: z.object({ userId: z.string() }),
  })
  @Scopes(['users:write', 'admin'])
  async deleteUser(args: { userId: string }) {
    // Only accessible to users with both 'users:write' AND 'admin' scopes
    return { content: [{ type: 'text', text: `Deleted user ${args.userId}` }] };
  }
}
```

Scope checking is conjunctive -- the user must have **all** listed scopes. Scopes are read from `ctx.user.scopes`, which is populated from the verified bearer token when the transport OAuth gate is enabled (see [Auth](./auth.md)).

## @Roles

Requires the authenticated user to have at least one of the specified roles.

```typescript
import { Injectable } from '@nestjs/common';
import { Tool, Roles } from '@nest-mcp/server';

@Injectable()
export class DataService {
  @Tool({
    name: 'export-data',
    description: 'Export all data as CSV',
  })
  @Roles(['admin', 'data-analyst'])
  async exportData() {
    // Accessible to users with EITHER 'admin' OR 'data-analyst' role
    return { content: [{ type: 'text', text: 'data,...' }] };
  }
}
```

Role checking is disjunctive -- the user must have **at least one** of the listed roles. Roles are read from `ctx.user.roles`.

## @Guards

Attaches custom guard classes to a handler for fine-grained authorization logic.

```typescript
import type { McpGuard, McpGuardContext } from '@nest-mcp/common';
import { Injectable } from '@nestjs/common';
import { Tool, Guards } from '@nest-mcp/server';

class IpAllowlistGuard implements McpGuard {
  private readonly allowedIps = ['127.0.0.1', '::1'];

  async canActivate(context: McpGuardContext): Promise<boolean> {
    const req = context.request as { ip?: string } | undefined;
    return this.allowedIps.includes(req?.ip ?? '');
  }
}

@Injectable()
export class SecureService {
  @Tool({
    name: 'internal-op',
    description: 'Internal operation restricted by IP',
  })
  @Guards([IpAllowlistGuard])
  async internalOp() {
    return { content: [{ type: 'text', text: 'done' }] };
  }
}
```

### McpGuard Interface

```typescript
export interface McpGuard {
  canActivate(context: McpGuardContext): boolean | Promise<boolean>;
}

export interface McpGuardContext {
  sessionId: string;
  toolName?: string;
  resourceUri?: string;
  promptName?: string;
  /** Raw caller arguments (tools and prompts; pre-validation). */
  arguments?: Record<string, unknown>;
  user?: { id: string; roles?: string[]; scopes?: string[]; [key: string]: unknown };
  request?: unknown;
  /** Verified bearer-token identity, when HTTP edge auth is enabled. */
  authInfo?: McpAuthInfo;
  metadata: Record<string, unknown>;
}
```

Guards listed in `@Guards([...])` are resolved from the DI container first (via `ModuleRef.get`), falling back to direct instantiation. If a guard returns `false`, an `AuthorizationError` is thrown.

## Global Guards

Guards can also be applied globally to all requests via `McpModule.forRoot`:

```typescript
import { McpAuthenticatedGuard } from '@nest-mcp/server';

McpModule.forRoot({
  name: 'my-server',
  version: '1.0.0',
  transport: McpTransportType.STREAMABLE_HTTP,
  guards: [McpAuthenticatedGuard], // require a verified principal on every non-public call
});
```

Global guards are resolved from the DI container first (via `ModuleRef.get`), falling back to direct instantiation. They always run (so they can enrich the context — `ctx.user` is populated from the verified bearer token when the transport OAuth gate is enabled), and a `false` return denies the call with an `AuthorizationError` — except for `@Public` items, which stay reachable anonymously.

## Authorization Order

The execution pipeline applies auth in this order:

1. **Global guards** -- always run; a `false` return denies non-`@Public` items
2. **`@Public` check** -- If present, skip the remaining per-item checks
3. **`@Scopes` check** -- Verify required scopes
4. **`@Roles` check** -- Verify required roles
5. **`@Guards` check** -- Run per-handler custom guards

## See Also

- [Auth](./auth.md) -- `McpAuthModule` for OAuth/JWT setup
- [Decorators](./decorators.md) -- Core MCP decorators
- [Execution Pipeline](./execution-pipeline.md) -- Full request lifecycle
