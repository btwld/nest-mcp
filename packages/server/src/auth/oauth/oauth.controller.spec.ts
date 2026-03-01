import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthorizeQueryDto } from '../interfaces/oauth-types.interface';
import type { OAuthFlowService } from '../services/oauth-flow.service';
import { createOAuthController } from './oauth.controller';

// ─── Shared Setup ─────────────────────────────────────────────────────────────

type CtrlInstance = InstanceType<ReturnType<typeof createOAuthController>>;

function makeFlowService(): jest.Mocked<OAuthFlowService> {
  return {
    authorize: vi.fn(),
    handleGrant: vi.fn(),
    revokeToken: vi.fn(),
    introspectToken: vi.fn(),
    registerClient: vi.fn(),
  } as unknown as jest.Mocked<OAuthFlowService>;
}

function makeController(flowService = makeFlowService()) {
  const OAuthCtrl = createOAuthController('');
  const controller = new OAuthCtrl(flowService) as CtrlInstance;
  return { controller, flowService };
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

describe('createOAuthController()', () => {
  it('returns a class (function)', () => {
    expect(typeof createOAuthController('')).toBe('function');
  });

  it('applies @Controller with the given base path', () => {
    const Ctrl = createOAuthController('/oauth');
    expect(Reflect.getMetadata('path', Ctrl)).toBe('/oauth');
  });
});

describe('OAuthController - authorize', () => {
  let controller: CtrlInstance;
  let flowService: ReturnType<typeof makeFlowService>;
  let res: { redirect: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    res = { redirect: vi.fn() };
    ({ controller, flowService } = makeController());
  });

  afterEach(() => vi.clearAllMocks());

  it('redirects with code and state on granted outcome', async () => {
    flowService.authorize.mockResolvedValue({
      type: 'granted',
      code: 'auth-code-123',
      redirectUri: 'https://app.example.com/callback',
      state: 'random-state',
    });

    // biome-ignore lint/suspicious/noExplicitAny: test access to method
    await (controller as any).authorize(baseQuery, {}, res);

    expect(res.redirect).toHaveBeenCalledWith(
      302,
      'https://app.example.com/callback?code=auth-code-123&state=random-state',
    );
  });

  it('redirects with error params on denied outcome', async () => {
    flowService.authorize.mockResolvedValue({
      type: 'denied',
      error: 'access_denied',
      errorDescription: 'User authentication failed',
      redirectUri: 'https://app.example.com/callback',
      state: 'random-state',
    });

    // biome-ignore lint/suspicious/noExplicitAny: test access to method
    await (controller as any).authorize(baseQuery, {}, res);

    expect(res.redirect).toHaveBeenCalledWith(
      302,
      expect.stringContaining('error=access_denied'),
    );
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      expect.stringContaining('state=random-state'),
    );
  });

  it('propagates HttpException thrown by flowService (pre-redirect-uri validation)', async () => {
    const { HttpException, HttpStatus } = await import('@nestjs/common');
    flowService.authorize.mockRejectedValue(
      new HttpException({ error: 'invalid_request' }, HttpStatus.BAD_REQUEST),
    );

    // biome-ignore lint/suspicious/noExplicitAny: test access to method
    await expect((controller as any).authorize(baseQuery, {}, res)).rejects.toBeInstanceOf(HttpException);
  });

  it('passes query object and req to flowService.authorize', async () => {
    flowService.authorize.mockResolvedValue({
      type: 'granted',
      code: 'c',
      redirectUri: 'https://app.example.com/callback',
      state: 's',
    });

    const req = { headers: { authorization: 'Bearer token' } };
    // biome-ignore lint/suspicious/noExplicitAny: test access to method
    await (controller as any).authorize(baseQuery, req, res);

    expect(flowService.authorize).toHaveBeenCalledWith(baseQuery, req);
  });
});

describe('OAuthController - token', () => {
  let controller: CtrlInstance;
  let flowService: ReturnType<typeof makeFlowService>;

  beforeEach(() => {
    ({ controller, flowService } = makeController());
  });

  afterEach(() => vi.clearAllMocks());

  it('delegates to flowService.handleGrant and returns result', async () => {
    const tokenResponse = { access_token: 'at', refresh_token: 'rt', token_type: 'Bearer', expires_in: 3600 };
    flowService.handleGrant.mockResolvedValue(tokenResponse);

    // biome-ignore lint/suspicious/noExplicitAny: test access to method
    const result = await (controller as any).token({ grant_type: 'authorization_code', code: 'c', code_verifier: 'v' });

    expect(flowService.handleGrant).toHaveBeenCalledWith({ grant_type: 'authorization_code', code: 'c', code_verifier: 'v' });
    expect(result).toEqual(tokenResponse);
  });
});

describe('OAuthController - revoke', () => {
  let controller: CtrlInstance;
  let flowService: ReturnType<typeof makeFlowService>;

  beforeEach(() => {
    ({ controller, flowService } = makeController());
  });

  afterEach(() => vi.clearAllMocks());

  it('delegates to flowService.revokeToken and returns result', async () => {
    flowService.revokeToken.mockResolvedValue({ success: true });

    // biome-ignore lint/suspicious/noExplicitAny: test access to method
    const result = await (controller as any).revoke({ token: 'some-jwt' });

    expect(flowService.revokeToken).toHaveBeenCalledWith({ token: 'some-jwt' });
    expect(result).toEqual({ success: true });
  });
});

describe('OAuthController - introspect', () => {
  let controller: CtrlInstance;
  let flowService: ReturnType<typeof makeFlowService>;

  beforeEach(() => {
    ({ controller, flowService } = makeController());
  });

  afterEach(() => vi.clearAllMocks());

  it('delegates to flowService.introspectToken and returns result', async () => {
    const introspectResult = { active: true, sub: 'user-1', token_type: 'Bearer' };
    flowService.introspectToken.mockResolvedValue(introspectResult);

    // biome-ignore lint/suspicious/noExplicitAny: test access to method
    const result = await (controller as any).introspect({ token: 'valid-jwt' });

    expect(flowService.introspectToken).toHaveBeenCalledWith({ token: 'valid-jwt' });
    expect(result).toEqual(introspectResult);
  });
});

describe('OAuthController - register', () => {
  let controller: CtrlInstance;
  let flowService: ReturnType<typeof makeFlowService>;

  beforeEach(() => {
    ({ controller, flowService } = makeController());
  });

  afterEach(() => vi.clearAllMocks());

  it('delegates to flowService.registerClient and returns result', async () => {
    const fakeClient = { client_id: 'c-1', client_name: 'app', redirect_uris: ['https://app/cb'] };
    flowService.registerClient.mockResolvedValue(fakeClient);

    // biome-ignore lint/suspicious/noExplicitAny: test access to method
    const result = await (controller as any).register({ client_name: 'app', redirect_uris: ['https://app/cb'] });

    expect(flowService.registerClient).toHaveBeenCalledWith({ client_name: 'app', redirect_uris: ['https://app/cb'] });
    expect(result).toEqual(fakeClient);
  });
});
