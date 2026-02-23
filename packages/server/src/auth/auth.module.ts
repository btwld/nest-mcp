import { Module, type DynamicModule } from '@nestjs/common';
import type { McpAuthModuleOptions } from './interfaces/auth-module-options.interface';
import { JwtTokenService, MCP_AUTH_OPTIONS } from './services/jwt-token.service';
import { OAuthClientService, MCP_OAUTH_STORE } from './services/client.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { MemoryOAuthStore } from './stores/memory-store.service';
import { createOAuthController } from './oauth/oauth.controller';
import { createWellKnownController } from './oauth/well-known.controller';

@Module({})
export class McpAuthModule {
  static forRoot(options: McpAuthModuleOptions): DynamicModule {
    if (!options.jwtSecret || options.jwtSecret.length < 32) {
      throw new Error(
        'McpAuthModule: jwtSecret must be at least 32 characters',
      );
    }

    const oauthBasePath = options.serverUrl
      ? new URL(options.serverUrl).pathname
      : '';
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
