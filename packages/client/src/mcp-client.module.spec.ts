import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  const MockClient = vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    callTool: vi.fn(),
    readResource: vi.fn(),
    listTools: vi.fn(),
    listResources: vi.fn(),
    getPrompt: vi.fn(),
    listPrompts: vi.fn(),
    ping: vi.fn(),
    getServerCapabilities: vi.fn(),
    getServerVersion: vi.fn(),
  }));
  return { Client: MockClient };
});

vi.mock('./transport/client-transport.factory', () => ({
  createClientTransport: vi.fn().mockReturnValue({
    onclose: null,
    onerror: null,
    close: vi.fn().mockResolvedValue(undefined),
  }),
}));

import { MCP_CLIENT_OPTIONS } from '@btwld/mcp-common';
import { getMcpClientToken } from './decorators/inject-mcp-client.decorator';
import type {
  McpClientSseConnection,
  McpClientStdioConnection,
} from './interfaces/client-options.interface';
import { McpClientBootstrap, McpClientModule } from './mcp-client.module';
import type { McpClient } from './mcp-client.service';

interface DynamicProvider {
  provide: unknown;
  useFactory?: (...args: unknown[]) => unknown;
  useValue?: unknown;
  inject?: unknown[];
}

describe('McpClientModule', () => {
  describe('forRoot', () => {
    it('includes McpClientBootstrap provider', () => {
      const mod = McpClientModule.forRoot({
        connections: [
          {
            name: 'server-a',
            transport: 'sse',
            url: 'http://localhost:3000/sse',
          } satisfies McpClientSseConnection,
        ],
      });

      const bootstrapProvider = (mod.providers as DynamicProvider[]).find(
        (p) => p.provide === McpClientBootstrap,
      );
      expect(bootstrapProvider).toBeDefined();
      expect(bootstrapProvider?.useFactory).toBeTypeOf('function');
      expect(bootstrapProvider?.inject).toContain('MCP_CLIENT_CONNECTIONS');
    });

    it('includes MCP_CLIENT_CONNECTIONS aggregate provider', () => {
      const mod = McpClientModule.forRoot({
        connections: [
          {
            name: 'server-a',
            transport: 'sse',
            url: 'http://localhost:3000/sse',
          } satisfies McpClientSseConnection,
        ],
      });

      const connectionsProvider = (mod.providers as DynamicProvider[]).find(
        (p) => p.provide === 'MCP_CLIENT_CONNECTIONS',
      );
      expect(connectionsProvider).toBeDefined();
    });

    it('creates per-connection providers', () => {
      const mod = McpClientModule.forRoot({
        connections: [
          {
            name: 'server-a',
            transport: 'sse',
            url: 'http://localhost:3000/sse',
          } satisfies McpClientSseConnection,
          {
            name: 'server-b',
            transport: 'stdio',
            command: 'node',
          } satisfies McpClientStdioConnection,
        ],
      });

      const tokenA = getMcpClientToken('server-a');
      const tokenB = getMcpClientToken('server-b');

      const providerA = (mod.providers as DynamicProvider[]).find((p) => p.provide === tokenA);
      const providerB = (mod.providers as DynamicProvider[]).find((p) => p.provide === tokenB);

      expect(providerA).toBeDefined();
      expect(providerB).toBeDefined();
    });
  });

  describe('forRootAsync', () => {
    it('includes McpClientBootstrap provider', () => {
      const mod = McpClientModule.forRootAsync({
        useFactory: () => ({
          connections: [
            {
              name: 'server-a',
              transport: 'sse',
              url: 'http://localhost:3000/sse',
            } satisfies McpClientSseConnection,
          ],
        }),
      });

      const bootstrapProvider = (mod.providers as DynamicProvider[]).find(
        (p) => p.provide === McpClientBootstrap,
      );
      expect(bootstrapProvider).toBeDefined();
      expect(bootstrapProvider?.useFactory).toBeTypeOf('function');
      expect(bootstrapProvider?.inject).toContain('MCP_CLIENT_CONNECTIONS');
    });

    it('includes MCP_CLIENT_CONNECTIONS provider', () => {
      const mod = McpClientModule.forRootAsync({
        useFactory: () => ({
          connections: [
            {
              name: 'server-a',
              transport: 'sse',
              url: 'http://localhost:3000/sse',
            } satisfies McpClientSseConnection,
          ],
        }),
      });

      const connectionsProvider = (mod.providers as DynamicProvider[]).find(
        (p) => p.provide === 'MCP_CLIENT_CONNECTIONS',
      );
      expect(connectionsProvider).toBeDefined();
    });
  });
});

describe('McpClientBootstrap', () => {
  let bootstrap: McpClientBootstrap;
  let mockClients: McpClient[];

  beforeEach(() => {
    mockClients = [
      {
        name: 'a',
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
      } as unknown as McpClient,
      {
        name: 'b',
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
      } as unknown as McpClient,
    ];
    bootstrap = new McpClientBootstrap(mockClients);
  });

  it('connects all clients on application bootstrap', async () => {
    await bootstrap.onApplicationBootstrap();

    expect(mockClients[0].connect).toHaveBeenCalled();
    expect(mockClients[1].connect).toHaveBeenCalled();
  });

  it('disconnects all clients on application shutdown', async () => {
    await bootstrap.onApplicationShutdown();

    expect(mockClients[0].disconnect).toHaveBeenCalled();
    expect(mockClients[1].disconnect).toHaveBeenCalled();
  });

  it('continues connecting remaining clients if one fails', async () => {
    vi.mocked(mockClients[0].connect).mockRejectedValue(new Error('fail'));

    await bootstrap.onApplicationBootstrap();

    expect(mockClients[0].connect).toHaveBeenCalled();
    expect(mockClients[1].connect).toHaveBeenCalled();
  });

  it('continues disconnecting remaining clients if one fails', async () => {
    vi.mocked(mockClients[0].disconnect).mockRejectedValue(new Error('fail'));

    await bootstrap.onApplicationShutdown();

    expect(mockClients[0].disconnect).toHaveBeenCalled();
    expect(mockClients[1].disconnect).toHaveBeenCalled();
  });
});
