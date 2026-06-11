import { McpError } from '@nest-mcp/common';
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { AuthRateLimitGuard } from './guards/auth-rate-limit.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import type {
  McpAuthModuleAsyncOptions,
  McpAuthModuleOptions,
} from './interfaces/auth-module-options.interface';
import type { OAuthProviderAdapter } from './interfaces/oauth-provider.interface';
import { createOAuthController } from './oauth/oauth.controller';
import { createWellKnownController } from './oauth/well-known.controller';
import { AuthAuditService } from './services/auth-audit.service';
import {
  JwtBearerTokenVerifier,
  MCP_BEARER_TOKEN_VERIFIER,
} from './services/bearer-verifier.service';
import { MCP_OAUTH_STORE, OAuthClientService } from './services/client.service';
import { JwtTokenService, MCP_AUTH_OPTIONS } from './services/jwt-token.service';
import { OAuthFlowService } from './services/oauth-flow.service';
import { MemoryOAuthStore } from './stores/memory-store.service';

function validateAuthOptions(options: McpAuthModuleOptions): McpAuthModuleOptions {
  if (!options.jwtSecret || options.jwtSecret.length < 32) {
    throw new McpError('McpAuthModule: jwtSecret must be at least 32 characters');
  }
  return options;
}

/**
 * `MCP_OAUTH_STORE` factory: an explicitly configured `options.store` wins;
 * otherwise an in-memory store is created.
 */
const storeProvider: Provider = {
  provide: MCP_OAUTH_STORE,
  useFactory: (options: McpAuthModuleOptions) => options.store ?? new MemoryOAuthStore(),
  inject: [MCP_AUTH_OPTIONS],
};

const sharedProviders: Provider[] = [
  storeProvider,
  { provide: MCP_BEARER_TOKEN_VERIFIER, useClass: JwtBearerTokenVerifier },
  JwtTokenService,
  OAuthClientService,
  OAuthFlowService,
  JwtAuthGuard,
  AuthRateLimitGuard,
  AuthAuditService,
];

const moduleExports = [
  JwtTokenService,
  OAuthClientService,
  JwtAuthGuard,
  MCP_AUTH_OPTIONS,
  MCP_OAUTH_STORE,
  MCP_BEARER_TOKEN_VERIFIER,
];

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: NestJS requires module classes
export class McpAuthModule {
  static forRoot(options: McpAuthModuleOptions): DynamicModule {
    validateAuthOptions(options);

    const oauthBasePath = options.serverUrl ? new URL(options.serverUrl).pathname : '';
    const OAuthCtrl = createOAuthController(oauthBasePath);
    const WellKnownCtrl = createWellKnownController();

    return {
      module: McpAuthModule,
      providers: [{ provide: MCP_AUTH_OPTIONS, useValue: options }, ...sharedProviders],
      controllers: [OAuthCtrl, WellKnownCtrl],
      exports: moduleExports,
    };
  }

  /**
   * Async variant: options are produced by a DI-aware factory. Controllers
   * are created from the STATIC `serverUrl` on the async options (controller
   * shape cannot depend on the factory result); everything else flows through
   * the resolved `MCP_AUTH_OPTIONS`.
   */
  static forRootAsync(options: McpAuthModuleAsyncOptions): DynamicModule {
    const oauthBasePath = options.serverUrl ? new URL(options.serverUrl).pathname : '';
    const OAuthCtrl = createOAuthController(oauthBasePath);
    const WellKnownCtrl = createWellKnownController();

    return {
      module: McpAuthModule,
      imports: options.imports ?? [],
      providers: [
        {
          provide: MCP_AUTH_OPTIONS,
          useFactory: async (...args: unknown[]) =>
            validateAuthOptions(await options.useFactory(...args)),
          inject: options.inject ?? [],
        },
        ...sharedProviders,
      ],
      controllers: [OAuthCtrl, WellKnownCtrl],
      exports: moduleExports,
    };
  }

  static forProvider(
    adapter: OAuthProviderAdapter,
    options: Omit<McpAuthModuleOptions, 'validateUser'>,
  ): DynamicModule {
    return McpAuthModule.forRoot({
      ...options,
      validateUser: (req) => adapter.validateUser(req),
    });
  }
}
