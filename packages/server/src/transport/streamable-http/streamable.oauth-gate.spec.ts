import 'reflect-metadata';
import type { McpModuleOptions } from '@nest-mcp/common';
import { McpTransportType } from '@nest-mcp/common';
import * as jwt from 'jsonwebtoken';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JwtBearerTokenVerifier } from '../../auth/services/bearer-verifier.service';
import { JwtTokenService } from '../../auth/services/jwt-token.service';
import { MemoryOAuthStore } from '../../auth/stores/memory-store.service';
import { StreamableHttpService } from './streamable.service';

// ---------------------------------------------------------------------------
// Same SDK/module mocks as streamable.service.spec.ts — but the bearer
// verification stack (JwtTokenService → JwtBearerTokenVerifier →
// MemoryOAuthStore) is REAL, so this spec smoke-tests the oauth gate with
// actually minted, revoked, and tampered JWTs instead of a mocked verifier.
// ---------------------------------------------------------------------------

const hoisted = vi.hoisted(() => ({
  transports: [] as Array<{
    sessionId: string | undefined;
    handleRequest: (...args: unknown[]) => Promise<void>;
    close: () => Promise<void>;
  }>,
}));

vi.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => {
  class FakeStreamableTransport {
    options: Record<string, unknown>;
    sessionId: string | undefined;
    onclose?: () => void;
    handleRequest = vi.fn(async () => {
      const generate = this.options.sessionIdGenerator as (() => string) | undefined;
      if (generate && !this.sessionId) this.sessionId = generate();
    });
    close = vi.fn(async () => {});

    constructor(options: Record<string, unknown>) {
      this.options = options;
      hoisted.transports.push(this as never);
    }
  }
  return { StreamableHTTPServerTransport: FakeStreamableTransport };
});

vi.mock('../../server/server.factory', () => ({
  createMcpServer: vi.fn(() => ({
    connect: vi.fn(),
    close: vi.fn(async () => {}),
    server: { notification: vi.fn().mockResolvedValue(undefined) },
  })),
}));

vi.mock('../register-handlers', () => ({
  registerHandlers: vi.fn(),
  registerToolOnServer: vi.fn(() => ({ remove: vi.fn() })),
  registerResourceOnServer: vi.fn(() => ({ remove: vi.fn() })),
  registerResourceTemplateOnServer: vi.fn(() => ({ remove: vi.fn() })),
  registerPromptOnServer: vi.fn(() => ({ remove: vi.fn() })),
}));

const JWT_SECRET = 'oauth-gate-smoke-secret-key-at-least-32-chars';

function makeOptions(): McpModuleOptions {
  return {
    name: 'oauth-gate-smoke',
    version: '1.0.0',
    transport: McpTransportType.STREAMABLE_HTTP,
    transportOptions: {
      streamableHttp: {
        sessionIdGenerator: () => 'sess-1',
        oauth: { enabled: true },
      },
    },
  };
}

function makeService() {
  const jwtService = new JwtTokenService({ jwtSecret: JWT_SECRET });
  const store = new MemoryOAuthStore();
  const verifier = new JwtBearerTokenVerifier(jwtService, store);

  const service = new StreamableHttpService(
    makeOptions(),
    { events: { on: vi.fn() } } as never,
    {} as never,
    {} as never,
    {
      createContext: vi.fn((args: Record<string, unknown>) => ({ ...args, metadata: {} })),
    } as never,
    { get: vi.fn(() => verifier) } as never,
    undefined,
    undefined,
  );
  return { service, jwtService, store };
}

interface ExpressRes {
  headersSent: boolean;
  statusCode?: number;
  body?: unknown;
  on: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
  status: (code: number) => { json: (body: unknown) => void; end: () => void };
}

function makeRes(): ExpressRes {
  const res: ExpressRes = {
    headersSent: false,
    on: vi.fn(),
    setHeader: vi.fn(),
    status: (code: number) => {
      res.statusCode = code;
      return {
        json: (body: unknown) => {
          res.body = body;
          res.headersSent = true;
        },
        end: () => {
          res.headersSent = true;
        },
      };
    },
  };
  return res;
}

