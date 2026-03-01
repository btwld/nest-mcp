import { Body, Controller, Get, Post, Query, Req, Res, type Type, UseGuards } from '@nestjs/common';
import { AuthRateLimitGuard } from '../guards/auth-rate-limit.guard';
import type { AuthorizeQueryDto } from '../interfaces/oauth-types.interface';
import { OAuthFlowService } from '../services/oauth-flow.service';

export function createOAuthController(basePath: string): Type<unknown> {
  @Controller(basePath)
  @UseGuards(AuthRateLimitGuard)
  class OAuthController {
    constructor(private readonly flowService: OAuthFlowService) {}

    @Get('authorize')
    async authorize(
      @Query() query: AuthorizeQueryDto,
      @Req() req: unknown,
      @Res({ passthrough: false }) res: { redirect: (status: number, url: string) => void },
    ): Promise<void> {
      const result = await this.flowService.authorize(query, req);
      const params =
        result.type === 'granted'
          ? new URLSearchParams({ code: result.code, state: result.state })
          : new URLSearchParams({
              error: result.error,
              error_description: result.errorDescription,
              state: result.state,
            });
      res.redirect(302, `${result.redirectUri}?${params}`);
    }

    @Post('token')
    async token(@Body() body: Record<string, unknown>) {
      return this.flowService.handleGrant(body);
    }

    @Post('revoke')
    async revoke(@Body() body: Record<string, unknown>) {
      return this.flowService.revokeToken(body);
    }

    @Post('introspect')
    async introspect(@Body() body: Record<string, unknown>) {
      return this.flowService.introspectToken(body);
    }

    @Post('register')
    async register(@Body() body: Record<string, unknown>) {
      return this.flowService.registerClient(body);
    }
  }

  return OAuthController;
}
