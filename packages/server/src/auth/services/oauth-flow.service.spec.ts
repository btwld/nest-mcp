import { createHash } from 'node:crypto';
import { HttpException, HttpStatus } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpAuthModuleOptions } from '../interfaces/auth-module-options.interface';
import type { AuthorizeQueryDto, TokenPayload } from '../interfaces/oauth-types.interface';
import { OAuthFlowService } from './oauth-flow.service';

// ─── Shared Setup ─────────────────────────────────────────────────────────────

function makeService(
  optionOverrides: Partial<McpAuthModuleOptions> = {},
  clientServiceOverrides: Partial<{ getClient: ReturnType<typeof vi.fn>; registerClient: ReturnType<typeof vi.fn> }> = {},
) {
  const options: McpAuthModuleOptions = {
    jwtSecret: 'x'.repeat(32),
    enableDynamicRegistration: true,
    validateUser: async () => ({ id: 'user-1', email: 'user@example.com' }),
    ...optionOverrides,
  };

  const jwtService = {
    validateToken: vi.fn(),
    generateTokenPair: vi.fn().mockReturnValue({
      access_token: 'at',
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: 'rt',
    }),
  };

  const store = {
    isTokenRevoked: vi.fn().mockResolvedValue(false),
    revokeToken: vi.fn().mockResolvedValue(undefined),
    getAuthCode: vi.fn().mockResolvedValue(null),
    removeAuthCode: vi.fn().mockResolvedValue(undefined),
    storeAuthCode: vi.fn().mockResolvedValue(undefined),
  };

  const clientService = {
    getClient: vi.fn().mockResolvedValue(null),
    registerClient: vi.fn(),
    ...clientServiceOverrides,
  };

  const service = new OAuthFlowService(options, jwtService as never, clientService as never, store as never);
  return { service, jwtService, store, clientService };
}

