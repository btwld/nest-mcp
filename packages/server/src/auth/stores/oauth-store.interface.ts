import {
  OAuthClient,
  AuthorizationCode,
} from '../interfaces/oauth-types.interface';

export interface IOAuthStore {
  storeClient(client: OAuthClient): Promise<OAuthClient>;
  getClient(clientId: string): Promise<OAuthClient | undefined>;
  storeAuthCode(code: AuthorizationCode): Promise<void>;
  getAuthCode(code: string): Promise<AuthorizationCode | undefined>;
  removeAuthCode(code: string): Promise<void>;
  revokeToken(jti: string): Promise<void>;
  isTokenRevoked(jti: string): Promise<boolean>;
}
