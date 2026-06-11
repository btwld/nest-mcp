import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { McpAuthModuleOptions } from '../interfaces/auth-module-options.interface';
import {
  buildWellKnownWildcardRoute,
  createWellKnownController,
  extractWellKnownRest,
} from './well-known.controller';

const baseOptions: McpAuthModuleOptions = {
  jwtSecret: 'secret',
  serverUrl: 'https://auth.example.com',
};

type WellKnownInstance = {
  getAuthorizationServerMetadata(): Record<string, unknown>;
  getAuthorizationServerMetadataForPath(): Record<string, unknown>;
  getProtectedResourceMetadata(): Record<string, unknown>;
  getProtectedResourceMetadataForPath(req: { url?: string; originalUrl?: string }): Record<
    string,
    unknown
  >;
};

function makeInstance(options: McpAuthModuleOptions): WellKnownInstance {
  const Ctrl = createWellKnownController();
  return new (Ctrl as new (options: McpAuthModuleOptions) => WellKnownInstance)(options);
}

describe('createWellKnownController', () => {
  it('returns a class (function)', () => {
    const ctrl = createWellKnownController();
    expect(typeof ctrl).toBe('function');
  });

  it('applies @Controller(".well-known") to the returned class', () => {
    const ctrl = createWellKnownController();
    expect(Reflect.getMetadata('path', ctrl)).toBe('.well-known');
  });

  it('constructor-injects MCP_AUTH_OPTIONS (options read at request time, not closed over)', () => {
    // Same controller class serves whichever options DI provides.
    const a = makeInstance(baseOptions);
    const b = makeInstance({ jwtSecret: 'secret', serverUrl: 'https://other.example.com' });
    expect(a.getAuthorizationServerMetadata().issuer).toBe('https://auth.example.com');
    expect(b.getAuthorizationServerMetadata().issuer).toBe('https://other.example.com');
  });

  describe('getAuthorizationServerMetadata()', () => {
    function invokeAuthMeta(options: McpAuthModuleOptions) {
      return makeInstance(options).getAuthorizationServerMetadata();
    }

    it('uses serverUrl as issuer by default', () => {
      const meta = invokeAuthMeta(baseOptions);
      expect(meta.issuer).toBe('https://auth.example.com');
    });

    it('uses custom issuer when provided', () => {
      const meta = invokeAuthMeta({ ...baseOptions, issuer: 'https://issuer.example.com' });
      expect(meta.issuer).toBe('https://issuer.example.com');
    });

    it('builds authorization_endpoint from serverUrl', () => {
      const meta = invokeAuthMeta(baseOptions);
      expect(meta.authorization_endpoint).toBe('https://auth.example.com/authorize');
    });

    it('builds token_endpoint from serverUrl', () => {
      const meta = invokeAuthMeta(baseOptions);
      expect(meta.token_endpoint).toBe('https://auth.example.com/token');
    });

    it('builds revocation_endpoint from serverUrl', () => {
      const meta = invokeAuthMeta(baseOptions);
      expect(meta.revocation_endpoint).toBe('https://auth.example.com/revoke');
    });

    it('builds introspection_endpoint from serverUrl', () => {
      const meta = invokeAuthMeta(baseOptions);
      expect(meta.introspection_endpoint).toBe('https://auth.example.com/introspect');
    });

    it('advertises introspection_endpoint_auth_methods_supported', () => {
      const meta = invokeAuthMeta(baseOptions);
      expect(meta.introspection_endpoint_auth_methods_supported).toEqual([
        'client_secret_post',
        'none',
      ]);
    });

    it('advertises revocation_endpoint_auth_methods_supported', () => {
      const meta = invokeAuthMeta(baseOptions);
      expect(meta.revocation_endpoint_auth_methods_supported).toEqual([
        'client_secret_post',
        'none',
      ]);
    });

    it('includes registration_endpoint when enableDynamicRegistration is not false', () => {
      const meta = invokeAuthMeta(baseOptions);
      expect(meta.registration_endpoint).toBe('https://auth.example.com/register');
    });

    it('omits registration_endpoint when enableDynamicRegistration is false', () => {
      const meta = invokeAuthMeta({ ...baseOptions, enableDynamicRegistration: false });
      expect(meta.registration_endpoint).toBeUndefined();
    });

    it('returns expected response_types_supported', () => {
      const meta = invokeAuthMeta(baseOptions);
      expect(meta.response_types_supported).toEqual(['code']);
    });

    it('returns expected grant_types_supported', () => {
      const meta = invokeAuthMeta(baseOptions);
      expect(meta.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
    });

    it('returns expected code_challenge_methods_supported', () => {
      const meta = invokeAuthMeta(baseOptions);
      expect(meta.code_challenge_methods_supported).toEqual(['S256', 'plain']);
    });

    it('returns empty scopes_supported when scopes not provided', () => {
      const meta = invokeAuthMeta(baseOptions);
      expect(meta.scopes_supported).toEqual([]);
    });

    it('returns scopes_supported from options', () => {
      const meta = invokeAuthMeta({ ...baseOptions, scopes: ['read', 'write'] });
      expect(meta.scopes_supported).toEqual(['read', 'write']);
    });

    it('falls back to http://localhost:3000 when serverUrl is absent', () => {
      const meta = invokeAuthMeta({ jwtSecret: 'sec' });
      expect(meta.issuer).toBe('http://localhost:3000');
      expect(meta.authorization_endpoint).toBe('http://localhost:3000/authorize');
    });
  });

  describe('getProtectedResourceMetadata()', () => {
    function invokeResourceMeta(options: McpAuthModuleOptions) {
      return makeInstance(options).getProtectedResourceMetadata();
    }

    it('uses resourceUrl from options when provided', () => {
      const meta = invokeResourceMeta({
        ...baseOptions,
        resourceUrl: 'https://api.example.com/mcp',
      });
      expect(meta.resource).toBe('https://api.example.com/mcp');
    });

    it('defaults resourceUrl to serverUrl + /mcp', () => {
      const meta = invokeResourceMeta(baseOptions);
      expect(meta.resource).toBe('https://auth.example.com/mcp');
    });

    it('includes issuer in authorization_servers', () => {
      const meta = invokeResourceMeta({ ...baseOptions, issuer: 'https://issuer.example.com' });
      expect(meta.authorization_servers).toEqual(['https://issuer.example.com']);
    });

    it('uses serverUrl as authorization_server when issuer not set', () => {
      const meta = invokeResourceMeta(baseOptions);
      expect(meta.authorization_servers).toEqual(['https://auth.example.com']);
    });

    it('returns scopes_supported from options', () => {
      const meta = invokeResourceMeta({ ...baseOptions, scopes: ['openid'] });
      expect(meta.scopes_supported).toEqual(['openid']);
    });

    it('returns empty scopes_supported when scopes not provided', () => {
      const meta = invokeResourceMeta(baseOptions);
      expect(meta.scopes_supported).toEqual([]);
    });

    it('returns bearer_methods_supported as ["header"]', () => {
      const meta = invokeResourceMeta(baseOptions);
      expect(meta.bearer_methods_supported).toEqual(['header']);
    });
  });

  describe('path-insertion wildcard routes (RFC 8414 / RFC 9728)', () => {
    it('registers a GET wildcard route for oauth-authorization-server', () => {
      const Ctrl = createWellKnownController();
      const proto = Ctrl.prototype as Record<string, unknown>;
      const path = Reflect.getMetadata(
        'path',
        proto.getAuthorizationServerMetadataForPath as object,
      );
      // Nest 11 is installed in this workspace → named-wildcard syntax.
      expect(path).toBe('oauth-authorization-server/*rest');
    });

    it('registers a GET wildcard route for oauth-protected-resource', () => {
      const Ctrl = createWellKnownController();
      const proto = Ctrl.prototype as Record<string, unknown>;
      const path = Reflect.getMetadata('path', proto.getProtectedResourceMetadataForPath as object);
      expect(path).toBe('oauth-protected-resource/*rest');
    });

    it('authorization-server wildcard returns the same metadata as the exact route', () => {
      const instance = makeInstance({ ...baseOptions, scopes: ['read'] });
      expect(instance.getAuthorizationServerMetadataForPath()).toEqual(
        instance.getAuthorizationServerMetadata(),
      );
    });

    it('protected-resource wildcard rebuilds resource from serverUrl when the path matches', () => {
      const instance = makeInstance(baseOptions); // resourceUrl defaults to serverUrl + /mcp
      const meta = instance.getProtectedResourceMetadataForPath({
        url: '/.well-known/oauth-protected-resource/mcp',
      });
      expect(meta.resource).toBe('https://auth.example.com/mcp');
    });

    it('protected-resource wildcard matches the configured resource path of a custom resourceUrl', () => {
      const instance = makeInstance({
        ...baseOptions,
        resourceUrl: 'https://api.example.com/api/mcp',
      });
      const meta = instance.getProtectedResourceMetadataForPath({
        url: '/.well-known/oauth-protected-resource/api/mcp',
      });
      expect(meta.resource).toBe('https://auth.example.com/api/mcp');
    });

    it('protected-resource wildcard keeps the default resource for non-matching paths', () => {
      const instance = makeInstance(baseOptions);
      const meta = instance.getProtectedResourceMetadataForPath({
        url: '/.well-known/oauth-protected-resource/other',
      });
      expect(meta.resource).toBe('https://auth.example.com/mcp');
    });

    it('protected-resource wildcard prefers originalUrl over url (Express mounts)', () => {
      const instance = makeInstance(baseOptions);
      const meta = instance.getProtectedResourceMetadataForPath({
        url: '/mcp',
        originalUrl: '/.well-known/oauth-protected-resource/mcp',
      });
      expect(meta.resource).toBe('https://auth.example.com/mcp');
    });
  });

  describe('buildWellKnownWildcardRoute()', () => {
    it('uses named wildcards on Nest >= 11', () => {
      expect(buildWellKnownWildcardRoute('oauth-authorization-server', 11)).toBe(
        'oauth-authorization-server/*rest',
      );
      expect(buildWellKnownWildcardRoute('oauth-protected-resource', 12)).toBe(
        'oauth-protected-resource/*rest',
      );
    });

    it('uses a bare wildcard on Nest 10', () => {
      expect(buildWellKnownWildcardRoute('oauth-authorization-server', 10)).toBe(
        'oauth-authorization-server/*',
      );
    });
  });

  describe('extractWellKnownRest()', () => {
    it('extracts a single-segment suffix', () => {
      expect(
        extractWellKnownRest(
          '/.well-known/oauth-protected-resource/mcp',
          'oauth-protected-resource',
        ),
      ).toBe('mcp');
    });

    it('extracts a multi-segment suffix', () => {
      expect(
        extractWellKnownRest(
          '/.well-known/oauth-authorization-server/tenant/a',
          'oauth-authorization-server',
        ),
      ).toBe('tenant/a');
    });

    it('strips the query string', () => {
      expect(
        extractWellKnownRest(
          '/.well-known/oauth-protected-resource/mcp?foo=1',
          'oauth-protected-resource',
        ),
      ).toBe('mcp');
    });

    it('decodes percent-encoded segments', () => {
      expect(
        extractWellKnownRest(
          '/.well-known/oauth-protected-resource/my%20path',
          'oauth-protected-resource',
        ),
      ).toBe('my path');
    });

    it('returns empty string when the marker is absent or url is undefined', () => {
      expect(extractWellKnownRest('/somewhere/else', 'oauth-protected-resource')).toBe('');
      expect(extractWellKnownRest(undefined, 'oauth-protected-resource')).toBe('');
    });
  });
});
