import type { McpAuthInfo } from '@nest-mcp/common';

/**
 * Verifies a raw bearer token presented at the HTTP edge.
 *
 * Contract: return the verified identity, or `null` when the token is invalid
 * (the guard responds with a generic `invalid_token` challenge). A verifier
 * MAY instead throw an `OAuthError` subclass from
 * `@modelcontextprotocol/sdk/server/auth/errors.js` to control the exact
 * `error`/`error_description` sent to the client.
 *
 * Structurally compatible with the SDK's `OAuthTokenVerifier` — any verifier
 * written for the official SDK can be adapted by mapping
 * `verifyAccessToken(token)` to `verify(token)`.
 */
export interface BearerTokenVerifier {
  /** Returns the verified identity, or `null` when the token is invalid. */
  verify(token: string): Promise<McpAuthInfo | null>;
}
