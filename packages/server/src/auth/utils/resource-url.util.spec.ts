import { McpError } from '@nest-mcp/common';
import { describe, expect, it } from 'vitest';
import { buildResourceMetadataUrl, canonicalizeResourceUri } from './resource-url.util';

describe('canonicalizeResourceUri', () => {
  it('lowercases scheme and host while preserving path case', () => {
    expect(canonicalizeResourceUri('HTTPS://Example.COM/MCP/Path')).toBe(
      'https://example.com/MCP/Path',
    );
  });

  it('strips a trailing slash from a pathful resource', () => {
    expect(canonicalizeResourceUri('https://h/mcp/')).toBe('https://h/mcp');
  });

  it('strips repeated trailing slashes', () => {
    expect(canonicalizeResourceUri('https://h/mcp///')).toBe('https://h/mcp');
  });

  it('strips the fragment', () => {
    expect(canonicalizeResourceUri('https://h/mcp#section')).toBe('https://h/mcp');
  });

  it('collapses a bare origin with trailing slash to the origin', () => {
    expect(canonicalizeResourceUri('https://h/')).toBe('https://h');
  });

  it('returns a bare origin unchanged', () => {
    expect(canonicalizeResourceUri('https://h')).toBe('https://h');
  });

  it('collapses a bare origin with only a fragment to the origin', () => {
    expect(canonicalizeResourceUri('https://h/#frag')).toBe('https://h');
  });

  it('preserves an explicit port', () => {
    expect(canonicalizeResourceUri('https://h:8443/mcp')).toBe('https://h:8443/mcp');
  });

  it('preserves the http scheme (no https hardcoding)', () => {
    expect(canonicalizeResourceUri('http://h/mcp')).toBe('http://h/mcp');
  });

  it('keeps the query string on a root path instead of collapsing to origin', () => {
    expect(canonicalizeResourceUri('https://h/?tenant=a')).toBe('https://h/?tenant=a');
  });

  it('throws McpError for an invalid URL', () => {
    expect(() => canonicalizeResourceUri('not a url')).toThrow(McpError);
    expect(() => canonicalizeResourceUri('not a url')).toThrow(
      'McpAuthModule: "not a url" is not a valid resource URL',
    );
  });
});

describe('buildResourceMetadataUrl', () => {
  it('inserts the well-known segment before the resource path', () => {
    expect(buildResourceMetadataUrl('https://h/mcp')).toBe(
      'https://h/.well-known/oauth-protected-resource/mcp',
    );
  });

  it('omits the path segment for a root resource', () => {
    expect(buildResourceMetadataUrl('https://h')).toBe(
      'https://h/.well-known/oauth-protected-resource',
    );
  });

  it('preserves http scheme and port from the configured resource', () => {
    expect(buildResourceMetadataUrl('http://localhost:3000/mcp')).toBe(
      'http://localhost:3000/.well-known/oauth-protected-resource/mcp',
    );
  });

  it('preserves nested resource paths', () => {
    expect(buildResourceMetadataUrl('https://h/api/v1/mcp')).toBe(
      'https://h/.well-known/oauth-protected-resource/api/v1/mcp',
    );
  });
});
