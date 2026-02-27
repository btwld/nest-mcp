/**
 * Smoke tests verifying that OAuth utilities from the MCP SDK are re-exported
 * correctly from @btwld/mcp-client and behave as expected.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  auth,
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  extractWWWAuthenticateParams,
} from '../index';

describe('OAuth re-exports smoke tests', () => {
  it('extractWWWAuthenticateParams is exported and is a function', () => {
    expect(typeof extractWWWAuthenticateParams).toBe('function');
  });

  it('discoverAuthorizationServerMetadata is exported and is a function', () => {
    expect(typeof discoverAuthorizationServerMetadata).toBe('function');
  });

  it('discoverOAuthProtectedResourceMetadata is exported and is a function', () => {
    expect(typeof discoverOAuthProtectedResourceMetadata).toBe('function');
  });

  it('auth is exported and is a function', () => {
    expect(typeof auth).toBe('function');
  });

  describe('extractWWWAuthenticateParams', () => {
    it('parses Bearer challenge with resource_metadata URL', () => {
      const mockResponse = new Response(null, {
        status: 401,
        headers: {
          'WWW-Authenticate':
            'Bearer realm="test", resource_metadata="https://example.com/.well-known/oauth-protected-resource"',
        },
      });

      const result = extractWWWAuthenticateParams(mockResponse);

      expect(result).toBeDefined();
      // The SDK returns { resourceMetadataUrl, scope, error } — not raw header fields
      expect(result.resourceMetadataUrl).toBeInstanceOf(URL);
      expect(result.resourceMetadataUrl?.href).toBe(
        'https://example.com/.well-known/oauth-protected-resource',
      );
    });

    it('returns empty-ish object for response without WWW-Authenticate header', () => {
      const mockResponse = new Response(null, { status: 200 });
      const result = extractWWWAuthenticateParams(mockResponse);
      expect(result).toBeDefined();
      expect(result.resourceMetadataUrl).toBeUndefined();
    });
  });

  describe('discoverOAuthProtectedResourceMetadata', () => {
    beforeEach(() => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            resource: 'https://example.com',
            authorization_servers: ['https://auth.example.com'],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      );
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('fetches and returns protected resource metadata', async () => {
      const metadata = await discoverOAuthProtectedResourceMetadata(
        'https://example.com',
      );

      expect(metadata).toBeDefined();
      expect(metadata.resource).toBe('https://example.com');
    });
  });

  describe('discoverAuthorizationServerMetadata', () => {
    beforeEach(() => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            issuer: 'https://auth.example.com',
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://auth.example.com/token',
            response_types_supported: ['code'],
            code_challenge_methods_supported: ['S256'],
            grant_types_supported: ['authorization_code'],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      );
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('fetches and returns authorization server metadata', async () => {
      const metadata = await discoverAuthorizationServerMetadata(
        'https://auth.example.com',
      );

      expect(metadata).toBeDefined();
      expect(metadata.issuer).toBe('https://auth.example.com');
    });
  });
});
