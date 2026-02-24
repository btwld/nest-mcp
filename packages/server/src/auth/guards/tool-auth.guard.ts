import { AuthorizationError } from '@btwld/mcp-common';
import type { McpGuardContext } from '@btwld/mcp-common';
import { Injectable, Logger } from '@nestjs/common';
import type { RegisteredTool } from '../../discovery/registry.service';

@Injectable()
export class ToolAuthGuardService {
  private readonly logger = new Logger(ToolAuthGuardService.name);

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: sequential auth checks are inherently branchy
  async checkAuthorization(tool: RegisteredTool, context: McpGuardContext): Promise<void> {
    // Public tools skip auth
    if (tool.isPublic) return;

    // Check scopes
    if (tool.requiredScopes?.length) {
      const userScopes = context.user?.scopes ?? [];
      const hasScopes = tool.requiredScopes.every((scope) => userScopes.includes(scope));
      if (!hasScopes) {
        throw new AuthorizationError(
          `Tool '${tool.name}' requires scopes: ${tool.requiredScopes.join(', ')}`,
        );
      }
    }

    // Check roles
    if (tool.requiredRoles?.length) {
      const userRoles = context.user?.roles ?? [];
      const hasRoles = tool.requiredRoles.some((role) => userRoles.includes(role));
      if (!hasRoles) {
        throw new AuthorizationError(
          `Tool '${tool.name}' requires one of roles: ${tool.requiredRoles.join(', ')}`,
        );
      }
    }

    // Execute custom guards
    if (tool.guards?.length) {
      for (const GuardClass of tool.guards) {
        const guard = new (
          GuardClass as unknown as new () => {
            canActivate?: (ctx: McpGuardContext) => boolean | Promise<boolean>;
          }
        )();
        if (typeof guard.canActivate === 'function') {
          const allowed = await guard.canActivate(context);
          if (!allowed) {
            throw new AuthorizationError(
              `Tool '${tool.name}' authorization denied by guard: ${GuardClass.name || 'anonymous'}`,
            );
          }
        }
      }
    }
  }
}
