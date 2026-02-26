import 'reflect-metadata';
import { HttpException, HttpStatus } from '@nestjs/common';
import type { McpAuthModuleOptions } from '../interfaces/auth-module-options.interface';
import type { TokenPayload } from '../interfaces/oauth-types.interface';
import { createOAuthController } from './oauth.controller';

describe('OAuthController - introspect', () => {
  let controller: InstanceType<ReturnType<typeof createOAuthController>>;
  let jwtService: {
    validateToken: ReturnType<typeof vi.fn>;
    generateTokenPair: ReturnType<typeof vi.fn>;
  };
  let store: {
    isTokenRevoked: ReturnType<typeof vi.fn>;
    revokeToken: ReturnType<typeof vi.fn>;
    getAuthCode: ReturnType<typeof vi.fn>;
    removeAuthCode: ReturnType<typeof vi.fn>;
    storeAuthCode: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    const OAuthCtrl = createOAuthController('');
    const options = {
      jwtSecret: 'x'.repeat(32),
      enableDynamicRegistration: true,
    } as McpAuthModuleOptions;

    jwtService = {
      validateToken: vi.fn(),
      generateTokenPair: vi.fn(),
    };
    store = {
      isTokenRevoked: vi.fn().mockResolvedValue(false),
      revokeToken: vi.fn(),
      getAuthCode: vi.fn(),
      removeAuthCode: vi.fn(),
      storeAuthCode: vi.fn(),
    };
    const clientService = { getClient: vi.fn(), registerClient: vi.fn() };

    controller = new OAuthCtrl(options, jwtService, clientService, store) as InstanceType<
      ReturnType<typeof createOAuthController>
    >;
  });

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
    try {
      // biome-ignore lint/suspicious/noExplicitAny: test access to method
      await (controller as any).introspect({});
      expect.unreachable('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(HttpStatus.BAD_REQUEST);
    }
  });
});
