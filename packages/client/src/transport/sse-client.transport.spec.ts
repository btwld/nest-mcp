vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: vi.fn().mockImplementation(() => ({ type: 'sse' })),
}));

import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { createSseTransport } from './sse-client.transport';

describe('createSseTransport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create SSEClientTransport with the correct URL', () => {
    createSseTransport({
      name: 'test',
      transport: 'sse',
      url: 'http://localhost:3000/sse',
    });

    const [url] = vi.mocked(SSEClientTransport).mock.calls[0];
    expect(url.toString()).toBe('http://localhost:3000/sse');
  });

  it('should pass requestInit without auth', () => {
    createSseTransport({
      name: 'test',
      transport: 'sse',
      url: 'http://localhost:3000/sse',
    });

    const [, options] = vi.mocked(SSEClientTransport).mock.calls[0];
    expect(options).toEqual({ requestInit: {} });
  });

  it('should inject auth headers when auth is provided', () => {
    createSseTransport({
      name: 'test',
      transport: 'sse',
      url: 'http://localhost:3000/sse',
      auth: { type: 'bearer', token: 'abc' },
    });

    const [, options] = vi.mocked(SSEClientTransport).mock.calls[0];
    const headers = new Headers(options?.requestInit?.headers);
    expect(headers.get('Authorization')).toBe('Bearer abc');
  });

  it('should merge existing requestInit with auth headers', () => {
    createSseTransport({
      name: 'test',
      transport: 'sse',
      url: 'http://localhost:3000/sse',
      requestInit: { method: 'POST' },
      auth: { type: 'bearer', token: 'tok' },
    });

    const [, options] = vi.mocked(SSEClientTransport).mock.calls[0];
    expect(options?.requestInit?.method).toBe('POST');
    const headers = new Headers(options?.requestInit?.headers);
    expect(headers.get('Authorization')).toBe('Bearer tok');
  });

  it('should pass authProvider to the SDK transport constructor', () => {
    const mockAuthProvider = {
      get redirectUrl() { return 'http://localhost/callback'; },
      get clientId() { return 'test-client'; },
      clientMetadata: { redirect_uris: ['http://localhost/callback'] },
      tokens: vi.fn().mockResolvedValue(undefined),
      saveTokens: vi.fn().mockResolvedValue(undefined),
      redirectToAuthorization: vi.fn().mockResolvedValue(undefined),
      saveCodeVerifier: vi.fn().mockResolvedValue(undefined),
      codeVerifier: vi.fn().mockResolvedValue('verifier'),
    };

    createSseTransport({
      name: 'test',
      transport: 'sse',
      url: 'http://localhost:3000/sse',
      authProvider: mockAuthProvider,
    });

    const [, options] = vi.mocked(SSEClientTransport).mock.calls[0];
    expect(options?.authProvider).toBe(mockAuthProvider);
  });

  it('should return the created transport', () => {
    const transport = createSseTransport({
      name: 'test',
      transport: 'sse',
      url: 'http://localhost:3000/sse',
    });

    expect(transport).toEqual({ type: 'sse' });
  });

  it('should call SSEClientTransport constructor exactly once', () => {
    createSseTransport({ name: 'a', transport: 'sse', url: 'http://a.com/sse' });
    createSseTransport({ name: 'b', transport: 'sse', url: 'http://b.com/sse' });
    expect(SSEClientTransport).toHaveBeenCalledTimes(2);
  });
});
