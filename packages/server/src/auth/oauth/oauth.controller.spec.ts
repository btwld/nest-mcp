import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { HttpException, HttpStatus } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpAuthModuleOptions } from '../interfaces/auth-module-options.interface';
import type { TokenPayload } from '../interfaces/oauth-types.interface';
import { createOAuthController } from './oauth.controller';

// ─── Shared Setup ─────────────────────────────────────────────────────────────

type CtrlInstance = InstanceType<ReturnType<typeof createOAuthController>>;

function makeController(
  optionOverrides: Partial<McpAuthModuleOptions> = {},
  clientService?: { getClient: ReturnType<typeof vi.fn>; registerClient: ReturnType<typeof vi.fn> },
): {
  controller: CtrlInstance;
  jwtService: { validateToken: ReturnType<typeof vi.fn>; generateTokenPair: ReturnType<typeof vi.fn> };
  store: {
    isTokenRevoked: ReturnType<typeof vi.fn>;
    revokeToken: ReturnType<typeof vi.fn>;
    getAuthCode: ReturnType<typeof vi.fn>;
    removeAuthCode: ReturnType<typeof vi.fn>;
    storeAuthCode: ReturnType<typeof vi.fn>;
  };
} {
  const OAuthCtrl = createOAuthController('');
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
  const cs = clientService ?? { getClient: vi.fn().mockResolvedValue(null), registerClient: vi.fn() };

  const controller = new OAuthCtrl(options, jwtService, cs, store) as CtrlInstance;
  return { controller, jwtService, store };
}

