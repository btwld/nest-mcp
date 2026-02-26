export type McpGuardClass = abstract new (...args: unknown[]) => McpGuard;

export interface McpAuthConfig {
  guards?: McpGuardClass[];
  allowUnauthenticatedAccess?: boolean;
}

export interface AuthorizableItem {
  name: string;
  isPublic?: boolean;
  requiredScopes?: string[];
  requiredRoles?: string[];
  guards?: McpGuardClass[];
}

export interface McpGuard {
  canActivate(context: McpGuardContext): boolean | Promise<boolean>;
}

export interface McpGuardContext {
  sessionId: string;
  toolName?: string;
  resourceUri?: string;
  promptName?: string;
  user?: {
    id: string;
    roles?: string[];
    scopes?: string[];
    [key: string]: unknown;
  };
  request?: unknown;
  metadata: Record<string, unknown>;
}

export interface AuthenticatedUser {
  id: string;
  scopes?: string[];
  roles?: string[];
  email?: string;
  username?: string;
  [key: string]: unknown;
}