const baseQuery: AuthorizeQueryDto = {
  response_type: 'code',
  client_id: 'client-1',
  redirect_uri: 'https://app.example.com/callback',
  code_challenge: 'challenge-abc',
  code_challenge_method: 'S256',
  scope: 'tools:read',
  state: 'random-state',
  resource: 'https://api.example.com/mcp',
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('OAuthFlowService - authorize', () => {
  let service: OAuthFlowService;
  let store: ReturnType<typeof makeService>['store'];
  let clientService: ReturnType<typeof makeService>['clientService'];

  beforeEach(() => {
    ({ service, store, clientService } = makeService({}, {
      getClient: vi.fn().mockResolvedValue({
        client_id: 'client-1',
        redirect_uris: [baseQuery.redirect_uri],
      }),
      registerClient: vi.fn(),
    }));
  });

  afterEach(() => vi.clearAllMocks());

  it('throws 400 when response_type is not "code"', async () => {
    await expect(
      service.authorize({ ...baseQuery, response_type: 'token' }, {}),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('throws 400 when client_id is missing', async () => {
    await expect(
      service.authorize({ ...baseQuery, client_id: '' }, {}),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('throws 400 when redirect_uri is missing', async () => {
    await expect(
      service.authorize({ ...baseQuery, redirect_uri: '' }, {}),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('throws 400 when code_challenge is missing', async () => {
    await expect(
      service.authorize({ ...baseQuery, code_challenge: '' }, {}),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('throws 400 when state is missing', async () => {
    await expect(
      service.authorize({ ...baseQuery, state: '' }, {}),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('throws 400 when client is unknown', async () => {
    clientService.getClient.mockResolvedValue(null);
    await expect(
      service.authorize({ ...baseQuery, client_id: 'unknown-client' }, {}),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('throws 400 when redirect_uri not in registered URIs', async () => {
    await expect(
      service.authorize({ ...baseQuery, redirect_uri: 'https://evil.com/cb' }, {}),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('returns denied outcome when validateUser is not configured', async () => {
    const { service: svc } = makeService(
      { validateUser: undefined } as McpAuthModuleOptions,
      { getClient: vi.fn().mockResolvedValue({ client_id: 'client-1', redirect_uris: [baseQuery.redirect_uri] }) },
    );

    const result = await svc.authorize(baseQuery, {});

    expect(result.type).toBe('denied');
    expect(result.error).toBe('access_denied');
  });

  it('returns denied outcome when user validation fails', async () => {
    const { service: svc } = makeService(
      { validateUser: async () => null },
      { getClient: vi.fn().mockResolvedValue({ client_id: 'client-1', redirect_uris: [baseQuery.redirect_uri] }) },
    );

    const result = await svc.authorize(baseQuery, {});

    expect(result.type).toBe('denied');
    expect(result.state).toBe(baseQuery.state);
    expect(result.redirectUri).toBe(baseQuery.redirect_uri);
  });

  it('returns granted outcome with code on successful authorization', async () => {
    const result = await service.authorize(baseQuery, {});

    expect(result.type).toBe('granted');
    if (result.type === 'granted') {
      expect(result.code).toMatch(/^[0-9a-f]{64}$/);
      expect(result.state).toBe(baseQuery.state);
      expect(result.redirectUri).toBe(baseQuery.redirect_uri);
    }
    expect(store.storeAuthCode).toHaveBeenCalled();
  });

  it('stores code_challenge_method as "plain" when plain is requested', async () => {
    await service.authorize({ ...baseQuery, code_challenge_method: 'plain' }, {});

    expect(store.storeAuthCode).toHaveBeenCalledWith(
      expect.objectContaining({ code_challenge_method: 'plain' }),
    );
  });

  it('defaults code_challenge_method to S256 for unknown methods', async () => {
    await service.authorize({ ...baseQuery, code_challenge_method: 'unknown' }, {});

    expect(store.storeAuthCode).toHaveBeenCalledWith(
      expect.objectContaining({ code_challenge_method: 'S256' }),
    );
  });
});

describe('OAuthFlowService - handleGrant', () => {
  let service: OAuthFlowService;

  beforeEach(() => {
    ({ service } = makeService());
  });

  afterEach(() => vi.clearAllMocks());

  it('throws 400 for unsupported grant_type', async () => {
    await expect(
      service.handleGrant({ grant_type: 'implicit' }),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('throws 400 for missing grant_type', async () => {
    await expect(
      service.handleGrant({}),
    ).rejects.toBeInstanceOf(HttpException);
  });
});

describe('OAuthFlowService - exchangeCode (authorization_code grant)', () => {
  let service: OAuthFlowService;
  let store: ReturnType<typeof makeService>['store'];

  beforeEach(() => {
    ({ service, store } = makeService());
  });

  afterEach(() => vi.clearAllMocks());

  it('throws 400 when code is missing', async () => {
    await expect(
      service.exchangeCode({ code_verifier: 'v' }),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('throws 400 when code_verifier is missing', async () => {
    await expect(
      service.exchangeCode({ code: 'c' }),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('throws 400 for invalid/expired authorization code', async () => {
    store.getAuthCode.mockResolvedValue(null);
    await expect(
      service.exchangeCode({ code: 'bad-code', code_verifier: 'v' }),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('throws 400 for redirect_uri mismatch', async () => {
    store.getAuthCode.mockResolvedValue({
      code_challenge: 'ch',
      code_challenge_method: 'plain',
      redirect_uri: 'https://original.com/cb',
      user_id: 'u',
      client_id: 'c',
      scope: '',
    });
    await expect(
      service.exchangeCode({ code: 'c', code_verifier: 'v', redirect_uri: 'https://other.com/cb' }),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('throws 400 for invalid S256 code_verifier', async () => {
    store.getAuthCode.mockResolvedValue({
      code_challenge: 'wrong-challenge',
      code_challenge_method: 'S256',
      redirect_uri: 'https://app/cb',
      user_id: 'u',
      client_id: 'c',
      scope: '',
    });
    await expect(
      service.exchangeCode({ code: 'c', code_verifier: 'bad-verifier' }),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('throws 400 for invalid plain code_verifier', async () => {
    store.getAuthCode.mockResolvedValue({
      code_challenge: 'correct-challenge',
      code_challenge_method: 'plain',
      redirect_uri: 'https://app/cb',
      user_id: 'u',
      client_id: 'c',
      scope: '',
    });
    await expect(
      service.exchangeCode({ code: 'c', code_verifier: 'wrong-verifier' }),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('exchanges valid code with S256 for token pair', async () => {
    const verifier = 'my-verifier-string';
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    store.getAuthCode.mockResolvedValue({
      code_challenge: challenge,
      code_challenge_method: 'S256',
      redirect_uri: 'https://app/cb',
      user_id: 'user-1',
      client_id: 'client-1',
      scope: 'tools:read',
      resource: 'https://api/mcp',
    });

    const result = await service.exchangeCode({ code: 'valid-code', code_verifier: verifier });

    expect(result.access_token).toBe('at');
    expect(store.removeAuthCode).toHaveBeenCalledWith('valid-code');
  });

  it('exchanges valid code with plain verifier for token pair', async () => {
    store.getAuthCode.mockResolvedValue({
      code_challenge: 'exact-verifier',
      code_challenge_method: 'plain',
      redirect_uri: 'https://app/cb',
      user_id: 'user-1',
      client_id: 'client-1',
      scope: '',
    });

    const result = await service.exchangeCode({ code: 'c', code_verifier: 'exact-verifier' });

    expect(result.access_token).toBe('at');
  });
});

describe('OAuthFlowService - refreshToken (refresh_token grant)', () => {
  let service: OAuthFlowService;
  let jwtService: ReturnType<typeof makeService>['jwtService'];
  let store: ReturnType<typeof makeService>['store'];

  beforeEach(() => {
    ({ service, jwtService, store } = makeService());
  });

  afterEach(() => vi.clearAllMocks());

  it('throws 400 when refresh_token is missing', async () => {
    await expect(service.refreshToken({})).rejects.toBeInstanceOf(HttpException);
  });

  it('throws 401 for invalid refresh token', async () => {
    jwtService.validateToken.mockImplementation(() => { throw new Error('invalid'); });
    await expect(
      service.refreshToken({ refresh_token: 'bad' }),
    ).rejects.toMatchObject({ status: HttpStatus.UNAUTHORIZED });
  });

  it('throws 400 when token is not a refresh token', async () => {
    jwtService.validateToken.mockReturnValue({ type: 'access', sub: 'u' });
    await expect(
      service.refreshToken({ refresh_token: 'access-jwt' }),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('throws 401 when refresh token is revoked', async () => {
    jwtService.validateToken.mockReturnValue({ type: 'refresh', jti: 'jti-1', sub: 'u' });
    store.isTokenRevoked.mockResolvedValue(true);
    await expect(
      service.refreshToken({ refresh_token: 'revoked-rt' }),
    ).rejects.toMatchObject({ status: HttpStatus.UNAUTHORIZED });
  });

  it('issues new token pair and revokes old refresh token', async () => {
    jwtService.validateToken.mockReturnValue({
      type: 'refresh',
      jti: 'old-jti',
      sub: 'user-1',
      azp: 'client-1',
      scope: 'tools:read',
    });

    const result = await service.refreshToken({ refresh_token: 'valid-rt' });

    expect(result.access_token).toBe('at');
    expect(store.revokeToken).toHaveBeenCalledWith('old-jti');
  });

  it('skips revokeToken when refresh token has no jti', async () => {
    jwtService.validateToken.mockReturnValue({
      type: 'refresh',
      sub: 'user-1',
      client_id: 'client-1',
      scope: '',
    });

    const result = await service.refreshToken({ refresh_token: 'no-jti-rt' });

    expect(result.access_token).toBe('at');
    expect(store.revokeToken).not.toHaveBeenCalled();
  });
});

describe('OAuthFlowService - revokeToken', () => {
  let service: OAuthFlowService;
  let jwtService: ReturnType<typeof makeService>['jwtService'];
  let store: ReturnType<typeof makeService>['store'];

  beforeEach(() => {
    ({ service, jwtService, store } = makeService());
  });

  afterEach(() => vi.clearAllMocks());

  it('throws 400 when token is missing', async () => {
    await expect(service.revokeToken({})).rejects.toBeInstanceOf(HttpException);
  });

  it('returns { success: true } when token is valid', async () => {
    jwtService.validateToken.mockReturnValue({ jti: 'jti-123', sub: 'u' });
    const result = await service.revokeToken({ token: 'valid-jwt' });
    expect(result).toEqual({ success: true });
  });

  it('calls store.revokeToken with the jti', async () => {
    jwtService.validateToken.mockReturnValue({ jti: 'jti-abc', sub: 'u' });
    await service.revokeToken({ token: 'valid-jwt' });
    expect(store.revokeToken).toHaveBeenCalledWith('jti-abc');
  });

  it('returns { success: true } even for invalid token (RFC 7009)', async () => {
    jwtService.validateToken.mockImplementation(() => { throw new Error('invalid'); });
    const result = await service.revokeToken({ token: 'bad-jwt' });
    expect(result).toEqual({ success: true });
  });

  it('does not call store.revokeToken when token has no jti', async () => {
    jwtService.validateToken.mockReturnValue({ sub: 'u' }); // no jti
    await service.revokeToken({ token: 'valid-jwt' });
    expect(store.revokeToken).not.toHaveBeenCalled();
  });
});

describe('OAuthFlowService - introspectToken', () => {
  let service: OAuthFlowService;
  let jwtService: ReturnType<typeof makeService>['jwtService'];
  let store: ReturnType<typeof makeService>['store'];

  beforeEach(() => {
    ({ service, jwtService, store } = makeService());
  });

  afterEach(() => vi.clearAllMocks());

  it('returns active: true for valid token', async () => {
    const payload: Partial<TokenPayload> = {
      sub: 'user-1',
      azp: 'client-1',
      type: 'access',
      scope: 'tools:read',
      iat: 1000,
      exp: 9999999999,
      iss: 'test',
    };
    jwtService.validateToken.mockReturnValue(payload);

    const result = await service.introspectToken({ token: 'valid-jwt' });

    expect(result.active).toBe(true);
    expect(result.sub).toBe('user-1');
    expect(result.client_id).toBe('client-1');
    expect(result.scope).toBe('tools:read');
    expect(result.token_type).toBe('Bearer');
  });

  it('returns active: false for invalid token', async () => {
    jwtService.validateToken.mockImplementation(() => { throw new Error('invalid'); });
    const result = await service.introspectToken({ token: 'bad-jwt' });
    expect(result.active).toBe(false);
  });

  it('returns active: false for revoked token', async () => {
    const payload: Partial<TokenPayload> = {
      sub: 'user-1',
      azp: 'client-1',
      type: 'refresh',
      jti: 'revoked-jti',
      iss: 'test',
    };
    jwtService.validateToken.mockReturnValue(payload);
    store.isTokenRevoked.mockResolvedValue(true);

    const result = await service.introspectToken({ token: 'revoked-jwt' });

    expect(result.active).toBe(false);
  });

  it('throws 400 when token parameter is missing', async () => {
    await expect(service.introspectToken({})).rejects.toBeInstanceOf(HttpException);
  });

  it('returns token_type undefined for non-access tokens', async () => {
    jwtService.validateToken.mockReturnValue({ sub: 'u', type: 'refresh', iss: 'test' });
    const result = await service.introspectToken({ token: 'refresh-jwt' });
    expect(result.active).toBe(true);
    expect(result.token_type).toBeUndefined();
  });
});

describe('OAuthFlowService - registerClient', () => {
  let service: OAuthFlowService;
  let clientService: ReturnType<typeof makeService>['clientService'];

  afterEach(() => vi.clearAllMocks());

  it('throws 403 when dynamic registration is disabled', async () => {
    ({ service } = makeService({ enableDynamicRegistration: false }));
    await expect(
      service.registerClient({ client_name: 'app', redirect_uris: ['https://app/cb'] }),
    ).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });
  });

  it('throws 400 when client_name is missing', async () => {
    ({ service } = makeService());
    await expect(
      service.registerClient({ redirect_uris: ['https://app/cb'] }),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('throws 400 when redirect_uris is empty', async () => {
    ({ service } = makeService());
    await expect(
      service.registerClient({ client_name: 'app', redirect_uris: [] }),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('registers and returns client on success', async () => {
    const fakeClient = { client_id: 'c-1', client_name: 'app', redirect_uris: ['https://app/cb'] };
    ({ service, clientService } = makeService({}, { registerClient: vi.fn().mockResolvedValue(fakeClient) }));

    const result = await service.registerClient({ client_name: 'app', redirect_uris: ['https://app/cb'] });

    expect(result).toEqual(fakeClient);
    expect(clientService.registerClient).toHaveBeenCalledWith('app', ['https://app/cb'], undefined);
  });
});
