import { Controller, Get, Inject, Req, type Type } from '@nestjs/common';
import type { McpAuthModuleOptions } from '../interfaces/auth-module-options.interface';
import { MCP_AUTH_OPTIONS } from '../services/jwt-token.service';

const DEFAULT_SERVER_URL = 'http://localhost:3000';

/**
 * Returns the Nest major version so route syntax can adapt: Nest 11
 * (path-to-regexp v8) requires named wildcards (`*rest`) while Nest 10
 * (legacy path-to-regexp) uses a bare `*`.
 */
function nestMajorVersion(): number {
  try {
    // The package builds to CommonJS, so `require` is available at runtime
    // (the typeof check covers ESM-transformed test environments). Neither
    // @nestjs/common@10 nor @11 restricts `./package.json` via exports.
    if (typeof require !== 'function') return 11;
    const { version } = require('@nestjs/common/package.json') as { version: string };
    return Number.parseInt(version.split('.')[0] ?? '', 10) || 11;
  } catch {
    return 11;
  }
}

/**
 * Builds the RFC 8414/9728 path-insertion wildcard route for a well-known
 * base path, using the wildcard syntax of the given Nest major version.
 *
 * Exported for tests only.
 */
export function buildWellKnownWildcardRoute(base: string, nestMajor: number): string {
  return nestMajor >= 11 ? `${base}/*rest` : `${base}/*`;
}

/**
 * Extracts the path-insertion suffix from a well-known request URL, e.g.
 * `/.well-known/oauth-protected-resource/mcp` → `mcp`. Version-agnostic
 * (reads the URL instead of route params, whose shape differs between
 * Express 4 and Express 5).
 *
 * Exported for tests only.
 */
export function extractWellKnownRest(url: string | undefined, base: string): string {
  if (!url) return '';
  const marker = `/.well-known/${base}/`;
  const index = url.indexOf(marker);
  if (index === -1) return '';
  const rest = url.slice(index + marker.length);
  const queryIndex = rest.indexOf('?');
  const path = queryIndex === -1 ? rest : rest.slice(0, queryIndex);
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

interface WellKnownRequest {
  url?: string;
  originalUrl?: string;
}

/**
 * Builds the `.well-known` controller serving RFC 8414 authorization-server
 * metadata and RFC 9728 protected-resource metadata, including the
 * path-insertion variants (`/.well-known/<base>/<path>`).
 *
 * Options are constructor-injected via `MCP_AUTH_OPTIONS` (instead of closed
 * over) so the controller also works with `McpAuthModule.forRootAsync`, where
 * options only exist once the factory has run.
 */
export function createWellKnownController(): Type<unknown> {
  const nestMajor = nestMajorVersion();

  @Controller('.well-known')
  class WellKnownController {
    constructor(
      @Inject(MCP_AUTH_OPTIONS)
      private readonly options: McpAuthModuleOptions,
    ) {}

    private get serverUrl(): string {
      return this.options.serverUrl ?? DEFAULT_SERVER_URL;
    }

    private get resourceUrl(): string {
      return this.options.resourceUrl ?? `${this.serverUrl}/mcp`;
    }

    @Get('oauth-authorization-server')
    getAuthorizationServerMetadata() {
      const serverUrl = this.serverUrl;
      const authMethods = ['client_secret_post', 'none'];
      return {
        issuer: this.options.issuer ?? serverUrl,
        authorization_endpoint: `${serverUrl}/authorize`,
        token_endpoint: `${serverUrl}/token`,
        registration_endpoint:
          this.options.enableDynamicRegistration !== false ? `${serverUrl}/register` : undefined,
        revocation_endpoint: `${serverUrl}/revoke`,
        revocation_endpoint_auth_methods_supported: authMethods,
        introspection_endpoint: `${serverUrl}/introspect`,
        introspection_endpoint_auth_methods_supported: authMethods,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: authMethods,
        code_challenge_methods_supported: ['S256', 'plain'],
        scopes_supported: this.options.scopes ?? [],
      };
    }

    /** RFC 8414 path-insertion variant — same metadata for any issuer path. */
    @Get(buildWellKnownWildcardRoute('oauth-authorization-server', nestMajor))
    getAuthorizationServerMetadataForPath() {
      return this.getAuthorizationServerMetadata();
    }

    @Get('oauth-protected-resource')
    getProtectedResourceMetadata() {
      return {
        resource: this.resourceUrl,
        authorization_servers: [this.options.issuer ?? this.serverUrl],
        scopes_supported: this.options.scopes ?? [],
        bearer_methods_supported: ['header'],
      };
    }

    /**
     * RFC 9728 path-insertion variant. When the inserted path matches the
     * configured resource path, `resource` is rebuilt from it
     * (`serverUrl + '/' + rest`); otherwise the default metadata is returned.
     */
    @Get(buildWellKnownWildcardRoute('oauth-protected-resource', nestMajor))
    getProtectedResourceMetadataForPath(@Req() req: WellKnownRequest) {
      const metadata = this.getProtectedResourceMetadata();
      const rest = extractWellKnownRest(req.originalUrl ?? req.url, 'oauth-protected-resource');

      const resourcePath = (() => {
        try {
          return new URL(this.resourceUrl).pathname.replace(/^\//, '');
        } catch {
          return '';
        }
      })();

      if (rest && rest === resourcePath) {
        return { ...metadata, resource: `${this.serverUrl}/${rest}` };
      }
      return metadata;
    }
  }

  return WellKnownController;
}
