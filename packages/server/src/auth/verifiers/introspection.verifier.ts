import { createHash } from 'node:crypto';
import { ServerError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { McpAuthInfo } from '@nest-mcp/common';
import type { IntrospectionVerifierOptions } from '../interfaces/resource-server-options.interface';
import { audienceMatches } from './audience.util';
import type { BearerTokenVerifier } from './bearer-verifier.interface';

const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_CACHE_MAX_ENTRIES = 1_000;

interface CacheEntry {
  value: McpAuthInfo | null;
  expiresAt: number;
}

/**
 * Verifies opaque access tokens against the authorization server's RFC 7662
 * introspection endpoint (HTTP Basic client authentication). Results are
 * cached under SHA-256 token digests — never raw tokens — with a TTL bounded
 * by the token's own `exp`. Audience binding is enforced by default.
 */
export class IntrospectionVerifier implements BearerTokenVerifier {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly cacheTtlMs: number;
  private readonly cacheMaxEntries: number;

  constructor(
    private readonly options: IntrospectionVerifierOptions,
    private readonly resource: string,
    private readonly validateAudience: boolean = true,
    private readonly fetchFn: typeof fetch = (...args) => fetch(...args),
  ) {
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.cacheMaxEntries = options.cacheMaxEntries ?? DEFAULT_CACHE_MAX_ENTRIES;
  }

  async verify(token: string): Promise<McpAuthInfo | null> {
    const key = createHash('sha256').update(token).digest('hex');
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    this.cache.delete(key);

    // RFC 6749 §2.3.1: credentials are form-urlencoded before Basic encoding.
    const credentials = Buffer.from(
      `${encodeURIComponent(this.options.clientId)}:${encodeURIComponent(this.options.clientSecret)}`,
    ).toString('base64');

    // Introspection failures are OUR infrastructure failing, not the token
    // being invalid — surface 500 (SDK clients retry) instead of 401 (SDK
    // clients discard their tokens and re-authorize). Never cached.
    let response: Response;
    try {
      response = await this.fetchFn(this.options.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Basic ${credentials}`,
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({ token, token_type_hint: 'access_token' }).toString(),
      });
    } catch {
      throw new ServerError('Token introspection request failed');
    }
    if (!response.ok) {
      throw new ServerError(`Token introspection failed with status ${response.status}`);
    }

    let payload: Record<string, unknown>;
    try {
      payload = (await response.json()) as Record<string, unknown>;
    } catch {
      throw new ServerError('Token introspection returned an invalid response');
    }

    const active =
      payload.active === true &&
      (!this.validateAudience || audienceMatches(payload.aud, this.resource));
    const value = active ? toAuthInfo(token, payload) : null;
    this.store(key, value, payload.exp);
    return value;
  }

  private store(key: string, value: McpAuthInfo | null, exp: unknown): void {
    let ttl = this.cacheTtlMs;
    if (value && typeof exp === 'number') {
      ttl = Math.min(ttl, exp * 1000 - Date.now());
      if (ttl <= 0) return;
    }

    if (this.cache.size >= this.cacheMaxEntries) {
      // Maps iterate in insertion order — drop the oldest entry.
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { value, expiresAt: Date.now() + ttl });
  }
}

function toAuthInfo(token: string, payload: Record<string, unknown>): McpAuthInfo {
  return {
    token,
    clientId: (payload.client_id as string) ?? '',
    scopes: typeof payload.scope === 'string' ? payload.scope.split(' ').filter(Boolean) : [],
    expiresAt: payload.exp as number | undefined,
    extra: { ...payload },
  };
}
