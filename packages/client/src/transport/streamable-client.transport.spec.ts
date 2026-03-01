vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn().mockImplementation(() => ({ type: 'streamable' })),
}));

import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createStreamableHttpTransport } from './streamable-client.transport';

describe('createStreamableHttpTransport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create StreamableHTTPClientTransport with the correct URL', () => {
    createStreamableHttpTransport({
      name: 'test',
      transport: 'streamable-http',
      url: 'http://localhost:3000/mcp',
    });

    const [url] = vi.mocked(StreamableHTTPClientTransport).mock.calls[0];
    expect(url.toString()).toBe('http://localhost:3000/mcp');
  });

  it('should pass requestInit without auth', () => {
    createStreamableHttpTransport({
      name: 'test',
      transport: 'streamable-http',
      url: 'http://localhost:3000/mcp',
    });

    const [, options] = vi.mocked(StreamableHTTPClientTransport).mock.calls[0];
    expect(options).toEqual({ requestInit: {} });
  });

  it('should inject auth headers when auth is provided', () => {
    createStreamableHttpTransport({
      name: 'test',
      transport: 'streamable-http',
      url: 'http://localhost:3000/mcp',
      auth: { type: 'bearer', token: 'secret' },
    });

    const [, options] = vi.mocked(StreamableHTTPClientTransport).mock.calls[0];
    const headers = new Headers(options?.requestInit?.headers);
    expect(headers.get('Authorization')).toBe('Bearer secret');
  });

  it('should merge existing requestInit with auth headers', () => {
    createStreamableHttpTransport({
      name: 'test',
      transport: 'streamable-http',
      url: 'http://localhost:3000/mcp',
      requestInit: { method: 'POST' },
      auth: { type: 'bearer', token: 'tok' },
    });

    const [, options] = vi.mocked(StreamableHTTPClientTransport).mock.calls[0];
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

    createStreamableHttpTransport({
      name: 'test',
      transport: 'streamable-http',
      url: 'http://localhost:3000/mcp',
      authProvider: mockAuthProvider,
    });

    const [, options] = vi.mocked(StreamableHTTPClientTransport).mock.calls[0];
    expect(options?.authProvider).toBe(mockAuthProvider);
  });

  it('should return the created transport', () => {
    const transport = createStreamableHttpTransport({
      name: 'test',
      transport: 'streamable-http',
      url: 'http://localhost:3000/mcp',
    });

    expect(transport).toEqual({ type: 'streamable' });
  });

  it('should call StreamableHTTPClientTransport constructor exactly once per call', () => {
    createStreamableHttpTransport({ name: 'a', transport: 'streamable-http', url: 'http://a.com/mcp' });
    createStreamableHttpTransport({ name: 'b', transport: 'streamable-http', url: 'http://b.com/mcp' });
    expect(StreamableHTTPClientTransport).toHaveBeenCalledTimes(2);
  });
});
