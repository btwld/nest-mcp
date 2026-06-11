import 'reflect-metadata';
import * as jwt from 'jsonwebtoken';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IOAuthStore } from '../stores/oauth-store.interface';
import { JwtBearerTokenVerifier } from './bearer-verifier.service';
import { JwtTokenService } from './jwt-token.service';

const secret = 'test-jwt-secret-key-for-unit-tests';

function makeStore(overrides: Partial<Record<keyof IOAuthStore, ReturnType<typeof vi.fn>>> = {}) {
  return {
    storeClient: vi.fn(),
    getClient: vi.fn(),
    storeAuthCode: vi.fn(),
    getAuthCode: vi.fn(),
    removeAuthCode: vi.fn(),
    revokeToken: vi.fn().mockResolvedValue(undefined),
    isTokenRevoked: vi.fn().mockResolvedValue(false),
    ...overrides,
  };
}

function makeVerifier(store = makeStore()) {
  const jwtService = new JwtTokenService({ jwtSecret: secret });
  return { verifier: new JwtBearerTokenVerifier(jwtService, store as never), store };
}

function signAccessToken(claims: Record<string, unknown> = {}, expiresIn = 3600): string {
  return jwt.sign(
    { sub: 'user-1', azp: 'client-1', type: 'access', iss: 'test', ...claims },
    secret,
    { expiresIn, algorithm: 'HS256' },
  );
}

describe('JwtBearerTokenVerifier', () => {
  let verifier: JwtBearerTokenVerifier;
  let store: ReturnType<typeof makeStore>;

  beforeEach(() => {
    ({ verifier, store } = makeVerifier());
  });

  it('returns McpAuthInfo for a valid access token', async () => {
    const token = signAccessToken({ scope: 'read write' });

    const result = await verifier.verify(token);

    expect(result).toEqual({
      token,
      clientId: 'client-1',
      scopes: ['read', 'write'],
      expiresAt: expect.any(Number),
      extra: { sub: 'user-1' },
    });
  });

  it('falls back to client_id when azp is absent', async () => {
    const token = signAccessToken({ azp: undefined, client_id: 'client-2' });

    const result = await verifier.verify(token);

    expect(result?.clientId).toBe('client-2');
  });

  it('returns empty clientId and scopes when claims are absent', async () => {
    const token = signAccessToken({ azp: undefined });

    const result = await verifier.verify(token);

    expect(result?.clientId).toBe('');
    expect(result?.scopes).toEqual([]);
  });

  it('returns null for an expired token', async () => {
    const token = signAccessToken({}, -10);

    expect(await verifier.verify(token)).toBeNull();
  });

  it('returns null for a token signed with the wrong secret', async () => {
    const token = jwt.sign({ sub: 'u', type: 'access' }, 'another-secret', { algorithm: 'HS256' });

    expect(await verifier.verify(token)).toBeNull();
  });

  it('returns null for a refresh token', async () => {
    const token = signAccessToken({ type: 'refresh', jti: 'jti-1' });

    expect(await verifier.verify(token)).toBeNull();
  });

  it('returns null for a revoked token and checks the store with the jti', async () => {
    store.isTokenRevoked.mockResolvedValue(true);
    const token = signAccessToken({ jti: 'jti-revoked' });

    expect(await verifier.verify(token)).toBeNull();
    expect(store.isTokenRevoked).toHaveBeenCalledWith('jti-revoked');
  });

  it('skips the revocation check when the token has no jti', async () => {
    const token = signAccessToken();

    expect(await verifier.verify(token)).not.toBeNull();
    expect(store.isTokenRevoked).not.toHaveBeenCalled();
  });

  it('returns null for a garbage token', async () => {
    expect(await verifier.verify('not.a.token')).toBeNull();
    expect(await verifier.verify('')).toBeNull();
  });
});
