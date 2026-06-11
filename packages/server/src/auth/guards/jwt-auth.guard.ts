import type { McpGuard, McpGuardContext } from '@nest-mcp/common';
import { Injectable } from '@nestjs/common';
import { JwtTokenService } from '../services/jwt-token.service';

@Injectable()
export class JwtAuthGuard implements McpGuard {
  constructor(private readonly jwtService: JwtTokenService) {}

  async canActivate(context: McpGuardContext): Promise<boolean> {
    // Fast path: the HTTP edge already verified the bearer token and the SDK
    // surfaced it per-request as authInfo — trust it instead of re-parsing.
    if (context.authInfo) {
      context.user = {
        id: (context.authInfo.extra?.sub as string) ?? context.authInfo.clientId,
        scopes: context.authInfo.scopes,
      };
      return true;
    }

    const request = context.request as { headers?: { authorization?: string } } | undefined;
    if (!request?.headers?.authorization) return false;

    const [type, token] = request.headers.authorization.split(' ');
    if (type !== 'Bearer' || !token) return false;

    try {
      const payload = this.jwtService.validateToken(token);
      context.user = {
        id: payload.sub,
        scopes: payload.scope?.split(' ').filter(Boolean),
        ...(context.user ?? {}),
      };
      return true;
    } catch {
      return false;
    }
  }
}
