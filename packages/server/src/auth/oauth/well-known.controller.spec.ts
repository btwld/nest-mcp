import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { createWellKnownController } from './well-known.controller';

const baseOptions = {
  jwtSecret: 'secret',
  serverUrl: 'https://auth.example.com',
};

describe('createWellKnownController', () => {
  it('returns a class (function)', () => {
    const ctrl = createWellKnownController(baseOptions);
    expect(typeof ctrl).toBe('function');
  });

  it('applies @Controller(".well-known") to the returned class', () => {
    const ctrl = createWellKnownController(baseOptions);
    expect(Reflect.getMetadata('path', ctrl)).toBe('.well-known');
  });

  describe('getAuthorizationServerMetadata()', () => {
    function invokeAuthMeta(options: Parameters<typeof createWellKnownController>[0]) {
      const Ctrl = createWellKnownController(options);
      const instance = new (Ctrl as new () => { getAuthorizationServerMetadata(): unknown })();
      return instance.getAuthorizationServerMetadata() as Record<string, unknown>;
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
    function invokeResourceMeta(options: Parameters<typeof createWellKnownController>[0]) {
      const Ctrl = createWellKnownController(options);
      const instance = new (Ctrl as new () => { getProtectedResourceMetadata(): unknown })();
      return instance.getProtectedResourceMetadata() as Record<string, unknown>;
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
});
