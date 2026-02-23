import { Injectable } from '@nestjs/common';
import type { McpGuard, McpGuardContext } from '@btwld/mcp-common';
import { JwtTokenService } from '../services/jwt-token.service';

@Injectable()
export class JwtAuthGuard implements McpGuard {
  constructor(private readonly jwtService: JwtTokenService) {}

  async canActivate(context: McpGuardContext): Promise<boolean> {
    const request = context.request as any;
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
