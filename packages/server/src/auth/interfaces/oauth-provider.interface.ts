export interface OAuthProviderAdapter {
  /** Human-readable provider name (e.g. "Auth0", "Clerk") */
  readonly name: string;

  /**
   * Validate an incoming request and extract the authenticated user.
   * Called during the OAuth authorization step.
   * Return null to reject authentication.
   */
  validateUser(req: unknown): Promise<OAuthProviderUser | null>;

  /**
   * Exchange a provider-issued token/code for user info.
   * Called when the provider redirects back with a code.
   * Optional — only needed for providers that use external token exchange.
   */
  exchangeToken?(code: string, redirectUri: string): Promise<OAuthProviderUser | null>;

  /**
   * Return the provider's authorization URL for redirect-based flows.
   * Optional — only needed for providers that handle their own login UI.
   */
  getAuthorizationUrl?(state: string, redirectUri: string): string;
}

export interface OAuthProviderUser {
  id: string;
  email?: string;
  name?: string;
  roles?: string[];
  scopes?: string[];
  [key: string]: unknown;
}
