import { McpError } from '@btwld/mcp-common';
import { type DynamicModule, Module } from '@nestjs/common';
import { AuthRateLimitGuard } from './guards/auth-rate-limit.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import type { McpAuthModuleOptions } from './interfaces/auth-module-options.interface';
import { createOAuthController } from './oauth/oauth.controller';
import { createWellKnownController } from './oauth/well-known.controller';
import { AuthAuditService } from './services/auth-audit.service';
import { MCP_OAUTH_STORE, OAuthClientService } from './services/client.service';
import { JwtTokenService, MCP_AUTH_OPTIONS } from './services/jwt-token.service';
import { MemoryOAuthStore } from './stores/memory-store.service';

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: NestJS requires module classes
export class McpAuthModule {
  static forRoot(options: McpAuthModuleOptions): DynamicModule {
    if (!options.jwtSecret || options.jwtSecret.length < 32) {
      throw new McpError('McpAuthModule: jwtSecret must be at least 32 characters');
    }

    const oauthBasePath = options.serverUrl ? new URL(options.serverUrl).pathname : '';
    const OAuthCtrl = createOAuthController(oauthBasePath);
    const WellKnownCtrl = createWellKnownController(options);

    const store = options.store ?? new MemoryOAuthStore();

    return {
      module: McpAuthModule,
      providers: [
        { provide: MCP_AUTH_OPTIONS, useValue: options },
        { provide: MCP_OAUTH_STORE, useValue: store },
        JwtTokenService,
        OAuthClientService,
        JwtAuthGuard,
        AuthRateLimitGuard,
        AuthAuditService,
      ],
      controllers: [OAuthCtrl, WellKnownCtrl],
      exports: [
        JwtTokenService,
        OAuthClientService,
        JwtAuthGuard,
        MCP_AUTH_OPTIONS,
        MCP_OAUTH_STORE,
      ],
    };
  }
}
