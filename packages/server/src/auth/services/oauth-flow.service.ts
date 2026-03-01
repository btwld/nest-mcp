import { createHash, randomBytes } from 'node:crypto';
import { HttpException, HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import type { McpAuthModuleOptions } from '../interfaces/auth-module-options.interface';
import type {
  AuthorizeQueryDto,
  OAuthClient,
  TokenIntrospectionResponse,
  TokenPayload,
  TokenResponse,
} from '../interfaces/oauth-types.interface';
import type { IOAuthStore } from '../stores/oauth-store.interface';
import { AuthAuditService } from './auth-audit.service';
import { MCP_OAUTH_STORE, OAuthClientService } from './client.service';
import { JwtTokenService, MCP_AUTH_OPTIONS } from './jwt-token.service';

export type AuthFlowOutcome =
  | { type: 'granted'; code: string; redirectUri: string; state: string }
  | { type: 'denied'; error: string; errorDescription: string; redirectUri: string; state: string };

@Injectable()
export class OAuthFlowService {
  private readonly grantHandlers = new Map<
    string,
    (body: Record<string, unknown>) => Promise<TokenResponse>
  >([
    ['authorization_code', (body) => this.exchangeCode(body)],
    ['refresh_token', (body) => this.refreshToken(body)],
  ]);

  constructor(
    @Inject(MCP_AUTH_OPTIONS) private readonly options: McpAuthModuleOptions,
    private readonly jwtService: JwtTokenService,
    private readonly clientService: OAuthClientService,
    @Inject(MCP_OAUTH_STORE) private readonly store: IOAuthStore,
    @Optional() private readonly auditService?: AuthAuditService,
  ) {}

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: OAuth authorize flow requires sequential validation
  async authorize(query: AuthorizeQueryDto, req: unknown): Promise<AuthFlowOutcome> {
    const {
      response_type,
      client_id,
      redirect_uri,
      code_challenge,
      code_challenge_method,
      scope,
      state,
      resource,
    } = query;

    // Validate required params before redirect_uri is trusted
    if (response_type !== 'code') {
      throw new HttpException(
        { error: 'unsupported_response_type', error_description: 'response_type must be "code"' },
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!client_id) {
      throw new HttpException(
        { error: 'invalid_request', error_description: 'client_id is required' },
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!redirect_uri) {
      throw new HttpException(
        { error: 'invalid_request', error_description: 'redirect_uri is required' },
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!code_challenge) {
      throw new HttpException(
        {
          error: 'invalid_request',
          error_description: 'code_challenge is required (PKCE is mandatory)',
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!state) {
      throw new HttpException(
        { error: 'invalid_request', error_description: 'state is required' },
        HttpStatus.BAD_REQUEST,
      );
    }

    // Validate client exists
    const client = await this.clientService.getClient(client_id);
    if (!client) {
      throw new HttpException(
        { error: 'invalid_client', error_description: 'Unknown client_id' },
        HttpStatus.BAD_REQUEST,
      );
    }

    // Validate redirect_uri matches registered URIs — never redirect to unvalidated URI
    if (!client.redirect_uris.includes(redirect_uri)) {
      throw new HttpException(
        {
          error: 'invalid_request',
          error_description: 'redirect_uri does not match any registered URI',
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    // redirect_uri is now validated — errors after this point redirect back
    const method = code_challenge_method === 'plain' ? 'plain' : 'S256';

    // Authenticate user via pluggable callback
    if (!this.options.validateUser) {
      return {
        type: 'denied',
        error: 'access_denied',
        errorDescription: 'No user authentication configured',
        redirectUri: redirect_uri,
        state,
      };
    }

    const user = await this.options.validateUser(req);
    if (!user) {
      this.auditService?.logAuthorizationDenied(client_id, 'User authentication failed');
      return {
        type: 'denied',
        error: 'access_denied',
        errorDescription: 'User authentication failed',
        redirectUri: redirect_uri,
        state,
      };
    }

    // Generate and store authorization code
    const code = randomBytes(32).toString('hex');
    const expiresIn = this.options.authCodeExpiresIn ?? 300;

    await this.store.storeAuthCode({
      code,
      client_id,
      user_id: user.id,
      redirect_uri,
      code_challenge,
      code_challenge_method: method,
      scope: scope ?? '',
      resource,
      expires_at: Date.now() + expiresIn * 1000,
    });

    this.auditService?.logAuthorizationGranted(client_id, user.id);

    return { type: 'granted', code, redirectUri: redirect_uri, state };
  }

  async handleGrant(body: Record<string, unknown>): Promise<TokenResponse> {
    const { grant_type } = body as { grant_type?: string };
    const handler = this.grantHandlers.get(grant_type ?? '');
    if (!handler) {
      throw new HttpException('Unsupported grant_type', HttpStatus.BAD_REQUEST);
    }
    return handler(body);
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: PKCE code exchange has inherent branching for validation
  async exchangeCode(body: Record<string, unknown>): Promise<TokenResponse> {
    const { code, code_verifier, redirect_uri } = body as {
      code?: string;
      code_verifier?: string;
      redirect_uri?: string;
    };

    if (!code || !code_verifier) {
      throw new HttpException('code and code_verifier are required', HttpStatus.BAD_REQUEST);
    }

    const authCode = await this.store.getAuthCode(code);
    if (!authCode) {
      throw new HttpException('Invalid or expired authorization code', HttpStatus.BAD_REQUEST);
    }

    // Validate redirect_uri matches
    if (redirect_uri && redirect_uri !== authCode.redirect_uri) {
      await this.store.removeAuthCode(code);
      throw new HttpException('redirect_uri mismatch', HttpStatus.BAD_REQUEST);
    }

    // PKCE validation
    if (authCode.code_challenge_method === 'S256') {
      const expected = createHash('sha256').update(code_verifier).digest('base64url');
      if (expected !== authCode.code_challenge) {
        await this.store.removeAuthCode(code);
        throw new HttpException('Invalid code_verifier', HttpStatus.BAD_REQUEST);
      }
    } else {
      // plain
      if (code_verifier !== authCode.code_challenge) {
        await this.store.removeAuthCode(code);
        throw new HttpException('Invalid code_verifier', HttpStatus.BAD_REQUEST);
      }
    }

    await this.store.removeAuthCode(code);

    const tokenResponse = this.jwtService.generateTokenPair(
      authCode.user_id,
      authCode.client_id,
      authCode.scope,
      authCode.resource,
    );
    this.auditService?.logTokenIssued(authCode.client_id, authCode.user_id);
    return tokenResponse;
  }

  async refreshToken(body: Record<string, unknown>): Promise<TokenResponse> {
    const { refresh_token } = body as { refresh_token?: string };

    if (!refresh_token) {
      throw new HttpException('refresh_token is required', HttpStatus.BAD_REQUEST);
    }

    let payload: TokenPayload;
    try {
      payload = this.jwtService.validateToken(refresh_token);
    } catch {
      throw new HttpException('Invalid refresh token', HttpStatus.UNAUTHORIZED);
    }

    if (payload.type !== 'refresh') {
      throw new HttpException('Token is not a refresh token', HttpStatus.BAD_REQUEST);
    }

    if (payload.jti && (await this.store.isTokenRevoked(payload.jti))) {
      throw new HttpException('Refresh token has been revoked', HttpStatus.UNAUTHORIZED);
    }

    // Revoke the old refresh token
    if (payload.jti) {
      await this.store.revokeToken(payload.jti);
    }

    const clientId = payload.client_id ?? payload.azp ?? '';
    const refreshResponse = this.jwtService.generateTokenPair(payload.sub, clientId, payload.scope);
    this.auditService?.logTokenIssued(clientId, payload.sub);
    return refreshResponse;
  }

  async revokeToken(body: Record<string, unknown>): Promise<{ success: boolean }> {
    const { token } = body as { token?: string };
    if (!token) {
      throw new HttpException('Token is required', HttpStatus.BAD_REQUEST);
    }

    try {
      const payload = this.jwtService.validateToken(token);
      if (payload.jti) {
        await this.store.revokeToken(payload.jti);
        this.auditService?.logTokenRevoked(payload.jti);
      }
    } catch {
      // RFC 7009: invalid tokens are treated as already revoked
    }

    return { success: true };
  }

  async introspectToken(body: Record<string, unknown>): Promise<TokenIntrospectionResponse> {
    const { token } = body as { token?: string };
    if (!token) {
      throw new HttpException('token parameter is required', HttpStatus.BAD_REQUEST);
    }

    try {
      const payload = this.jwtService.validateToken(token);

      if (payload.jti && (await this.store.isTokenRevoked(payload.jti))) {
        return { active: false };
      }

      return {
        active: true,
        sub: payload.sub,
        client_id: payload.client_id ?? payload.azp,
        scope: payload.scope,
        exp: payload.exp,
        iat: payload.iat,
        token_type: payload.type === 'access' ? 'Bearer' : undefined,
      };
    } catch {
      return { active: false };
    }
  }

  async registerClient(body: Record<string, unknown>): Promise<OAuthClient> {
    if (this.options.enableDynamicRegistration === false) {
      throw new HttpException('Dynamic client registration is disabled', HttpStatus.FORBIDDEN);
    }

    const { client_name, redirect_uris, grant_types } = body as {
      client_name?: string;
      redirect_uris?: string[];
      grant_types?: string[];
    };

    if (!client_name || !redirect_uris?.length) {
      throw new HttpException('client_name and redirect_uris are required', HttpStatus.BAD_REQUEST);
    }

    const registeredClient = await this.clientService.registerClient(
      client_name,
      redirect_uris,
      grant_types,
    );
    this.auditService?.logClientRegistered(registeredClient.client_id, client_name);
    return registeredClient;
  }
}
