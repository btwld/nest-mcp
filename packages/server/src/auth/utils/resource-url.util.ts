import { resourceUrlFromServerUrl } from '@modelcontextprotocol/sdk/shared/auth-utils.js';
import { McpError } from '@nest-mcp/common';

/**
 * Canonicalizes an RFC 8707 resource identifier: lowercased scheme/host (via
 * URL parsing), no fragment, no trailing slash. SDK clients compare this
 * value byte-for-byte in `selectResourceURL`, so the served metadata and the
 * `aud` claim must use the exact same form.
 */
export function canonicalizeResourceUri(uri: string): string {
  let url: URL;
  try {
    url = resourceUrlFromServerUrl(uri);
  } catch {
    throw new McpError(`McpAuthModule: "${uri}" is not a valid resource URL`);
  }

  if (url.pathname !== '/' && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/+$/, '');
  }
  // A bare origin serializes as `https://host/` — strip the lone slash.
  return url.pathname === '/' && !url.search ? url.origin : url.href;
}

/**
 * RFC 9728 path-insertion metadata URL for a canonical resource, e.g.
 * `https://host/mcp` → `https://host/.well-known/oauth-protected-resource/mcp`.
 * The scheme comes from the configured resource, never from request headers.
 */
export function buildResourceMetadataUrl(resource: string): string {
  const url = new URL(resource);
  const path = url.pathname === '/' ? '' : url.pathname;
  return `${url.origin}/.well-known/oauth-protected-resource${path}`;
}
