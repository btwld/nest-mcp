import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { AuthorizationCode, OAuthClient } from '../interfaces/oauth-types.interface';
import type { IOAuthStore } from './oauth-store.interface';

const MAX_CLIENTS = 10_000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const REVOKED_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

@Injectable()
export class MemoryOAuthStore implements IOAuthStore, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MemoryOAuthStore.name);
  private readonly clients = new Map<string, OAuthClient>();
  private readonly authCodes = new Map<string, AuthorizationCode>();
  private readonly revokedTokens = new Map<string, number>();
  private cleanupTimer?: ReturnType<typeof setInterval>;

  onModuleInit(): void {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
  }

  async storeClient(client: OAuthClient): Promise<OAuthClient> {
    if (this.clients.size >= MAX_CLIENTS && !this.clients.has(client.client_id)) {
      throw new Error('Maximum number of registered clients reached');
    }
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
    this.revokedTokens.set(jti, Date.now());
  }

  async isTokenRevoked(jti: string): Promise<boolean> {
    return this.revokedTokens.has(jti);
  }

  private cleanup(): void {
    const now = Date.now();
    let removedCodes = 0;
    let removedTokens = 0;

    // Remove expired auth codes
    for (const [code, authCode] of this.authCodes) {
      if (now > authCode.expires_at) {
        this.authCodes.delete(code);
        removedCodes++;
      }
    }

    // Remove revoked tokens older than TTL
    for (const [jti, revokedAt] of this.revokedTokens) {
      if (now - revokedAt > REVOKED_TOKEN_TTL_MS) {
        this.revokedTokens.delete(jti);
        removedTokens++;
      }
    }

    if (removedCodes > 0 || removedTokens > 0) {
      this.logger.debug(
        `Cleanup: removed ${removedCodes} expired auth codes, ${removedTokens} stale revoked tokens`,
      );
    }
  }
}