function makeReq(headers: Record<string, string> = {}) {
  return { headers: { host: 'api.example.com', ...headers } } as {
    headers: Record<string, string>;
    auth?: { clientId: string; scopes: string[]; extra?: Record<string, unknown> };
  };
}

describe('streamable HTTP oauth gate with the real JWT verifier (smoke)', () => {
  beforeEach(() => {
    hoisted.transports.length = 0;
  });

  it('responds 401 with a WWW-Authenticate challenge when no bearer token is sent', async () => {
    const { service } = makeService();
    const res = makeRes();

    await service.handlePostRequest(makeReq(), res);

    expect(res.statusCode).toBe(401);
    expect(res.setHeader).toHaveBeenCalledWith(
      'WWW-Authenticate',
      'Bearer realm="mcp", resource_metadata="https://api.example.com/.well-known/oauth-protected-resource/mcp"',
    );
    expect(res.body).toEqual({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Unauthorized' },
      id: null,
    });
    expect(hoisted.transports).toHaveLength(0);
  });

  it('responds 401 for a token signed with the wrong secret', async () => {
    const { service } = makeService();
    const forged = jwt.sign({ sub: 'u', type: 'access' }, 'wrong-secret', { algorithm: 'HS256' });
    const res = makeRes();

    await service.handlePostRequest(makeReq({ authorization: `Bearer ${forged}` }), res);

    expect(res.statusCode).toBe(401);
    expect(res.setHeader).toHaveBeenCalledWith('WWW-Authenticate', expect.any(String));
  });

  it('admits a freshly minted access token and attaches the verified identity', async () => {
    const { service, jwtService } = makeService();
    const { access_token } = jwtService.generateTokenPair('user-1', 'client-1', 'tools:read');
    const req = makeReq({ authorization: `Bearer ${access_token}` });
    const res = makeRes();

    await service.handlePostRequest(req, res);

    expect(res.statusCode).toBeUndefined();
    expect(req.auth).toMatchObject({
      clientId: 'client-1',
      scopes: ['tools:read'],
      extra: { sub: 'user-1' },
    });
    expect(hoisted.transports).toHaveLength(1);
    expect(hoisted.transports[0].handleRequest).toHaveBeenCalledTimes(1);
  });

  it('rejects a minted access token after its jti is revoked', async () => {
    const { service, jwtService, store } = makeService();
    const { access_token } = jwtService.generateTokenPair('user-1', 'client-1');
    const { jti } = jwt.decode(access_token) as { jti: string };
    await store.revokeToken(jti);
    const res = makeRes();

    await service.handlePostRequest(makeReq({ authorization: `Bearer ${access_token}` }), res);

    expect(res.statusCode).toBe(401);
    expect(hoisted.transports).toHaveLength(0);
  });

  it('rejects a refresh token presented as a bearer token', async () => {
    const { service, jwtService } = makeService();
    const { refresh_token } = jwtService.generateTokenPair('user-1', 'client-1');
    const res = makeRes();

    await service.handlePostRequest(makeReq({ authorization: `Bearer ${refresh_token}` }), res);

    expect(res.statusCode).toBe(401);
  });

  it('binds the session to the minted token principal and rejects another real principal', async () => {
    const { service, jwtService } = makeService();
    const owner = jwtService.generateTokenPair('user-1', 'client-1').access_token;
    const intruder = jwtService.generateTokenPair('user-2', 'client-2').access_token;

    // Initialize the session as user-1 (FakeStreamableTransport assigns sess-1).
    await service.handlePostRequest(makeReq({ authorization: `Bearer ${owner}` }), makeRes());

    const forbidden = makeRes();
    await service.handlePostRequest(
      makeReq({ authorization: `Bearer ${intruder}`, 'mcp-session-id': 'sess-1' }),
      forbidden,
    );
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.body).toEqual({ error: 'Session does not belong to this principal' });

    const allowed = makeRes();
    await service.handlePostRequest(
      makeReq({ authorization: `Bearer ${owner}`, 'mcp-session-id': 'sess-1' }),
      allowed,
    );
    expect(allowed.statusCode).toBeUndefined();
    expect(hoisted.transports[0].handleRequest).toHaveBeenCalledTimes(2);
  });
});
