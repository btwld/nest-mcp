import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  const MockClient = vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  }));
  return { Client: MockClient };
});

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => {
  const MockSSE = vi.fn().mockImplementation(() => ({}));
  return { SSEClientTransport: MockSSE };
});

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => {
  const MockStreamable = vi.fn().mockImplementation(() => ({}));
  return { StreamableHTTPClientTransport: MockStreamable };
});

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => {
  const MockStdio = vi.fn().mockImplementation(() => ({}));
  return { StdioClientTransport: MockStdio };
});

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { UpstreamConfig } from './upstream.interface';
import { UpstreamManagerService } from './upstream-manager.service';

const MockedClient = vi.mocked(Client);
const MockedSSE = vi.mocked(SSEClientTransport);
const MockedStreamable = vi.mocked(StreamableHTTPClientTransport);
const MockedStdio = vi.mocked(StdioClientTransport);

describe('UpstreamManagerService', () => {
  let service: UpstreamManagerService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new UpstreamManagerService();
  });

  describe('createTransport (via connect)', () => {
    it('should create SSEClientTransport for sse transport', async () => {
      const config: UpstreamConfig = {
        name: 'sse-server',
        transport: 'sse',
        url: 'http://localhost:3000/sse',
      };

      await service.connect(config);

      expect(MockedSSE).toHaveBeenCalledWith(new URL('http://localhost:3000/sse'));
      expect(service.isConnected('sse-server')).toBe(true);
    });

    it('should create StreamableHTTPClientTransport for streamable-http transport', async () => {
      const config: UpstreamConfig = {
        name: 'http-server',
        transport: 'streamable-http',
        url: 'http://localhost:3000/mcp',
      };

      await service.connect(config);

      expect(MockedStreamable).toHaveBeenCalledWith(new URL('http://localhost:3000/mcp'));
      expect(service.isConnected('http-server')).toBe(true);
    });

    it('should support stdio transport', async () => {
      const config: UpstreamConfig = {
        name: 'stdio-server',
        transport: 'stdio',
        command: 'node',
        args: ['server.js'],
        env: { NODE_ENV: 'production' },
        cwd: '/tmp',
      };

      await service.connect(config);

      expect(MockedStdio).toHaveBeenCalledWith({
        command: 'node',
        args: ['server.js'],
        env: { NODE_ENV: 'production' },
        cwd: '/tmp',
      });
      expect(service.isConnected('stdio-server')).toBe(true);
    });

    it('should store error for stdio config missing command', async () => {
      const config: UpstreamConfig = {
        name: 'bad-stdio',
        transport: 'stdio',
      };

      await service.connect(config);

      expect(MockedStdio).not.toHaveBeenCalled();
      expect(service.isConnected('bad-stdio')).toBe(false);
      const status = service.getStatus('bad-stdio');
      expect(status?.error).toContain('missing required "command" field');
    });

    it('should store error for sse config missing url', async () => {
      const config: UpstreamConfig = {
        name: 'bad-sse',
        transport: 'sse',
      };

      await service.connect(config);

      expect(MockedSSE).not.toHaveBeenCalled();
      expect(service.isConnected('bad-sse')).toBe(false);
      const status = service.getStatus('bad-sse');
      expect(status?.error).toContain('missing required "url" field');
    });

    it('should store error for streamable-http config missing url', async () => {
      const config: UpstreamConfig = {
        name: 'bad-http',
        transport: 'streamable-http',
      };

      await service.connect(config);

      expect(MockedStreamable).not.toHaveBeenCalled();
      expect(service.isConnected('bad-http')).toBe(false);
      const status = service.getStatus('bad-http');
      expect(status?.error).toContain('missing required "url" field');
    });

    it('should throw for unsupported transport type', async () => {
      const config = {
        name: 'bad-transport',
        transport: 'websocket' as UpstreamConfig['transport'],
      } as UpstreamConfig;

      await service.connect(config);

      expect(service.isConnected('bad-transport')).toBe(false);
      const status = service.getStatus('bad-transport');
      expect(status?.error).toContain('Unsupported upstream transport');
    });
  });

  describe('connect', () => {
    it('should skip already connected upstream', async () => {
      const config: UpstreamConfig = {
        name: 'server',
        transport: 'sse',
        url: 'http://localhost:3000/sse',
      };

      await service.connect(config);
      await service.connect(config);

      expect(MockedClient).toHaveBeenCalledTimes(1);
    });
  });

  describe('connectAll', () => {
    it('should connect only enabled upstreams', async () => {
      const configs: UpstreamConfig[] = [
        { name: 'enabled', transport: 'sse', url: 'http://localhost:3000/sse' },
        { name: 'disabled', transport: 'sse', url: 'http://localhost:3001/sse', enabled: false },
      ];

      await service.connectAll(configs);

      expect(service.isConnected('enabled')).toBe(true);
      expect(service.getStatus('disabled')).toBeUndefined();
    });
  });

  describe('disconnect', () => {
    it('should close client and remove from map', async () => {
      const config: UpstreamConfig = {
        name: 'server',
        transport: 'sse',
        url: 'http://localhost:3000/sse',
      };

      await service.connect(config);
      await service.disconnect('server');

      expect(service.getClient('server')).toBeUndefined();
    });

    it('should be a no-op for unknown upstream', async () => {
      await expect(service.disconnect('nonexistent')).resolves.toBeUndefined();
    });
  });

  describe('status methods', () => {
    it('should return all statuses', async () => {
      await service.connect({ name: 'a', transport: 'sse', url: 'http://a' });
      await service.connect({ name: 'b', transport: 'sse', url: 'http://b' });

      const statuses = service.getAllStatuses();

      expect(statuses).toHaveLength(2);
      expect(statuses.map((s) => s.name)).toEqual(['a', 'b']);
    });

    it('should return undefined status for unknown upstream', () => {
      expect(service.getStatus('unknown')).toBeUndefined();
    });

    it('should update healthy state via setHealthy', async () => {
      await service.connect({ name: 'a', transport: 'sse', url: 'http://a' });

      service.setHealthy('a', false, 'timed out');

      expect(service.isHealthy('a')).toBe(false);
      expect(service.getStatus('a')?.error).toBe('timed out');
    });
  });
});
