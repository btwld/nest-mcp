import type { McpGuard, McpGuardContext } from '@nest-mcp/common';
import { Injectable } from '@nestjs/common';

/**
 * MCP-layer guard requiring a verified principal: either the edge `authInfo`
 * set by `McpBearerGuard` or a `user` mapped into the guard context. Attach
 * per item via `@Guards(McpAuthenticatedGuard)` or globally via
 * `auth.guards` — useful with `required: false` (optional-auth mode) to keep
 * specific tools members-only.
 */
@Injectable()
export class McpAuthenticatedGuard implements McpGuard {
  canActivate(context: McpGuardContext): boolean {
    return Boolean(context.authInfo ?? context.user);
  }
}
