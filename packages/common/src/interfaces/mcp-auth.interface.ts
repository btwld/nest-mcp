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
  /**
   * Raw arguments the caller passed for this capability invocation. Present
   * for tools (`tools/call`) and prompts (`prompts/get`); undefined for
   * resource reads. These are pre-Zod (validation runs after auth) so guards
   * inspecting fields should treat the values as `unknown`.
   */
  arguments?: Record<string, unknown>;
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
