import { ServerError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { McpError } from '@nest-mcp/common';
import { describe, expect, it, vi } from 'vitest';
import type { JwksVerifierOptions } from '../interfaces/resource-server-options.interface';
import { type JoseModule, JwksVerifier } from './jwks.verifier';

const RESOURCE = 'http://localhost:3000/mcp';

const baseOptions: JwksVerifierOptions = {
  uri: 'https://auth.example.com/.well-known/jwks.json',
  issuer: 'https://auth.example.com',
};

function setup({
  options = {},
  payload = { aud: RESOURCE },
  validateAudience,
}: {
  options?: Partial<JwksVerifierOptions>;
  payload?: Record<string, unknown>;
  validateAudience?: boolean;
} = {}) {
  const keySetSentinel = { keySet: 'sentinel' };
  const jwtVerify = vi.fn().mockResolvedValue({ payload });
  const createRemoteJWKSet = vi.fn(() => keySetSentinel);
  const loadJose = vi.fn(async (): Promise<JoseModule> => ({ createRemoteJWKSet, jwtVerify }));
  const verifier = new JwksVerifier(
    { ...baseOptions, ...options },
    RESOURCE,
    validateAudience,
    loadJose,
  );
  return { verifier, loadJose, createRemoteJWKSet, jwtVerify, keySetSentinel };
}

describe('JwksVerifier', () => {
  // --- Constructor algorithm validation ---

  describe('constructor', () => {
    it('throws McpError when algorithms include HS256', () => {
      expect(() => setup({ options: { algorithms: ['RS256', 'HS256'] } })).toThrow(McpError);
      expect(() => setup({ options: { algorithms: ['RS256', 'HS256'] } })).toThrow(
        'symmetric/none algorithms are not allowed',
      );
    });

    it('rejects HS algorithms case-insensitively (hs384)', () => {
      expect(() => setup({ options: { algorithms: ['hs384'] } })).toThrow(McpError);
    });

    it('rejects the none algorithm case-insensitively', () => {
      expect(() => setup({ options: { algorithms: ['none'] } })).toThrow(McpError);
      expect(() => setup({ options: { algorithms: ['NONE'] } })).toThrow(McpError);
    });

    it('lists every offending algorithm in the error message', () => {
      expect(() => setup({ options: { algorithms: ['HS256', 'none', 'RS256'] } })).toThrow(
        'HS256, none',
      );
    });

    it('accepts asymmetric algorithms and the default set', () => {
      expect(() => setup()).not.toThrow();
      expect(() => setup({ options: { algorithms: ['ES256', 'EdDSA'] } })).not.toThrow();
    });
  });

  // --- jwtVerify invocation & jose loading ---

  describe('jose loading and jwtVerify call', () => {
    it('calls jwtVerify with the token, the remote key set, and issuer/audience/algorithms', async () => {
      const { verifier, jwtVerify, keySetSentinel } = setup({
        options: { audience: 'my-api', algorithms: ['RS256'] },
      });

      await verifier.verify('the-token');

      expect(jwtVerify).toHaveBeenCalledWith('the-token', keySetSentinel, {
        issuer: baseOptions.issuer,
        audience: 'my-api',
        algorithms: ['RS256'],
      });
    });

    it('passes the default algorithms to jwtVerify, none of which are HS* or none', async () => {
      const { verifier, jwtVerify } = setup();

      await verifier.verify('tok');

      const { algorithms } = jwtVerify.mock.calls[0][2] as { algorithms: string[] };
      expect(algorithms).toEqual([
        'RS256',
        'RS384',
        'RS512',
        'PS256',
        'PS384',
        'PS512',
        'ES256',
        'ES384',
        'ES512',
        'EdDSA',
      ]);
      for (const alg of algorithms) {
        expect(alg).not.toMatch(/^hs/i);
        expect(alg.toLowerCase()).not.toBe('none');
      }
    });

    it('loads jose and creates the key set exactly once across multiple verify() calls', async () => {
      const { verifier, loadJose, createRemoteJWKSet } = setup();

      await verifier.verify('a');
      await verifier.verify('b');
      await verifier.verify('c');

      expect(loadJose).toHaveBeenCalledTimes(1);
      expect(createRemoteJWKSet).toHaveBeenCalledTimes(1);
      const url = createRemoteJWKSet.mock.calls[0][0] as URL;
      expect(url).toBeInstanceOf(URL);
      expect(url.href).toBe(baseOptions.uri);
    });
  });

  // --- Payload mapping ---

  describe('payload mapping', () => {
    it('maps azp to clientId', async () => {
      const { verifier } = setup({
        payload: { aud: RESOURCE, azp: 'azp-client', client_id: 'other-client' },
      });

      const info = await verifier.verify('tok');

      expect(info?.clientId).toBe('azp-client');
    });

    it('falls back to client_id when azp is absent', async () => {
      const { verifier } = setup({ payload: { aud: RESOURCE, client_id: 'cid-client' } });

      const info = await verifier.verify('tok');

      expect(info?.clientId).toBe('cid-client');
    });

    it('falls back to an empty clientId when neither azp nor client_id is present', async () => {
      const { verifier } = setup({ payload: { aud: RESOURCE } });

      const info = await verifier.verify('tok');

      expect(info?.clientId).toBe('');
    });

    it('splits a space-delimited scope claim into scopes', async () => {
      const { verifier } = setup({ payload: { aud: RESOURCE, scope: 'read  write admin' } });

      const info = await verifier.verify('tok');

      expect(info?.scopes).toEqual(['read', 'write', 'admin']);
    });

    it('falls back to a space-delimited scp string claim', async () => {
      const { verifier } = setup({ payload: { aud: RESOURCE, scp: 'read write' } });

      const info = await verifier.verify('tok');

      expect(info?.scopes).toEqual(['read', 'write']);
    });

    it('accepts an scp array claim, filtering out non-string entries', async () => {
      const { verifier } = setup({
        payload: { aud: RESOURCE, scp: ['read', 42, null, 'write', {}] },
      });

      const info = await verifier.verify('tok');

      expect(info?.scopes).toEqual(['read', 'write']);
    });

    it('returns no scopes when neither scope nor scp is present', async () => {
      const { verifier } = setup({ payload: { aud: RESOURCE } });

      const info = await verifier.verify('tok');

      expect(info?.scopes).toEqual([]);
    });

    it('maps exp to expiresAt and leaves it undefined when absent', async () => {
      const { verifier } = setup({ payload: { aud: RESOURCE, exp: 1750000000 } });
      expect((await verifier.verify('tok'))?.expiresAt).toBe(1750000000);

      const { verifier: noExp } = setup({ payload: { aud: RESOURCE } });
      expect((await noExp.verify('tok'))?.expiresAt).toBeUndefined();
    });

    it('echoes the token and exposes the full payload as extra', async () => {
      const payload = {
        aud: RESOURCE,
        azp: 'client-1',
        scope: 'read',
        exp: 1750000000,
        sub: 'user-1',
        custom: { nested: true },
      };
      const { verifier } = setup({ payload });

      const info = await verifier.verify('the-token');

      expect(info?.token).toBe('the-token');
      expect(info?.extra).toEqual(payload);
    });
  });

  // --- jwtVerify failure classification ---

  describe('jwtVerify failure classification', () => {
    it('returns null when jwtVerify rejects with a jose token error (ERR_JWT_EXPIRED)', async () => {
      const { verifier, jwtVerify } = setup();
      jwtVerify.mockRejectedValue(
        Object.assign(new Error('token expired'), { code: 'ERR_JWT_EXPIRED' }),
      );

      await expect(verifier.verify('bad-token')).resolves.toBeNull();
    });

    it('returns null on a signature failure (ERR_JWS_SIGNATURE_VERIFICATION_FAILED)', async () => {
      const { verifier, jwtVerify } = setup();
      jwtVerify.mockRejectedValue(
        Object.assign(new Error('signature verification failed'), {
          code: 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
        }),
      );

      await expect(verifier.verify('bad-token')).resolves.toBeNull();
    });

    it('rejects with ServerError when jwtVerify fails without a jose code (network TypeError)', async () => {
      const { verifier, jwtVerify } = setup();
      jwtVerify.mockRejectedValue(new TypeError('fetch failed'));

      await expect(verifier.verify('tok')).rejects.toThrow(ServerError);
      await expect(verifier.verify('tok')).rejects.toThrow(
        'Failed to verify token against the JWKS endpoint',
      );
    });

    it('rejects with ServerError on a plain Error rejection', async () => {
      const { verifier, jwtVerify } = setup();
      jwtVerify.mockRejectedValue(new Error('something went wrong'));

      await expect(verifier.verify('tok')).rejects.toThrow(ServerError);
    });

    it('rejects with ServerError on ERR_JWKS_TIMEOUT (infrastructure, not the token)', async () => {
      const { verifier, jwtVerify } = setup();
      jwtVerify.mockRejectedValue(
        Object.assign(new Error('jwks timed out'), { code: 'ERR_JWKS_TIMEOUT' }),
      );

      await expect(verifier.verify('tok')).rejects.toThrow(ServerError);
    });

    it('rejects with ServerError on ERR_JWKS_INVALID (infrastructure, not the token)', async () => {
      const { verifier, jwtVerify } = setup();
      jwtVerify.mockRejectedValue(
        Object.assign(new Error('jwks invalid'), { code: 'ERR_JWKS_INVALID' }),
      );

      await expect(verifier.verify('tok')).rejects.toThrow(ServerError);
    });
  });

  // --- Audience binding ---

  describe('audience binding', () => {
    describe('without options.audience (RFC 8707 matching, default validateAudience)', () => {
      it('passes when aud exactly matches the resource', async () => {
        const { verifier } = setup({ payload: { aud: RESOURCE } });

        await expect(verifier.verify('tok')).resolves.not.toBeNull();
      });

      it('returns null when aud is only a path prefix of the resource', async () => {
        const { verifier } = setup({ payload: { aud: 'http://localhost:3000' } });

        await expect(verifier.verify('tok')).resolves.toBeNull();
      });

      it('returns null when aud has a different origin', async () => {
        const { verifier } = setup({ payload: { aud: 'http://evil.example.com' } });

        await expect(verifier.verify('tok')).resolves.toBeNull();
      });

      it('returns null when aud is missing', async () => {
        const { verifier } = setup({ payload: {} });

        await expect(verifier.verify('tok')).resolves.toBeNull();
      });

      it('passes when any entry of an array aud matches', async () => {
        const { verifier } = setup({
          payload: { aud: ['http://other.example.com', 'http://localhost:3000/mcp'] },
        });

        await expect(verifier.verify('tok')).resolves.not.toBeNull();
      });
    });

    it('skips the manual aud check when options.audience is set (jose enforces it)', async () => {
      const { verifier } = setup({
        options: { audience: 'my-api' },
        payload: { aud: 'http://evil.example.com' },
      });

      await expect(verifier.verify('tok')).resolves.not.toBeNull();
    });

    it('skips the aud check when validateAudience is false', async () => {
      const { verifier: mismatched } = setup({
        payload: { aud: 'http://evil.example.com' },
        validateAudience: false,
      });
      await expect(mismatched.verify('tok')).resolves.not.toBeNull();

      const { verifier: missing } = setup({ payload: {}, validateAudience: false });
      await expect(missing.verify('tok')).resolves.not.toBeNull();
    });
  });

  // --- jose loader failures ---

  describe('jose loader failures', () => {
    it('rejects with an McpError pointing at the optional jose package', async () => {
      const loadJose = vi.fn().mockRejectedValue(new Error('Cannot find module jose'));
      const verifier = new JwksVerifier(baseOptions, RESOURCE, true, loadJose);

      await expect(verifier.verify('tok')).rejects.toThrow(McpError);
      await expect(verifier.verify('tok')).rejects.toThrow("requires the optional 'jose' package");
    });

    it('retries the loader on a subsequent verify() after a load failure', async () => {
      const keySetSentinel = { keySet: 'sentinel' };
      const jwtVerify = vi.fn().mockResolvedValue({ payload: { aud: RESOURCE, azp: 'c1' } });
      const loadJose = vi
        .fn()
        .mockRejectedValueOnce(new Error('Cannot find module jose'))
        .mockResolvedValue({ createRemoteJWKSet: vi.fn(() => keySetSentinel), jwtVerify });
      const verifier = new JwksVerifier(baseOptions, RESOURCE, true, loadJose);

      await expect(verifier.verify('tok')).rejects.toThrow(McpError);

      const info = await verifier.verify('tok');
      expect(info?.clientId).toBe('c1');
      expect(loadJose).toHaveBeenCalledTimes(2);
      expect(jwtVerify).toHaveBeenCalledWith('tok', keySetSentinel, expect.any(Object));
    });
  });
});
