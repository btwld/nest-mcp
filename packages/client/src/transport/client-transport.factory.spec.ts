vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: vi.fn().mockImplementation(() => ({ type: 'sse-transport' })),
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi
    .fn()
    .mockImplementation(() => ({ type: 'streamable-transport' })),
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn().mockImplementation(() => ({ type: 'stdio-transport' })),
}));

import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpClientConnection } from '../interfaces/client-options.interface';
import { createClientTransport } from './client-transport.factory';

describe('createClientTransport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create StreamableHTTPClientTransport for streamable-http', () => {
    const connection: McpClientConnection = {
      name: 'test',
      transport: 'streamable-http',
      url: 'http://localhost:3000/mcp',
    };

    const transport = createClientTransport(connection);

    expect(StreamableHTTPClientTransport).toHaveBeenCalled();
    expect(transport).toEqual({ type: 'streamable-transport' });
  });

  it('should create SSEClientTransport for sse', () => {
    const connection: McpClientConnection = {
      name: 'test',
      transport: 'sse',
      url: 'http://localhost:3000/sse',
    };

    const transport = createClientTransport(connection);

    expect(SSEClientTransport).toHaveBeenCalled();
    expect(transport).toEqual({ type: 'sse-transport' });
  });

  it('should create StdioClientTransport for stdio', () => {
    const connection: McpClientConnection = {
      name: 'test',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
    };

    const transport = createClientTransport(connection);

    expect(StdioClientTransport).toHaveBeenCalled();
    expect(transport).toEqual({ type: 'stdio-transport' });
  });

  it('should pass auth headers for streamable-http connections', () => {
    const connection: McpClientConnection = {
      name: 'test',
      transport: 'streamable-http',
      url: 'http://localhost:3000/mcp',
      auth: { type: 'bearer', token: 'secret' },
    };

    createClientTransport(connection);

    const [, options] = vi.mocked(StreamableHTTPClientTransport).mock.calls[0];
    const headers = new Headers(options?.requestInit?.headers);
    expect(headers.get('Authorization')).toBe('Bearer secret');
  });

  it('should pass auth headers for sse connections', () => {
    const connection: McpClientConnection = {
      name: 'test',
      transport: 'sse',
      url: 'http://localhost:3000/sse',
      auth: { type: 'bearer', token: 'secret' },
    };

    createClientTransport(connection);

    const [, options] = vi.mocked(SSEClientTransport).mock.calls[0];
    const headers = new Headers(options?.requestInit?.headers);
    expect(headers.get('Authorization')).toBe('Bearer secret');
  });

  it('should pass command, args, env, and cwd for stdio connections', () => {
    const connection: McpClientConnection = {
      name: 'test',
      transport: 'stdio',
      command: 'python',
      args: ['-m', 'server'],
      env: { DEBUG: '1' },
      cwd: '/tmp',
    };

    createClientTransport(connection);

    expect(StdioClientTransport).toHaveBeenCalledWith({
      command: 'python',
      args: ['-m', 'server'],
      env: { DEBUG: '1' },
      cwd: '/tmp',
    });
  });
});
