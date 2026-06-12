export type McpGuardClass = abstract new (...args: unknown[]) => McpGuard;

/**
 * Verified bearer-token identity attached to a request. Structural mirror of
 * the MCP SDK `AuthInfo` (`@nest-mcp/common` stays SDK-free); the SDK's
 * concrete type is assignable to this one.
 */
export interface McpAuthInfo {
  /** The raw access token as presented by the client. */
  token: string;
  /** OAuth client the token was issued to. */
  clientId: string;
  /** Scopes granted to the token. */
  scopes: string[];
  /** Expiry as a unix timestamp in seconds, when known. */
  expiresAt?: number;
  /** RFC 8707 resource the token is bound to, when known. */
  resource?: string;
  /** Extra verifier-specific claims (e.g. `sub`). */
  extra?: Record<string, unknown>;
}

export interface McpAuthConfig {
  guards?: McpGuardClass[];
  allowUnauthenticatedAccess?: boolean;
}

/**
 * Per-tool auth requirement advertised to clients in `tools/list` `_meta`
 * (`_meta.securitySchemes`). Not yet part of the MCP spec — mirrors the
 * `securitySchemes` draft shape also emitted by other MCP server libraries
 * so clients can discover auth requirements before calling a tool.
 */
export type McpSecurityScheme = { type: 'noauth' } | { type: 'oauth2'; scopes?: string[] };

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
  /** Verified bearer-token identity, when HTTP edge auth is enabled. */
  authInfo?: McpAuthInfo;
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
