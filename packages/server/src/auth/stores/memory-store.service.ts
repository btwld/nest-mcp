import { Injectable } from '@nestjs/common';
import type { AuthorizationCode, OAuthClient } from '../interfaces/oauth-types.interface';
import type { IOAuthStore } from './oauth-store.interface';

@Injectable()
export class MemoryOAuthStore implements IOAuthStore {
  private readonly clients = new Map<string, OAuthClient>();
  private readonly authCodes = new Map<string, AuthorizationCode>();
  private readonly revokedTokens = new Set<string>();

  async storeClient(client: OAuthClient): Promise<OAuthClient> {
    this.clients.set(client.client_id, client);
    return client;
  }

  async getClient(clientId: string): Promise<OAuthClient | undefined> {
    return this.clients.get(clientId);
  }

  async storeAuthCode(code: AuthorizationCode): Promise<void> {
    this.authCodes.set(code.code, code);
  }

  async getAuthCode(code: string): Promise<AuthorizationCode | undefined> {
    const authCode = this.authCodes.get(code);
    if (!authCode) return undefined;

    if (Date.now() > authCode.expires_at) {
      this.authCodes.delete(code);
      return undefined;
    }

    return authCode;
  }

  async removeAuthCode(code: string): Promise<void> {
    this.authCodes.delete(code);
  }

  async revokeToken(jti: string): Promise<void> {
    this.revokedTokens.add(jti);
  }

  async isTokenRevoked(jti: string): Promise<boolean> {
    return this.revokedTokens.has(jti);
  }
}
