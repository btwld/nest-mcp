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

Scope checking is conjunctive -- the user must have **all** listed scopes. Scopes are read from `ctx.user.scopes`, which is typically populated by a global guard (e.g., `JwtAuthGuard`).

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
  canActivate(context: McpGuardContext): Promise<boolean>;
}

export interface McpGuardContext {
  sessionId: string;
  user?: { id: string; scopes?: string[]; roles?: string[]; [key: string]: unknown };
  metadata: Record<string, unknown>;
  request?: unknown;
  toolName?: string;
  resourceUri?: string;
  promptName?: string;
}
```

Guards listed in `@Guards([...])` are instantiated directly (`new GuardClass()`). If a guard returns `false`, an `AuthorizationError` is thrown.

## Global Guards

Guards can also be applied globally to all requests via `McpModule.forRoot`:

```typescript
McpModule.forRoot({
  name: 'my-server',
  version: '1.0.0',
  transport: McpTransportType.STREAMABLE_HTTP,
  guards: [JwtAuthGuard],
});
```

Global guards are resolved from the DI container first (via `ModuleRef.get`), falling back to direct instantiation. They run before per-handler auth checks and can populate `ctx.user` for downstream scopes/roles checks.

## Authorization Order

The execution pipeline applies auth in this order:

1. **Global guards** -- Populate `ctx.user` (e.g., JWT validation)
2. **`@Public` check** -- If present, skip remaining auth
3. **`@Scopes` check** -- Verify required scopes
4. **`@Roles` check** -- Verify required roles
5. **`@Guards` check** -- Run per-handler custom guards

## See Also

- [Auth](./auth.md) -- `McpAuthModule` for OAuth/JWT setup
- [Decorators](./decorators.md) -- Core MCP decorators
- [Execution Pipeline](./execution-pipeline.md) -- Full request lifecycle
