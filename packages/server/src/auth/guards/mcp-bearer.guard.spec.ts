import {
  InvalidClientError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { McpAuthInfo } from '@nest-mcp/common';
import { type ExecutionContext, HttpException, Logger } from '@nestjs/common';
import { MCP_BEARER_TOKEN_VERIFIER, MCP_RESOURCE_SERVER_OPTIONS } from '../auth.constants';
import type { McpResourceServerOptions } from '../interfaces/resource-server-options.interface';
import type { BearerTokenVerifier } from '../verifiers/bearer-verifier.interface';
import { McpBearerGuard } from './mcp-bearer.guard';

const RESOURCE_METADATA_URL = 'https://api.example.com/.well-known/oauth-protected-resource/mcp';

describe('McpBearerGuard', () => {
  beforeEach(() => {
    // Keep test output clean: the guard logs unexpected/unresolvable errors.
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeOptions(
    overrides: Partial<McpResourceServerOptions> = {},
  ): McpResourceServerOptions {
    return {
      resource: 'https://api.example.com/mcp',
      authorizationServers: ['https://issuer.example.com'],
      ...overrides,
    };
  }

  function makeAuthInfo(overrides: Partial<McpAuthInfo> = {}): McpAuthInfo {
    return {
      token: 'tok',
      clientId: 'client-1',
      scopes: ['read', 'write'],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      ...overrides,
    };
  }

  function makeGuard(
    options: McpResourceServerOptions,
    verifier: BearerTokenVerifier,
  ): { guard: McpBearerGuard; moduleRef: { get: ReturnType<typeof vi.fn> } } {
    const moduleRef = {
      get: vi.fn((token: symbol) => (token === MCP_RESOURCE_SERVER_OPTIONS ? options : verifier)),
    };
    const guard = new McpBearerGuard(
      moduleRef as unknown as ConstructorParameters<typeof McpBearerGuard>[0],
    );
    return { guard, moduleRef };
  }

  function makeContext(req: unknown, res: unknown): ExecutionContext {
    return {
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    } as never;
  }

  function makeExpressRes(): { setHeader: ReturnType<typeof vi.fn> } {
    return { setHeader: vi.fn() };
  }

  async function expectHttpException(promise: Promise<unknown>): Promise<HttpException> {
    try {
      await promise;
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
      return err as HttpException;
    }
    throw new Error('Expected guard to throw an HttpException');
  }

  // --- Missing / malformed Authorization header ---

  it('rejects a missing Authorization header with 401 invalid_token and the exact SDK challenge', async () => {
    const verifier = { verify: vi.fn() };
    const { guard } = makeGuard(makeOptions(), verifier);
    const res = makeExpressRes();

    const err = await expectHttpException(guard.canActivate(makeContext({ headers: {} }, res)));

    expect(err.getStatus()).toBe(401);
    expect(err.getResponse()).toEqual({
      error: 'invalid_token',
      error_description: 'Missing Authorization header',
    });
    expect(res.setHeader).toHaveBeenCalledWith(
      'WWW-Authenticate',
      `Bearer error="invalid_token", error_description="Missing Authorization header", resource_metadata="${RESOURCE_METADATA_URL}"`,
    );
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it('rejects a non-Bearer scheme with 401 and the exact format error', async () => {
    const verifier = { verify: vi.fn() };
    const { guard } = makeGuard(makeOptions(), verifier);
    const res = makeExpressRes();
    const req = { headers: { authorization: 'Basic abc' } };

    const err = await expectHttpException(guard.canActivate(makeContext(req, res)));

    expect(err.getStatus()).toBe(401);
    expect(err.getResponse()).toEqual({
      error: 'invalid_token',
      error_description: "Invalid Authorization header format, expected 'Bearer TOKEN'",
    });
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it('rejects a Bearer header without a token with 401 format error', async () => {
    const verifier = { verify: vi.fn() };
    const { guard } = makeGuard(makeOptions(), verifier);
    const req = { headers: { authorization: 'Bearer' } };

    const err = await expectHttpException(guard.canActivate(makeContext(req, makeExpressRes())));

    expect(err.getStatus()).toBe(401);
    expect(err.getResponse()).toEqual({
      error: 'invalid_token',
      error_description: "Invalid Authorization header format, expected 'Bearer TOKEN'",
    });
  });

  it('accepts a lowercase "bearer" scheme and passes the token to the verifier', async () => {
    const authInfo = makeAuthInfo();
    const verifier = { verify: vi.fn().mockResolvedValue(authInfo) };
    const { guard } = makeGuard(makeOptions(), verifier);
    const req: { headers: Record<string, string>; auth?: McpAuthInfo } = {
      headers: { authorization: 'bearer tok' },
    };

    await expect(guard.canActivate(makeContext(req, makeExpressRes()))).resolves.toBe(true);
    expect(verifier.verify).toHaveBeenCalledWith('tok');
  });

  it('uses the first element when the authorization header is an array', async () => {
    const authInfo = makeAuthInfo();
    const verifier = { verify: vi.fn().mockResolvedValue(authInfo) };
    const { guard } = makeGuard(makeOptions(), verifier);
    const req = { headers: { authorization: ['Bearer first-token', 'Bearer second-token'] } };

    await expect(guard.canActivate(makeContext(req, makeExpressRes()))).resolves.toBe(true);
    expect(verifier.verify).toHaveBeenCalledWith('first-token');
  });

  // --- Verifier outcomes ---

  it('rejects with 401 "Invalid or expired token" when the verifier returns null', async () => {
    const verifier = { verify: vi.fn().mockResolvedValue(null) };
    const { guard } = makeGuard(makeOptions(), verifier);
    const res = makeExpressRes();
    const req = { headers: { authorization: 'Bearer bad-token' } };

    const err = await expectHttpException(guard.canActivate(makeContext(req, res)));

    expect(err.getStatus()).toBe(401);
    expect(err.getResponse()).toEqual({
      error: 'invalid_token',
      error_description: 'Invalid or expired token',
    });
    expect(res.setHeader).toHaveBeenCalledWith(
      'WWW-Authenticate',
      `Bearer error="invalid_token", error_description="Invalid or expired token", resource_metadata="${RESOURCE_METADATA_URL}"`,
    );
  });

  it('propagates an InvalidTokenError thrown by the verifier as 401 with its message', async () => {
    const verifier = { verify: vi.fn().mockRejectedValue(new InvalidTokenError('custom msg')) };
    const { guard } = makeGuard(makeOptions(), verifier);
    const res = makeExpressRes();
    const req = { headers: { authorization: 'Bearer tok' } };

    const err = await expectHttpException(guard.canActivate(makeContext(req, res)));

    expect(err.getStatus()).toBe(401);
    expect(err.getResponse()).toEqual({
      error: 'invalid_token',
      error_description: 'custom msg',
    });
    expect(res.setHeader).toHaveBeenCalledWith(
      'WWW-Authenticate',
      `Bearer error="invalid_token", error_description="custom msg", resource_metadata="${RESOURCE_METADATA_URL}"`,
    );
  });

  it('maps a generic verifier error to 500 server_error', async () => {
    const verifier = { verify: vi.fn().mockRejectedValue(new Error('boom')) };
    const { guard } = makeGuard(makeOptions(), verifier);
    const res = makeExpressRes();
    const req = { headers: { authorization: 'Bearer tok' } };

    const err = await expectHttpException(guard.canActivate(makeContext(req, res)));

    expect(err.getStatus()).toBe(500);
    expect(err.getResponse()).toEqual({
      error: 'server_error',
      error_description: 'Internal Server Error',
    });
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it('maps other OAuthError subclasses (InvalidClientError) to 400', async () => {
    const verifier = {
      verify: vi.fn().mockRejectedValue(new InvalidClientError('client auth failed')),
    };
    const { guard } = makeGuard(makeOptions(), verifier);
    const res = makeExpressRes();
    const req = { headers: { authorization: 'Bearer tok' } };

    const err = await expectHttpException(guard.canActivate(makeContext(req, res)));

    expect(err.getStatus()).toBe(400);
    expect(err.getResponse()).toEqual({
      error: 'invalid_client',
      error_description: 'client auth failed',
    });
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  // --- Scopes ---

  it('rejects with 403 insufficient_scope when required scopes are missing', async () => {
    const authInfo = makeAuthInfo({ scopes: ['read'] });
    const verifier = { verify: vi.fn().mockResolvedValue(authInfo) };
    const { guard } = makeGuard(makeOptions({ requiredScopes: ['read', 'write'] }), verifier);
    const res = makeExpressRes();
    const req = { headers: { authorization: 'Bearer tok' } };

    const err = await expectHttpException(guard.canActivate(makeContext(req, res)));

    expect(err.getStatus()).toBe(403);
    expect(err.getResponse()).toEqual({
      error: 'insufficient_scope',
      error_description: 'Insufficient scope',
    });
    expect(res.setHeader).toHaveBeenCalledWith(
      'WWW-Authenticate',
      `Bearer error="insufficient_scope", error_description="Insufficient scope", scope="read write", resource_metadata="${RESOURCE_METADATA_URL}"`,
    );
  });

  it('includes scope in the 401 invalid_token challenge when requiredScopes are configured (SDK byte-compat)', async () => {
    const verifier = { verify: vi.fn() };
    const { guard } = makeGuard(makeOptions({ requiredScopes: ['read', 'write'] }), verifier);
    const res = makeExpressRes();

    const err = await expectHttpException(guard.canActivate(makeContext({ headers: {} }, res)));

    expect(err.getStatus()).toBe(401);
    expect(res.setHeader).toHaveBeenCalledWith(
      'WWW-Authenticate',
      `Bearer error="invalid_token", error_description="Missing Authorization header", scope="read write", resource_metadata="${RESOURCE_METADATA_URL}"`,
    );
    expect(res.setHeader.mock.calls[0][1]).toContain(', scope="read write", resource_metadata=');
  });

  it('passes when the token carries all required scopes', async () => {
    const authInfo = makeAuthInfo({ scopes: ['read', 'write', 'admin'] });
    const verifier = { verify: vi.fn().mockResolvedValue(authInfo) };
    const { guard } = makeGuard(makeOptions({ requiredScopes: ['read', 'write'] }), verifier);
    const req: { headers: Record<string, string>; auth?: McpAuthInfo } = {
      headers: { authorization: 'Bearer tok' },
    };

    await expect(guard.canActivate(makeContext(req, makeExpressRes()))).resolves.toBe(true);
  });

  // --- Expiry ---

  it('rejects with 401 when authInfo has no expiresAt', async () => {
    const authInfo = makeAuthInfo({ expiresAt: undefined });
    const verifier = { verify: vi.fn().mockResolvedValue(authInfo) };
    const { guard } = makeGuard(makeOptions(), verifier);
    const req = { headers: { authorization: 'Bearer tok' } };

    const err = await expectHttpException(guard.canActivate(makeContext(req, makeExpressRes())));

    expect(err.getStatus()).toBe(401);
    expect(err.getResponse()).toEqual({
      error: 'invalid_token',
      error_description: 'Token has no expiration time',
    });
  });

  it('rejects with 401 when expiresAt is NaN', async () => {
    const authInfo = makeAuthInfo({ expiresAt: Number.NaN });
    const verifier = { verify: vi.fn().mockResolvedValue(authInfo) };
    const { guard } = makeGuard(makeOptions(), verifier);
    const req = { headers: { authorization: 'Bearer tok' } };

    const err = await expectHttpException(guard.canActivate(makeContext(req, makeExpressRes())));

    expect(err.getStatus()).toBe(401);
    expect(err.getResponse()).toEqual({
      error: 'invalid_token',
      error_description: 'Token has no expiration time',
    });
  });

  it('rejects with 401 when the token has expired', async () => {
    const authInfo = makeAuthInfo({ expiresAt: Math.floor(Date.now() / 1000) - 60 });
    const verifier = { verify: vi.fn().mockResolvedValue(authInfo) };
    const { guard } = makeGuard(makeOptions(), verifier);
    const req = { headers: { authorization: 'Bearer tok' } };

    const err = await expectHttpException(guard.canActivate(makeContext(req, makeExpressRes())));

    expect(err.getStatus()).toBe(401);
    expect(err.getResponse()).toEqual({
      error: 'invalid_token',
      error_description: 'Token has expired',
    });
  });

  // --- Success ---

  it('resolves true and attaches the verified identity to req.auth', async () => {
    const authInfo = makeAuthInfo();
    const verifier = { verify: vi.fn().mockResolvedValue(authInfo) };
    const { guard } = makeGuard(makeOptions(), verifier);
    const res = makeExpressRes();
    const req: { headers: Record<string, string>; auth?: McpAuthInfo } = {
      headers: { authorization: 'Bearer tok' },
    };

    await expect(guard.canActivate(makeContext(req, res))).resolves.toBe(true);
    expect(req.auth).toBe(authInfo);
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  // --- Optional auth (required: false) ---

  it('passes anonymously without calling the verifier when required is false and no header is sent', async () => {
    const verifier = { verify: vi.fn() };
    const { guard } = makeGuard(makeOptions({ required: false }), verifier);
    const req: { headers: Record<string, string>; auth?: McpAuthInfo } = { headers: {} };

    await expect(guard.canActivate(makeContext(req, makeExpressRes()))).resolves.toBe(true);
    expect(verifier.verify).not.toHaveBeenCalled();
    expect(req.auth).toBeUndefined();
  });

  it('still rejects a present-but-invalid token with 401 when required is false', async () => {
    const verifier = { verify: vi.fn().mockResolvedValue(null) };
    const { guard } = makeGuard(makeOptions({ required: false }), verifier);
    const req = { headers: { authorization: 'Bearer bad-token' } };

    const err = await expectHttpException(guard.canActivate(makeContext(req, makeExpressRes())));

    expect(err.getStatus()).toBe(401);
    expect(err.getResponse()).toEqual({
      error: 'invalid_token',
      error_description: 'Invalid or expired token',
    });
  });

  // --- Fastify response shape ---

  it('sets the challenge through res.header on Fastify-shaped responses', async () => {
    const verifier = { verify: vi.fn() };
    const { guard } = makeGuard(makeOptions(), verifier);
    const res = { header: vi.fn() };

    const err = await expectHttpException(guard.canActivate(makeContext({ headers: {} }, res)));

    expect(err.getStatus()).toBe(401);
    expect(res.header).toHaveBeenCalledWith(
      'WWW-Authenticate',
      `Bearer error="invalid_token", error_description="Missing Authorization header", resource_metadata="${RESOURCE_METADATA_URL}"`,
    );
  });

  // --- DI resolution failure ---

  it('throws 500 server_error when the options token cannot be resolved', async () => {
    const moduleRef = {
      get: vi.fn(() => {
        throw new Error('not found');
      }),
    };
    const guard = new McpBearerGuard(
      moduleRef as unknown as ConstructorParameters<typeof McpBearerGuard>[0],
    );
    const req = { headers: { authorization: 'Bearer tok' } };

    const err = await expectHttpException(guard.canActivate(makeContext(req, makeExpressRes())));

    expect(err.getStatus()).toBe(500);
    expect(err.getResponse()).toEqual({
      error: 'server_error',
      error_description: 'Internal Server Error',
    });
    expect(moduleRef.get).toHaveBeenCalledWith(MCP_RESOURCE_SERVER_OPTIONS, { strict: false });
  });

  it('throws a flat 500 server_error when the verifier token cannot be resolved mid-request', async () => {
    const options = makeOptions();
    const moduleRef = {
      get: vi.fn((token: symbol) => {
        if (token === MCP_RESOURCE_SERVER_OPTIONS) return options;
        throw new Error('verifier not found');
      }),
    };
    const guard = new McpBearerGuard(
      moduleRef as unknown as ConstructorParameters<typeof McpBearerGuard>[0],
    );
    const res = makeExpressRes();
    const req = { headers: { authorization: 'Bearer tok' } };

    const err = await expectHttpException(guard.canActivate(makeContext(req, res)));

    expect(err.getStatus()).toBe(500);
    expect(err.getResponse()).toEqual({
      error: 'server_error',
      error_description: 'Internal Server Error',
    });
    expect(moduleRef.get).toHaveBeenCalledWith(MCP_BEARER_TOKEN_VERIFIER, { strict: false });
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it('resolves the verifier through the MCP_BEARER_TOKEN_VERIFIER token', async () => {
    const authInfo = makeAuthInfo();
    const verifier = { verify: vi.fn().mockResolvedValue(authInfo) };
    const { guard, moduleRef } = makeGuard(makeOptions(), verifier);
    const req = { headers: { authorization: 'Bearer tok' } };

    await expect(guard.canActivate(makeContext(req, makeExpressRes()))).resolves.toBe(true);
    expect(moduleRef.get).toHaveBeenCalledWith(MCP_BEARER_TOKEN_VERIFIER, { strict: false });
  });
});
