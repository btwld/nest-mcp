import { Controller, Get, type Type } from '@nestjs/common';
import type { McpAuthModuleOptions } from '../interfaces/auth-module-options.interface';

export function createWellKnownController(options: McpAuthModuleOptions): Type<unknown> {
  const serverUrl = options.serverUrl ?? 'http://localhost:3000';
  const resourceUrl = options.resourceUrl ?? `${serverUrl}/mcp`;

  @Controller('.well-known')
  class WellKnownController {
    @Get('oauth-authorization-server')
    getAuthorizationServerMetadata() {
      return {
        issuer: options.issuer ?? serverUrl,
        authorization_endpoint: `${serverUrl}/authorize`,
        token_endpoint: `${serverUrl}/token`,
        registration_endpoint:
          options.enableDynamicRegistration !== false ? `${serverUrl}/register` : undefined,
        revocation_endpoint: `${serverUrl}/revoke`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
        code_challenge_methods_supported: ['S256', 'plain'],
        scopes_supported: options.scopes ?? [],
      };
    }

    @Get('oauth-protected-resource')
    getProtectedResourceMetadata() {
      return {
        resource: resourceUrl,
        authorization_servers: [options.issuer ?? serverUrl],
        scopes_supported: options.scopes ?? [],
        bearer_methods_supported: ['header'],
      };
    }
  }

  return WellKnownController;
}
