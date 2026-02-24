import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { McpAuthModuleOptions } from '../interfaces/auth-module-options.interface';
import type { OAuthClient } from '../interfaces/oauth-types.interface';
import type { IOAuthStore } from '../stores/oauth-store.interface';
import { MCP_AUTH_OPTIONS } from './jwt-token.service';

export const MCP_OAUTH_STORE = Symbol('MCP_OAUTH_STORE');

@Injectable()
export class OAuthClientService {
  constructor(
    @Inject(MCP_AUTH_OPTIONS)
    private readonly options: McpAuthModuleOptions,
    @Inject(MCP_OAUTH_STORE) private readonly store: IOAuthStore,
  ) {}

  async registerClient(
    clientName: string,
    redirectUris: string[],
    grantTypes?: string[],
  ): Promise<OAuthClient> {
    const clientId = createHash('sha256').update(clientName).digest('hex').substring(0, 32);
    const clientSecret = randomBytes(32).toString('hex');

    const client: OAuthClient = {
      client_id: clientId,
      client_secret: clientSecret,
      client_name: clientName,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'client_secret_post',
      grant_types: grantTypes ?? ['authorization_code', 'refresh_token'],
      created_at: Math.floor(Date.now() / 1000),
    };

    return this.store.storeClient(client);
  }

  async getClient(clientId: string): Promise<OAuthClient | undefined> {
    return this.store.getClient(clientId);
  }

  async validateRedirectUri(clientId: string, redirectUri: string): Promise<boolean> {
    const client = await this.store.getClient(clientId);
    if (!client) return false;
    return client.redirect_uris.includes(redirectUri);
  }
}
