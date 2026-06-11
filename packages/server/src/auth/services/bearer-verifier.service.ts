import type { McpAuthInfo } from '@nest-mcp/common';
import { Inject, Injectable } from '@nestjs/common';
import type { TokenPayload } from '../interfaces/oauth-types.interface';
import type { IOAuthStore } from '../stores/oauth-store.interface';
import { MCP_OAUTH_STORE } from './client.service';
import { JwtTokenService } from './jwt-token.service';

export const MCP_BEARER_TOKEN_VERIFIER = Symbol('MCP_BEARER_TOKEN_VERIFIER');

/**
 * Verifies a raw bearer token presented at the HTTP edge. Host apps can
 * override the default JWT implementation by re-providing
 * `MCP_BEARER_TOKEN_VERIFIER` (e.g. for opaque-token introspection).
 */
export interface BearerTokenVerifier {
  /** Returns the verified identity, or `null` when the token is invalid. */
  verify(token: string): Promise<McpAuthInfo | null>;
}

@Injectable()
export class JwtBearerTokenVerifier implements BearerTokenVerifier {
  constructor(
    private readonly jwtService: JwtTokenService,
    @Inject(MCP_OAUTH_STORE) private readonly store: IOAuthStore,
  ) {}

  async verify(token: string): Promise<McpAuthInfo | null> {
    let payload: TokenPayload;
    try {
      payload = this.jwtService.validateToken(token);
    } catch {
      return null;
    }

    if (payload.type !== 'access') return null;
    if (payload.jti && (await this.store.isTokenRevoked(payload.jti))) return null;

    return {
      token,
      clientId: payload.azp ?? payload.client_id ?? '',
      scopes: (payload.scope ?? '').split(' ').filter(Boolean),
      expiresAt: payload.exp,
      extra: { sub: payload.sub },
    };
  }
}
