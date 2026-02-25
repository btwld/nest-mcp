import { createHash, randomBytes } from 'node:crypto';
// biome-ignore lint/style/useImportType: needed as value for emitDecoratorMetadata
import { JwtTokenService, MCP_OAUTH_STORE, OAuthClientService } from '@btwld/mcp-server';
import type { IOAuthStore } from '@btwld/mcp-server';
import { Controller, Get, Inject, Query } from '@nestjs/common';

@Controller('auth/demo')
export class AuthDemoController {
  constructor(
    private readonly clientService: OAuthClientService,
    private readonly jwtService: JwtTokenService,
    @Inject(MCP_OAUTH_STORE) private readonly store: IOAuthStore,
  ) {}

  @Get('flow')
  async demonstrateOAuthFlow() {
    // Step 1: Register client
    const client = await this.clientService.registerClient(
      'demo-client',
      ['http://localhost:8080/callback'],
      ['authorization_code', 'refresh_token'],
    );

    // Step 2: Generate PKCE pair
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

    // Step 3: Simulate authorization (store auth code directly, bypassing redirect flow)
    const authCode = randomBytes(16).toString('hex');
    await this.store.storeAuthCode({
      code: authCode,
      client_id: client.client_id,
      user_id: 'demo-user',
      redirect_uri: 'http://localhost:8080/callback',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      scope: 'tools:read',
      expires_at: Math.floor(Date.now() / 1000) + 600,
    });

    // Step 4: Exchange code for tokens
    const tokens = this.jwtService.generateTokenPair('demo-user', client.client_id, 'tools:read');

    return {
      steps: {
        '1_register_client': {
          client_id: client.client_id,
          client_name: client.client_name,
          redirect_uris: client.redirect_uris,
        },
        '2_pkce': {
          code_verifier: codeVerifier,
          code_challenge: codeChallenge,
          code_challenge_method: 'S256',
        },
        '3_authorization': {
          code: authCode,
          redirect_uri: 'http://localhost:8080/callback',
          scope: 'tools:read',
        },
        '4_token_exchange': {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          token_type: tokens.token_type,
          expires_in: tokens.expires_in,
        },
      },
      usage: {
        curl: `curl -H "Authorization: Bearer ${tokens.access_token}" -X POST http://localhost:3000/mcp`,
      },
    };
  }

  @Get('test-token')
  generateTestToken(@Query('scopes') scopes?: string) {
    const scopeStr = scopes ?? 'tools:read';
    const tokens = this.jwtService.generateTokenPair('test-user', 'test-client', scopeStr);

    return {
      access_token: tokens.access_token,
      token_type: tokens.token_type,
      expires_in: tokens.expires_in,
      scopes: scopeStr.split(' '),
      usage: `curl -H "Authorization: Bearer ${tokens.access_token}" ...`,
    };
  }
}
