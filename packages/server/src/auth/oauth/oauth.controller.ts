import {
  Controller,
  Post,
  Body,
  Inject,
  HttpException,
  HttpStatus,
  type Type,
} from '@nestjs/common';
import { createHash } from 'crypto';
import type { McpAuthModuleOptions } from '../interfaces/auth-module-options.interface';
import type {
  TokenResponse,
  OAuthClient,
} from '../interfaces/oauth-types.interface';
import type { IOAuthStore } from '../stores/oauth-store.interface';
import { JwtTokenService, MCP_AUTH_OPTIONS } from '../services/jwt-token.service';
import { OAuthClientService, MCP_OAUTH_STORE } from '../services/client.service';

export function createOAuthController(basePath: string): Type<any> {
  @Controller(basePath)
  class OAuthController {
    constructor(
      @Inject(MCP_AUTH_OPTIONS)
      private readonly options: McpAuthModuleOptions,
      private readonly jwtService: JwtTokenService,
      private readonly clientService: OAuthClientService,
      @Inject(MCP_OAUTH_STORE) private readonly store: IOAuthStore,
    ) {}

    @Post('token')
    async token(@Body() body: any): Promise<TokenResponse> {
      const { grant_type } = body;

      if (grant_type === 'authorization_code') {
        return this.handleAuthorizationCode(body);
      }

      if (grant_type === 'refresh_token') {
        return this.handleRefreshToken(body);
      }

      throw new HttpException(
        'Unsupported grant_type',
        HttpStatus.BAD_REQUEST,
      );
    }

    @Post('revoke')
    async revoke(@Body() body: any): Promise<{ success: boolean }> {
      const { token } = body;
      if (!token) {
        throw new HttpException(
          'Token is required',
          HttpStatus.BAD_REQUEST,
        );
      }

      try {
        const payload = this.jwtService.validateToken(token);
        if (payload.jti) {
          await this.store.revokeToken(payload.jti);
        }
      } catch {
        // RFC 7009: invalid tokens are treated as already revoked
      }

      return { success: true };
    }

    @Post('register')
    async register(@Body() body: any): Promise<OAuthClient> {
      if (this.options.enableDynamicRegistration === false) {
        throw new HttpException(
          'Dynamic client registration is disabled',
          HttpStatus.FORBIDDEN,
        );
      }

      const { client_name, redirect_uris, grant_types } = body;

      if (!client_name || !redirect_uris?.length) {
        throw new HttpException(
          'client_name and redirect_uris are required',
          HttpStatus.BAD_REQUEST,
        );
      }

      return this.clientService.registerClient(
        client_name,
        redirect_uris,
        grant_types,
      );
    }

    private async handleAuthorizationCode(body: any): Promise<TokenResponse> {
      const { code, code_verifier, redirect_uri } = body;

      if (!code || !code_verifier) {
        throw new HttpException(
          'code and code_verifier are required',
          HttpStatus.BAD_REQUEST,
        );
      }

      const authCode = await this.store.getAuthCode(code);
      if (!authCode) {
        throw new HttpException(
          'Invalid or expired authorization code',
          HttpStatus.BAD_REQUEST,
        );
      }

      // Validate redirect_uri matches
      if (redirect_uri && redirect_uri !== authCode.redirect_uri) {
        await this.store.removeAuthCode(code);
        throw new HttpException(
          'redirect_uri mismatch',
          HttpStatus.BAD_REQUEST,
        );
      }

      // PKCE validation
      if (authCode.code_challenge_method === 'S256') {
        const expected = createHash('sha256')
          .update(code_verifier)
          .digest('base64url');
        if (expected !== authCode.code_challenge) {
          await this.store.removeAuthCode(code);
          throw new HttpException(
            'Invalid code_verifier',
            HttpStatus.BAD_REQUEST,
          );
        }
      } else {
        // plain
        if (code_verifier !== authCode.code_challenge) {
          await this.store.removeAuthCode(code);
          throw new HttpException(
            'Invalid code_verifier',
            HttpStatus.BAD_REQUEST,
          );
        }
      }

      // Remove used code
      await this.store.removeAuthCode(code);

      return this.jwtService.generateTokenPair(
        authCode.user_id,
        authCode.client_id,
        authCode.scope,
        authCode.resource,
      );
    }

    private async handleRefreshToken(body: any): Promise<TokenResponse> {
      const { refresh_token } = body;

      if (!refresh_token) {
        throw new HttpException(
          'refresh_token is required',
          HttpStatus.BAD_REQUEST,
        );
      }

      let payload;
      try {
        payload = this.jwtService.validateToken(refresh_token);
      } catch {
        throw new HttpException(
          'Invalid refresh token',
          HttpStatus.UNAUTHORIZED,
        );
      }

      if (payload.type !== 'refresh') {
        throw new HttpException(
          'Token is not a refresh token',
          HttpStatus.BAD_REQUEST,
        );
      }

      if (payload.jti && (await this.store.isTokenRevoked(payload.jti))) {
        throw new HttpException(
          'Refresh token has been revoked',
          HttpStatus.UNAUTHORIZED,
        );
      }

      // Revoke the old refresh token
      if (payload.jti) {
        await this.store.revokeToken(payload.jti);
      }

      return this.jwtService.generateTokenPair(
        payload.sub,
        payload.client_id ?? payload.azp ?? '',
        payload.scope,
      );
    }
  }

  return OAuthController;
}
