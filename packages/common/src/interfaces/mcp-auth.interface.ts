export interface McpAuthConfig {
  guards?: Array<abstract new (...args: unknown[]) => unknown>;
  allowUnauthenticatedAccess?: boolean;
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
