import 'reflect-metadata';
import { JwtAuthGuard } from './jwt-auth.guard';
import type { McpGuardContext } from '@btwld/mcp-common';

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;
  let jwtService: { validateToken: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    jwtService = {
      validateToken: vi.fn(),
    };
    guard = new JwtAuthGuard(jwtService as any);
  });

  function makeContext(request?: any): McpGuardContext {
    return {
      sessionId: 'test-session',
      metadata: {},
      request,
    };
  }

  // --- Missing / Invalid auth header ---

  it('returns false when no authorization header', async () => {
    const context = makeContext({ headers: {} });
    const result = await guard.canActivate(context);
    expect(result).toBe(false);
  });

  it('returns false when request is undefined', async () => {
    const context = makeContext(undefined);
    const result = await guard.canActivate(context);
    expect(result).toBe(false);
  });

  it('returns false when request has no headers', async () => {
    const context = makeContext({});
    const result = await guard.canActivate(context);
    expect(result).toBe(false);
  });

  it('returns false when authorization is not Bearer type', async () => {
    const context = makeContext({ headers: { authorization: 'Basic abc123' } });
    const result = await guard.canActivate(context);
    expect(result).toBe(false);
  });

  it('returns false when token is empty after Bearer', async () => {
    const context = makeContext({ headers: { authorization: 'Bearer ' } });
    const result = await guard.canActivate(context);
    expect(result).toBe(false);
  });

  // --- Valid token ---

  it('returns true and sets context.user when token is valid', async () => {
    jwtService.validateToken.mockReturnValue({
      sub: 'user-42',
      scope: 'read write',
      type: 'access',
    });

    const context = makeContext({ headers: { authorization: 'Bearer valid-token' } });
    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    expect(jwtService.validateToken).toHaveBeenCalledWith('valid-token');
    expect(context.user).toEqual(
      expect.objectContaining({
        id: 'user-42',
        scopes: ['read', 'write'],
      }),
    );
  });

  // --- Invalid token ---

  it('returns false when validateToken throws', async () => {
    jwtService.validateToken.mockImplementation(() => {
      throw new Error('Invalid token');
    });

    const context = makeContext({ headers: { authorization: 'Bearer bad-token' } });
    const result = await guard.canActivate(context);

    expect(result).toBe(false);
  });

  // --- Scope handling ---

  it('splits scope string into scopes array', async () => {
    jwtService.validateToken.mockReturnValue({
      sub: 'user-1',
      scope: 'read write admin',
    });

    const context = makeContext({ headers: { authorization: 'Bearer token' } });
    await guard.canActivate(context);

    expect(context.user.scopes).toEqual(['read', 'write', 'admin']);
  });

  it('handles undefined scope gracefully', async () => {
    jwtService.validateToken.mockReturnValue({
      sub: 'user-1',
    });

    const context = makeContext({ headers: { authorization: 'Bearer token' } });
    await guard.canActivate(context);

    expect(context.user.scopes).toBeUndefined();
  });

  it('filters out empty strings from scope splitting', async () => {
    jwtService.validateToken.mockReturnValue({
      sub: 'user-1',
      scope: 'read  write',
    });

    const context = makeContext({ headers: { authorization: 'Bearer token' } });
    await guard.canActivate(context);

    expect(context.user.scopes).toEqual(['read', 'write']);
  });

  it('preserves existing context.user properties', async () => {
    jwtService.validateToken.mockReturnValue({
      sub: 'user-1',
      scope: 'read',
    });

    const context = makeContext({ headers: { authorization: 'Bearer token' } });
    context.user = { existingProp: 'keep-me' };

    await guard.canActivate(context);

    expect(context.user.id).toBe('user-1');
    expect(context.user.existingProp).toBe('keep-me');
  });
});
