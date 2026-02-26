import { randomUUID } from 'node:crypto';
import { AuthorizationError, parseDurationSeconds } from '@btwld/mcp-common';
import { Inject, Injectable } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import type { McpAuthModuleOptions } from '../interfaces/auth-module-options.interface';
import type { TokenPayload, TokenResponse } from '../interfaces/oauth-types.interface';

export const MCP_AUTH_OPTIONS = Symbol('MCP_AUTH_OPTIONS');

@Injectable()
export class JwtTokenService {
  constructor(
    @Inject(MCP_AUTH_OPTIONS)
    private readonly options: McpAuthModuleOptions,
  ) {}

  generateTokenPair(
    userId: string,
    clientId: string,
    scope?: string,
    resource?: string,
  ): TokenResponse {
    const iss = this.options.issuer ?? this.options.serverUrl ?? 'http://localhost:3000';
    const aud = this.options.audience ?? 'mcp-client';

    const accessExpiresIn = parseDurationSeconds(this.options.accessTokenExpiresIn ?? '1d', 86400);
    const refreshExpiresIn = parseDurationSeconds(this.options.refreshTokenExpiresIn ?? '30d', 86400);

    const accessToken = jwt.sign(
      {
        sub: userId,
        azp: clientId,
        type: 'access',
        scope,
        iss,
        aud,
      } as TokenPayload,
      this.options.jwtSecret,
      {
        expiresIn: accessExpiresIn,
        algorithm: 'HS256',
      },
    );

    const refreshToken = jwt.sign(
      {
        sub: userId,
        client_id: clientId,
        type: 'refresh',
        jti: randomUUID(),
        iss,
      } as TokenPayload,
      this.options.jwtSecret,
      {
        expiresIn: refreshExpiresIn,
        algorithm: 'HS256',
      },
    );

    const expiresIn = accessExpiresIn;

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: expiresIn,
    };
  }

  validateToken(token: string): TokenPayload {
    try {
      return jwt.verify(token, this.options.jwtSecret, {
        algorithms: ['HS256'],
      }) as TokenPayload;
    } catch (error) {
      throw new AuthorizationError(`Invalid token: ${(error as Error).message}`);
    }
  }

}
