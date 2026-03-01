import { AuthorizationError } from '@nest-mcp/common';
import type { AuthorizableItem, McpGuard, McpGuardClass, McpGuardContext } from '@nest-mcp/common';
import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class ToolAuthGuardService {
  private readonly logger = new Logger(ToolAuthGuardService.name);

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: sequential auth checks are inherently branchy
  async checkAuthorization(item: AuthorizableItem, context: McpGuardContext): Promise<void> {
    // Public items skip auth
    if (item.isPublic) return;

    // Check scopes
    if (item.requiredScopes?.length) {
      const userScopes = context.user?.scopes ?? [];
      const hasScopes = item.requiredScopes.every((scope) => userScopes.includes(scope));
      if (!hasScopes) {
        throw new AuthorizationError(
          `Tool '${item.name}' requires scopes: ${item.requiredScopes.join(', ')}`,
        );
      }
    }

    // Check roles
    if (item.requiredRoles?.length) {
      const userRoles = context.user?.roles ?? [];
      const hasRoles = item.requiredRoles.some((role) => userRoles.includes(role));
      if (!hasRoles) {
        throw new AuthorizationError(
          `Tool '${item.name}' requires one of roles: ${item.requiredRoles.join(', ')}`,
        );
      }
    }

    // Execute custom guards
    if (item.guards?.length) {
      for (const GuardClass of item.guards) {
        const guard = new (GuardClass as unknown as new () => McpGuard)();
        if (typeof guard.canActivate === 'function') {
          const allowed = await guard.canActivate(context);
          if (!allowed) {
            throw new AuthorizationError(
              `Tool '${item.name}' authorization denied by guard: ${GuardClass.name || 'anonymous'}`,
            );
          }
        }
      }
    }
  }
}