const baseAuthQuery = {
  responseType: 'code',
  clientId: 'client-1',
  redirectUri: 'https://app.example.com/callback',
  codeChallenge: 'challenge-abc',
  codeChallengeMethod: 'S256',
  scope: 'tools:read',
  state: 'random-state',
  resource: 'https://api.example.com/mcp',
  req: {},
  res: { redirect: vi.fn() },
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('createOAuthController()', () => {
  it('returns a class (function)', () => {
    expect(typeof createOAuthController('')).toBe('function');
  });

  it('applies @Controller with the given base path', () => {
    const Ctrl = createOAuthController('/oauth');
    expect(Reflect.getMetadata('path', Ctrl)).toBe('/oauth');
  });
});

describe('OAuthController - introspect', () => {
  let controller: CtrlInstance;
  let jwtService: { validateToken: ReturnType<typeof vi.fn>; generateTokenPair: ReturnType<typeof vi.fn> };
  let store: {
    isTokenRevoked: ReturnType<typeof vi.fn>;
    revokeToken: ReturnType<typeof vi.fn>;
    getAuthCode: ReturnType<typeof vi.fn>;
    removeAuthCode: ReturnType<typeof vi.fn>;
    storeAuthCode: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    ({ controller, jwtService, store } = makeController());
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

    // biome-ignore lint/suspicious/noExplicitAny: test access to method
    const result = await (controller as any).introspect({ token: 'valid-jwt' });

    expect(result.active).toBe(true);
    expect(result.sub).toBe('user-1');
    expect(result.client_id).toBe('client-1');
    expect(result.scope).toBe('tools:read');
    expect(result.token_type).toBe('Bearer');
  });

  it('returns active: false for invalid token', async () => {
    jwtService.validateToken.mockImplementation(() => {
      throw new Error('invalid');
    });

    // biome-ignore lint/suspicious/noExplicitAny: test access to method
    const result = await (controller as any).introspect({ token: 'bad-jwt' });

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

    // biome-ignore lint/suspicious/noExplicitAny: test access to method
    const result = await (controller as any).introspect({ token: 'revoked-jwt' });

    expect(result.active).toBe(false);
  });

  it('throws 400 when token parameter is missing', async () => {
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: test access to method
      (controller as any).introspect({}),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('returns token_type undefined for non-access tokens', async () => {
    jwtService.validateToken.mockReturnValue({ sub: 'u', type: 'refresh', iss: 'test' });
    // biome-ignore lint/suspicious/noExplicitAny: test access to method
    const result = await (controller as any).introspect({ token: 'refresh-jwt' });
    expect(result.active).toBe(true);
    expect(result.token_type).toBeUndefined();
  });
});

describe('OAuthController - revoke', () => {
  let controller: CtrlInstance;
  let jwtService: { validateToken: ReturnType<typeof vi.fn>; generateTokenPair: ReturnType<typeof vi.fn> };
  let store: { revokeToken: ReturnType<typeof vi.fn>; isTokenRevoked: ReturnType<typeof vi.fn>; getAuthCode: ReturnType<typeof vi.fn>; removeAuthCode: ReturnType<typeof vi.fn>; storeAuthCode: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    ({ controller, jwtService, store } = makeController());
  });

  afterEach(() => vi.clearAllMocks());

  it('throws 400 when token is missing', async () => {
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: test access to method
      (controller as any).revoke({}),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('returns { success: true } when token is valid', async () => {
    jwtService.validateToken.mockReturnValue({ jti: 'jti-123', sub: 'u' });
    // biome-ignore lint/suspicious/noExplicitAny: test access to method
    const result = await (controller as any).revoke({ token: 'valid-jwt' });
    expect(result).toEqual({ success: true });
  });

  it('calls store.revokeToken with the jti', async () => {
    jwtService.validateToken.mockReturnValue({ jti: 'jti-abc', sub: 'u' });
    // biome-ignore lint/suspicious/noExplicitAny: test access to method
    await (controller as any).revoke({ token: 'valid-jwt' });
    expect(store.revokeToken).toHaveBeenCalledWith('jti-abc');
  });

  it('returns { success: true } even for invalid token (RFC 7009)', async () => {
    jwtService.validateToken.mockImplementation(() => { throw new Error('invalid'); });
    // biome-ignore lint/suspicious/noExplicitAny: test access to method
    const result = await (controller as any).revoke({ token: 'bad-jwt' });
    expect(result).toEqual({ success: true });
  });

  it('does not call store.revokeToken when token has no jti', async () => {
    jwtService.validateToken.mockReturnValue({ sub: 'u' }); // no jti
    // biome-ignore lint/suspicious/noExplicitAny: test access to method
    await (controller as any).revoke({ token: 'valid-jwt' });
    expect(store.revokeToken).not.toHaveBeenCalled();
  });
});

describe('OAuthController - register', () => {
  let controller: CtrlInstance;

  afterEach(() => vi.clearAllMocks());

  it('throws 403 when dynamic registration is disabled', async () => {
    ({ controller } = makeController({ enableDynamicRegistration: false }));
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: test access to method
      (controller as any).register({ client_name: 'app', redirect_uris: ['https://app/cb'] }),
    ).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });
  });

  it('throws 400 when client_name is missing', async () => {
    ({ controller } = makeController());
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: test access to method
      (controller as any).register({ redirect_uris: ['https://app/cb'] }),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('throws 400 when redirect_uris is empty', async () => {
    ({ controller } = makeController());
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: test access to method
      (controller as any).register({ client_name: 'app', redirect_uris: [] }),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('registers and returns client on success', async () => {
    const fakeClient = { client_id: 'c-1', client_name: 'app', redirect_uris: ['https://app/cb'] };
    const cs = { getClient: vi.fn(), registerClient: vi.fn().mockResolvedValue(fakeClient) };
    ({ controller } = makeController({}, cs));

    // biome-ignore lint/suspicious/noExplicitAny: test access to method
    const result = await (controller as any).register({
      client_name: 'app',
      redirect_uris: ['https://app/cb'],
    });
    expect(result).toEqual(fakeClient);
    expect(cs.registerClient).toHaveBeenCalledWith('app', ['https://app/cb'], undefined);
  });
});

describe('OAuthController - token', () => {
  let controller: CtrlInstance;
  let jwtService: { validateToken: ReturnType<typeof vi.fn>; generateTokenPair: ReturnType<typeof vi.fn> };
  let store: { isTokenRevoked: ReturnType<typeof vi.fn>; revokeToken: ReturnType<typeof vi.fn>; getAuthCode: ReturnType<typeof vi.fn>; removeAuthCode: ReturnType<typeof vi.fn>; storeAuthCode: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    ({ controller, jwtService, store } = makeController());
  });

  afterEach(() => vi.clearAllMocks());

  it('throws 400 for unsupported grant_type', async () => {
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: test access to method
      (controller as any).token({ grant_type: 'implicit' }),
    ).rejects.toBeInstanceOf(HttpException);
  });

  describe('authorization_code grant', () => {
    it('throws 400 when code is missing', async () => {
      await expect(
        // biome-ignore lint/suspicious/noExplicitAny: test access to method
        (controller as any).token({ grant_type: 'authorization_code', code_verifier: 'v' }),
      ).rejects.toBeInstanceOf(HttpException);
    });

    it('throws 400 when code_verifier is missing', async () => {
      await expect(
        // biome-ignore lint/suspicious/noExplicitAny: test access to method
        (controller as any).token({ grant_type: 'authorization_code', code: 'c' }),
      ).rejects.toBeInstanceOf(HttpException);
    });

    it('throws 400 for invalid/expired authorization code', async () => {
      store.getAuthCode.mockResolvedValue(null);
      await expect(
        // biome-ignore lint/suspicious/noExplicitAny: test access to method
        (controller as any).token({ grant_type: 'authorization_code', code: 'bad-code', code_verifier: 'v' }),
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
        // biome-ignore lint/suspicious/noExplicitAny: test access to method
        (controller as any).token({
          grant_type: 'authorization_code',
          code: 'c',
          code_verifier: 'v',
          redirect_uri: 'https://other.com/cb',
        }),
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
        // biome-ignore lint/suspicious/noExplicitAny: test access to method
        (controller as any).token({
          grant_type: 'authorization_code',
          code: 'c',
          code_verifier: 'bad-verifier',
        }),
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
        // biome-ignore lint/suspicious/noExplicitAny: test access to method
        (controller as any).token({
          grant_type: 'authorization_code',
          code: 'c',
          code_verifier: 'wrong-verifier',
        }),
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

      // biome-ignore lint/suspicious/noExplicitAny: test access to method
      const result = await (controller as any).token({
        grant_type: 'authorization_code',
        code: 'valid-code',
        code_verifier: verifier,
      });
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

      // biome-ignore lint/suspicious/noExplicitAny: test access to method
      const result = await (controller as any).token({
        grant_type: 'authorization_code',
        code: 'c',
        code_verifier: 'exact-verifier',
      });
      expect(result.access_token).toBe('at');
    });
  });

  describe('refresh_token grant', () => {
    it('throws 400 when refresh_token is missing', async () => {
      await expect(
        // biome-ignore lint/suspicious/noExplicitAny: test access to method
        (controller as any).token({ grant_type: 'refresh_token' }),
      ).rejects.toBeInstanceOf(HttpException);
    });

    it('throws 401 for invalid refresh token', async () => {
      jwtService.validateToken.mockImplementation(() => { throw new Error('invalid'); });
      await expect(
        // biome-ignore lint/suspicious/noExplicitAny: test access to method
        (controller as any).token({ grant_type: 'refresh_token', refresh_token: 'bad' }),
      ).rejects.toMatchObject({ status: HttpStatus.UNAUTHORIZED });
    });

    it('throws 400 when token is not a refresh token', async () => {
      jwtService.validateToken.mockReturnValue({ type: 'access', sub: 'u' });
      await expect(
        // biome-ignore lint/suspicious/noExplicitAny: test access to method
        (controller as any).token({ grant_type: 'refresh_token', refresh_token: 'access-jwt' }),
      ).rejects.toBeInstanceOf(HttpException);
    });

    it('throws 401 when refresh token is revoked', async () => {
      jwtService.validateToken.mockReturnValue({ type: 'refresh', jti: 'jti-1', sub: 'u' });
      store.isTokenRevoked.mockResolvedValue(true);
      await expect(
        // biome-ignore lint/suspicious/noExplicitAny: test access to method
        (controller as any).token({ grant_type: 'refresh_token', refresh_token: 'revoked-rt' }),
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
      // biome-ignore lint/suspicious/noExplicitAny: test access to method
      const result = await (controller as any).token({
        grant_type: 'refresh_token',
        refresh_token: 'valid-rt',
      });
      expect(result.access_token).toBe('at');
      expect(store.revokeToken).toHaveBeenCalledWith('old-jti');
    });

    it('skips revokeToken when refresh token has no jti', async () => {
      jwtService.validateToken.mockReturnValue({
        type: 'refresh',
        sub: 'user-1',
        client_id: 'client-1',
        scope: '',
        // no jti
      });
      // biome-ignore lint/suspicious/noExplicitAny: test access to method
      const result = await (controller as any).token({
        grant_type: 'refresh_token',
        refresh_token: 'no-jti-rt',
      });
      expect(result.access_token).toBe('at');
      expect(store.revokeToken).not.toHaveBeenCalled();
    });
  });
});

describe('OAuthController - authorize', () => {
  let controller: CtrlInstance;
  let store: { isTokenRevoked: ReturnType<typeof vi.fn>; revokeToken: ReturnType<typeof vi.fn>; getAuthCode: ReturnType<typeof vi.fn>; removeAuthCode: ReturnType<typeof vi.fn>; storeAuthCode: ReturnType<typeof vi.fn> };
  let clientService: { getClient: ReturnType<typeof vi.fn>; registerClient: ReturnType<typeof vi.fn> };
  let res: { redirect: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    res = { redirect: vi.fn() };
    clientService = {
      getClient: vi.fn().mockResolvedValue({
        client_id: 'client-1',
        redirect_uris: [baseAuthQuery.redirectUri],
      }),
      registerClient: vi.fn(),
    };
    ({ controller, store } = makeController({}, clientService));
  });

  afterEach(() => vi.clearAllMocks());

  it('throws 400 when response_type is not "code"', async () => {
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: test access to method
      (controller as any).authorize(
        'token', 'c', 'https://r', 'ch', 'S256', '', 'st', '', {}, res,
      ),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('throws 400 when client_id is missing', async () => {
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: test access to method
      (controller as any).authorize(
        'code', '', 'https://r', 'ch', 'S256', '', 'st', '', {}, res,
      ),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('throws 400 when redirect_uri is missing', async () => {
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: test access to method
      (controller as any).authorize(
        'code', 'c', '', 'ch', 'S256', '', 'st', '', {}, res,
      ),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('throws 400 when code_challenge is missing', async () => {
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: test access to method
      (controller as any).authorize(
        'code', 'c', 'https://r', '', 'S256', '', 'st', '', {}, res,
      ),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('throws 400 when state is missing', async () => {
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: test access to method
      (controller as any).authorize(
        'code', 'c', 'https://r', 'ch', 'S256', '', '', '', {}, res,
      ),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('throws 400 when client is unknown', async () => {
    clientService.getClient.mockResolvedValue(null);
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: test access to method
      (controller as any).authorize(
        'code', 'unknown-client', 'https://r', 'ch', 'S256', '', 'st', '', {}, res,
      ),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('throws 400 when redirect_uri not in registered URIs', async () => {
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: test access to method
      (controller as any).authorize(
        'code', 'client-1', 'https://evil.com/cb', 'ch', 'S256', '', 'st', '', {}, res,
      ),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('redirects with error when validateUser is not configured', async () => {
    // Explicitly set validateUser to undefined to override the default from makeController
    const opts = { enableDynamicRegistration: true, validateUser: undefined } as McpAuthModuleOptions;
    ({ controller } = makeController(opts, clientService));
    // biome-ignore lint/suspicious/noExplicitAny: test access to method
    await (controller as any).authorize(
      'code', 'client-1', baseAuthQuery.redirectUri, 'ch', 'S256', '', 'st', '', {}, res,
    );
    expect(res.redirect).toHaveBeenCalledWith(302, expect.stringContaining('error=access_denied'));
  });

  it('redirects with error when user validation fails', async () => {
    ({ controller } = makeController(
      { validateUser: async () => null },
      clientService,
    ));
    // biome-ignore lint/suspicious/noExplicitAny: test access to method
    await (controller as any).authorize(
      'code', 'client-1', baseAuthQuery.redirectUri, 'ch', 'S256', '', 'st', '', {}, res,
    );
    expect(res.redirect).toHaveBeenCalledWith(302, expect.stringContaining('error=access_denied'));
  });

  it('redirects with code on successful authorization', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test access to method
    await (controller as any).authorize(
      'code', 'client-1', baseAuthQuery.redirectUri, 'challenge', 'S256',
      'tools:read', 'state-xyz', 'https://api/mcp', {}, res,
    );
    expect(res.redirect).toHaveBeenCalledWith(302, expect.stringContaining('code='));
    expect(res.redirect).toHaveBeenCalledWith(302, expect.stringContaining('state=state-xyz'));
    expect(store.storeAuthCode).toHaveBeenCalled();
  });

  it('stores code_challenge_method as "plain" when plain is requested', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test access to method
    await (controller as any).authorize(
      'code', 'client-1', baseAuthQuery.redirectUri, 'my-plain-challenge', 'plain',
      '', 'st', '', {}, res,
    );
    expect(store.storeAuthCode).toHaveBeenCalledWith(
      expect.objectContaining({ code_challenge_method: 'plain' }),
    );
  });
});
