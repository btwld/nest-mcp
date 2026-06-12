import { ServerError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IntrospectionVerifierOptions } from '../interfaces/resource-server-options.interface';
import { IntrospectionVerifier } from './introspection.verifier';

const RESOURCE = 'http://localhost:3000/mcp';
const ENDPOINT = 'https://as.example.com/introspect';

const baseOptions: IntrospectionVerifierOptions = {
  endpoint: ENDPOINT,
  clientId: 'client-id',
  clientSecret: 'client-secret',
};

function activePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    active: true,
    aud: RESOURCE,
    client_id: 'client-1',
    scope: 'read write',
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
}

function fetchOk(payload: Record<string, unknown>) {
  return vi.fn().mockResolvedValue({ ok: true, json: async () => payload });
}

function makeVerifier(
  fetchFn: ReturnType<typeof vi.fn>,
  options: Partial<IntrospectionVerifierOptions> = {},
  validateAudience = true,
) {
  return new IntrospectionVerifier(
    { ...baseOptions, ...options },
    RESOURCE,
    validateAudience,
    fetchFn as unknown as typeof fetch,
  );
}

describe('IntrospectionVerifier', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // --- Request shape ---

  describe('introspection request', () => {
    it('POSTs the token to the endpoint with Basic auth and form encoding', async () => {
      const fetchFn = fetchOk(activePayload());
      const verifier = makeVerifier(fetchFn);

      await verifier.verify('token-abc');

      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(fetchFn).toHaveBeenCalledWith(ENDPOINT, {
        method: 'POST',
        headers: {
          // RFC 6749 §2.3.1: credentials are urlencoded before Basic encoding
          // (a no-op for these unreserved-character credentials).
          authorization: `Basic ${Buffer.from('client-id:client-secret').toString('base64')}`,
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: 'token=token-abc&token_type_hint=access_token',
      });
    });

    it('encodeURIComponent-encodes Basic credentials (RFC 6749 §2.3.1)', async () => {
      const fetchFn = fetchOk(activePayload());
      const verifier = makeVerifier(fetchFn, {
        clientId: 'client:id',
        clientSecret: 'sécret+/=',
      });

      await verifier.verify('token-abc');

      const [, init] = fetchFn.mock.calls[0] as [string, { headers: Record<string, string> }];
      // ':' in the clientId must not break the `id:secret` framing, and the
      // non-ASCII secret is percent-encoded as UTF-8 before base64.
      expect(init.headers.authorization).toBe(
        `Basic ${Buffer.from('client%3Aid:s%C3%A9cret%2B%2F%3D').toString('base64')}`,
      );
    });

    it('form-encodes tokens via URLSearchParams semantics', async () => {
      const fetchFn = fetchOk(activePayload());
      const verifier = makeVerifier(fetchFn);

      await verifier.verify('a b+c');

      const [, init] = fetchFn.mock.calls[0] as [string, { body: string }];
      expect(init.body).toBe('token=a+b%2Bc&token_type_hint=access_token');
    });
  });

  // --- Active token mapping ---

  describe('active token mapping', () => {
    it('maps an active payload to McpAuthInfo', async () => {
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const payload = activePayload({ exp, scope: 'read write', client_id: 'client-1' });
      const verifier = makeVerifier(fetchOk(payload));

      const result = await verifier.verify('token-abc');

      expect(result).toEqual({
        token: 'token-abc',
        clientId: 'client-1',
        scopes: ['read', 'write'],
        expiresAt: exp,
        extra: payload,
      });
    });

    it('defaults clientId to empty string and scopes to [] when absent', async () => {
      const payload = {
        active: true,
        aud: RESOURCE,
        exp: Math.floor(Date.now() / 1000) + 3600,
      };
      const verifier = makeVerifier(fetchOk(payload));

      const result = await verifier.verify('token-abc');

      expect(result?.clientId).toBe('');
      expect(result?.scopes).toEqual([]);
    });
  });

  // --- Negative / error results ---

  describe('inactive and failed introspection', () => {
    it('returns null for active:false and caches the negative result', async () => {
      const fetchFn = fetchOk({ active: false });
      const verifier = makeVerifier(fetchFn);

      await expect(verifier.verify('token-abc')).resolves.toBeNull();
      await expect(verifier.verify('token-abc')).resolves.toBeNull();

      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('throws ServerError with the status on non-ok response and does not cache', async () => {
      const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
      const verifier = makeVerifier(fetchFn);

      await expect(verifier.verify('token-abc')).rejects.toThrow(ServerError);
      await expect(verifier.verify('token-abc')).rejects.toThrow(
        'Token introspection failed with status 503',
      );

      // Two rejections above → two fetches: the failure was never cached.
      expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it('throws ServerError when fetch rejects and does not cache', async () => {
      const fetchFn = vi.fn().mockRejectedValue(new Error('connection refused'));
      const verifier = makeVerifier(fetchFn);

      await expect(verifier.verify('token-abc')).rejects.toThrow(ServerError);
      await expect(verifier.verify('token-abc')).rejects.toThrow(
        'Token introspection request failed',
      );

      expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it('throws ServerError on an invalid JSON body and does not cache', async () => {
      const fetchFn = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON');
        },
      });
      const verifier = makeVerifier(fetchFn);

      await expect(verifier.verify('token-abc')).rejects.toThrow(ServerError);
      await expect(verifier.verify('token-abc')).rejects.toThrow(
        'Token introspection returned an invalid response',
      );

      expect(fetchFn).toHaveBeenCalledTimes(2);
    });
  });

  // --- Caching ---

  describe('caching', () => {
    it('serves positive results from cache (single fetch for two verifies)', async () => {
      const fetchFn = fetchOk(activePayload());
      const verifier = makeVerifier(fetchFn);

      const first = await verifier.verify('token-abc');
      const second = await verifier.verify('token-abc');

      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(second).toBe(first);
    });

    it('fetches separately for distinct tokens', async () => {
      const fetchFn = fetchOk(activePayload());
      const verifier = makeVerifier(fetchFn);

      await verifier.verify('token-1');
      await verifier.verify('token-2');
      expect(fetchFn).toHaveBeenCalledTimes(2);

      await verifier.verify('token-1');
      expect(fetchFn).toHaveBeenCalledTimes(2);
    });
  });

  // --- Audience binding ---

  describe('audience validation', () => {
    it('returns null when aud does not cover the resource', async () => {
      const fetchFn = fetchOk(activePayload({ aud: 'https://other.example.com' }));
      const verifier = makeVerifier(fetchFn);

      await expect(verifier.verify('token-abc')).resolves.toBeNull();
    });

    it('skips the audience check when validateAudience is false', async () => {
      const fetchFn = fetchOk(activePayload({ aud: 'https://other.example.com' }));
      const verifier = makeVerifier(fetchFn, {}, false);

      const result = await verifier.verify('token-abc');
      expect(result?.token).toBe('token-abc');
    });

    it('accepts an aud that exactly matches the resource', async () => {
      const fetchFn = fetchOk(activePayload({ aud: RESOURCE }));
      const verifier = makeVerifier(fetchFn);

      const result = await verifier.verify('token-abc');
      expect(result?.token).toBe('token-abc');
    });

    it('returns null when aud is only a path prefix of the resource', async () => {
      const fetchFn = fetchOk(activePayload({ aud: 'http://localhost:3000' }));
      const verifier = makeVerifier(fetchFn);

      await expect(verifier.verify('token-abc')).resolves.toBeNull();
    });

    it('accepts an aud array containing a matching entry', async () => {
      const fetchFn = fetchOk(activePayload({ aud: ['https://other.example.com', RESOURCE] }));
      const verifier = makeVerifier(fetchFn);

      const result = await verifier.verify('token-abc');
      expect(result?.token).toBe('token-abc');
    });
  });

  // --- Cache TTL ---

  describe('cache TTL', () => {
    it('re-fetches after cacheTtlMs elapses', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      const fetchFn = fetchOk(activePayload());
      const verifier = makeVerifier(fetchFn, { cacheTtlMs: 30_000 });

      await verifier.verify('token-abc');
      vi.advanceTimersByTime(29_999);
      await verifier.verify('token-abc');
      expect(fetchFn).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(2);
      await verifier.verify('token-abc');
      expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it('bounds positive-entry TTL by the token exp when exp is sooner', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      // exp 10s out, cacheTtlMs 60s → effective TTL is 10s.
      const exp = Math.floor(Date.now() / 1000) + 10;
      const fetchFn = fetchOk(activePayload({ exp }));
      const verifier = makeVerifier(fetchFn, { cacheTtlMs: 60_000 });

      await verifier.verify('token-abc');
      vi.advanceTimersByTime(9_000);
      await verifier.verify('token-abc');
      expect(fetchFn).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1_500);
      await verifier.verify('token-abc');
      expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it('does not cache an active token whose exp is already in the past', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      const exp = Math.floor(Date.now() / 1000) - 10;
      const fetchFn = fetchOk(activePayload({ exp }));
      const verifier = makeVerifier(fetchFn);

      await verifier.verify('token-abc');
      await verifier.verify('token-abc');

      expect(fetchFn).toHaveBeenCalledTimes(2);
    });
  });

  // --- Cache eviction ---

  describe('cacheMaxEntries', () => {
    it('evicts the oldest entry beyond cacheMaxEntries', async () => {
      const fetchFn = fetchOk(activePayload());
      const verifier = makeVerifier(fetchFn, { cacheMaxEntries: 2 });

      await verifier.verify('token-1');
      await verifier.verify('token-2');
      await verifier.verify('token-3'); // evicts token-1
      expect(fetchFn).toHaveBeenCalledTimes(3);

      await verifier.verify('token-3');
      expect(fetchFn).toHaveBeenCalledTimes(3);

      await verifier.verify('token-1'); // no longer cached
      expect(fetchFn).toHaveBeenCalledTimes(4);
    });
  });
});
