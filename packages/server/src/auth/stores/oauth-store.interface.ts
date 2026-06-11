import type { AuthorizationCode, OAuthClient } from '../interfaces/oauth-types.interface';

/** Record passed to `IOAuthStore.recordIssuedToken` whenever a token is minted. */
export interface IssuedTokenRecord {
  /** JWT ID of the minted token. */
  jti: string;
  type: 'access' | 'refresh';
  clientId: string;
  userId?: string;
  scope?: string;
  /** Expiry as unix epoch milliseconds. */
  expiresAt: number;
}

export interface IOAuthStore {
  storeClient(client: OAuthClient): Promise<OAuthClient>;
  getClient(clientId: string): Promise<OAuthClient | undefined>;
  storeAuthCode(code: AuthorizationCode): Promise<void>;
  getAuthCode(code: string): Promise<AuthorizationCode | undefined>;
  removeAuthCode(code: string): Promise<void>;
  revokeToken(jti: string): Promise<void>;
  isTokenRevoked(jti: string): Promise<boolean>;
  /**
   * Optional hook invoked whenever an access or refresh token is minted
   * (initial authorization-code grant and refresh grant). Lets host apps
   * track issued tokens — e.g. to revoke whole refresh chains.
   */
  recordIssuedToken?(rec: IssuedTokenRecord): void | Promise<void>;
}
