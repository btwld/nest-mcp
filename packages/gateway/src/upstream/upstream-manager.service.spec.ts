import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  const MockClient = vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    setRequestHandler: vi.fn(),
    setNotificationHandler: vi.fn(),
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
import { UpstreamManagerService } from './upstream-manager.service';
import type { UpstreamConfig } from './upstream.interface';

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

    it('logs a warning and still removes upstream when client.close() throws', async () => {
      const config: UpstreamConfig = {
        name: 'err-server',
        transport: 'sse',
        url: 'http://localhost/sse',
      };
      await service.connect(config);

      // Make the mock client's close() reject
      const mockClient = MockedClient.mock.results[MockedClient.mock.results.length - 1].value;
      mockClient.close.mockRejectedValueOnce(new Error('close failed'));

      // Should resolve without throwing
      await expect(service.disconnect('err-server')).resolves.toBeUndefined();

      // Upstream should have been removed
      expect(service.getClient('err-server')).toBeUndefined();
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

  describe('accessors', () => {
    it('getAllNames returns names of all connected upstreams', async () => {
      await service.connect({ name: 'alpha', transport: 'sse', url: 'http://alpha' });
      await service.connect({ name: 'beta', transport: 'sse', url: 'http://beta' });

      expect(service.getAllNames()).toEqual(['alpha', 'beta']);
    });

    it('getConfig returns the config for a connected upstream', async () => {
      const config: UpstreamConfig = { name: 'cfg-server', transport: 'sse', url: 'http://x' };
      await service.connect(config);

      expect(service.getConfig('cfg-server')).toBe(config);
    });

    it('getConfig returns undefined for unknown upstream', () => {
      expect(service.getConfig('nonexistent')).toBeUndefined();
    });

    it('getAllConfigs returns configs of all upstreams', async () => {
      const c1: UpstreamConfig = { name: 'a', transport: 'sse', url: 'http://a' };
      const c2: UpstreamConfig = { name: 'b', transport: 'sse', url: 'http://b' };
      await service.connect(c1);
      await service.connect(c2);

      const configs = service.getAllConfigs();
      expect(configs).toHaveLength(2);
      expect(configs).toContain(c1);
      expect(configs).toContain(c2);
    });

    it('getManaged returns the managed upstream', async () => {
      await service.connect({ name: 'managed-server', transport: 'sse', url: 'http://m' });

      const managed = service.getManaged('managed-server');
      expect(managed).toBeDefined();
      expect(managed?.config.name).toBe('managed-server');
      expect(managed?.connected).toBe(true);
    });

    it('getManaged returns undefined for unknown upstream', () => {
      expect(service.getManaged('nonexistent')).toBeUndefined();
    });

    it('setHealthy is a no-op for unknown upstream', () => {
      expect(() => service.setHealthy('nonexistent', false, 'err')).not.toThrow();
    });
  });

  describe('disconnectAll', () => {
    it('disconnects all connected upstreams', async () => {
      await service.connect({ name: 'x', transport: 'sse', url: 'http://x' });
      await service.connect({ name: 'y', transport: 'sse', url: 'http://y' });

      await service.disconnectAll();

      expect(service.getClient('x')).toBeUndefined();
      expect(service.getClient('y')).toBeUndefined();
    });

    it('onModuleDestroy calls disconnectAll', async () => {
      await service.connect({ name: 'z', transport: 'sse', url: 'http://z' });

      await service.onModuleDestroy();

      expect(service.getClient('z')).toBeUndefined();
    });
  });

  describe('sampling forwarder', () => {
    it('activateSampling stores forwarder and deactivateSampling removes it', () => {
      const forwarder = vi.fn();

      service.activateSampling('my-upstream', forwarder);
      // Access private field via any cast for assertion
      expect(
        (service as unknown as { samplingForwarders: Map<string, unknown> }).samplingForwarders.has(
          'my-upstream',
        ),
      ).toBe(true);

      service.deactivateSampling('my-upstream');
      expect(
        (service as unknown as { samplingForwarders: Map<string, unknown> }).samplingForwarders.has(
          'my-upstream',
        ),
      ).toBe(false);
    });

    it('throws when upstream requests sampling but no forwarder is active', async () => {
      const config: UpstreamConfig = {
        name: 'sampling-upstream',
        transport: 'sse',
        url: 'http://localhost:3000/sse',
      };
      await service.connect(config);

      const instance = MockedClient.mock.results[MockedClient.mock.results.length - 1].value;
      // First setRequestHandler call is for sampling (CreateMessageRequestSchema)
      const [, samplingHandler] = instance.setRequestHandler.mock.calls[0] as [
        unknown,
        (req: unknown) => Promise<unknown>,
      ];

      await expect(samplingHandler({})).rejects.toThrow(
        'Upstream "sampling-upstream" requested sampling but no downstream client context is active',
      );
    });

    it('forwards sampling request to active forwarder and returns result', async () => {
      const config: UpstreamConfig = {
        name: 'sampling-upstream',
        transport: 'sse',
        url: 'http://localhost:3000/sse',
      };
      await service.connect(config);

      const samplingResult = {
        role: 'assistant' as const,
        content: { type: 'text', text: 'hello' },
        model: 'claude-3',
        stopReason: 'end_turn',
      };
      const forwarder = vi.fn().mockResolvedValue(samplingResult);
      service.activateSampling('sampling-upstream', forwarder);

      const instance = MockedClient.mock.results[MockedClient.mock.results.length - 1].value;
      const [, samplingHandler] = instance.setRequestHandler.mock.calls[0] as [
        unknown,
        (req: { params: unknown }) => Promise<unknown>,
      ];

      const params = {
        messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }],
        maxTokens: 100,
      };
      const result = await samplingHandler({ params });

      expect(forwarder).toHaveBeenCalledWith(params);
      expect(result).toEqual({
        role: 'assistant',
        content: { type: 'text', text: 'hello' },
        model: 'claude-3',
        stopReason: 'end_turn',
      });
    });
  });

  describe('elicitation forwarder', () => {
    it('activateElicitation stores forwarder and deactivateElicitation removes it', () => {
      const forwarder = vi.fn();

      service.activateElicitation('my-upstream', forwarder);
      expect(
        (service as unknown as { elicitForwarders: Map<string, unknown> }).elicitForwarders.has(
          'my-upstream',
        ),
      ).toBe(true);

      service.deactivateElicitation('my-upstream');
      expect(
        (service as unknown as { elicitForwarders: Map<string, unknown> }).elicitForwarders.has(
          'my-upstream',
        ),
      ).toBe(false);
    });

    it('throws when upstream requests elicitation but no forwarder is active', async () => {
      const config: UpstreamConfig = {
        name: 'elicit-upstream',
        transport: 'sse',
        url: 'http://localhost:3000/sse',
      };
      await service.connect(config);

      const instance = MockedClient.mock.results[MockedClient.mock.results.length - 1].value;
      // Second setRequestHandler call is for elicitation (ElicitRequestSchema)
      const [, elicitHandler] = instance.setRequestHandler.mock.calls[1] as [
        unknown,
        (req: unknown) => Promise<unknown>,
      ];

      await expect(elicitHandler({})).rejects.toThrow(
        'Upstream "elicit-upstream" requested elicitation but no downstream client context is active',
      );
    });

    it('forwards elicitation request to active forwarder and returns result', async () => {
      const config: UpstreamConfig = {
        name: 'elicit-upstream',
        transport: 'sse',
        url: 'http://localhost:3000/sse',
      };
      await service.connect(config);

      const elicitResult = { action: 'accept' as const, content: {} };
      const forwarder = vi.fn().mockResolvedValue(elicitResult);
      service.activateElicitation('elicit-upstream', forwarder);

      const instance = MockedClient.mock.results[MockedClient.mock.results.length - 1].value;
      const [, elicitHandler] = instance.setRequestHandler.mock.calls[1] as [
        unknown,
        (req: { params: unknown }) => Promise<unknown>,
      ];

      const params = {
        method: 'elicitation/create',
        params: { message: 'test', requestedSchema: { type: 'object', properties: {} } },
      };
      const result = await elicitHandler({ params });

      expect(forwarder).toHaveBeenCalledWith(params);
      expect(result).toEqual(elicitResult);
    });
  });

  describe('roots passthrough', () => {
    it('should pass roots to connectAll and register ListRootsRequestSchema handler', async () => {
      const roots = [{ uri: 'file:///workspace', name: 'workspace' }];
      const config: UpstreamConfig = {
        name: 'server-with-roots',
        transport: 'sse',
        url: 'http://localhost:3000/sse',
      };

      await service.connectAll([config], roots);

      // Client should have been created (setRequestHandler called for sampling, elicitation, roots)
      expect(MockedClient).toHaveBeenCalledTimes(1);
      const instance = MockedClient.mock.results[0].value;
      // setRequestHandler should have been called 3 times: sampling, elicitation, roots
      expect(instance.setRequestHandler).toHaveBeenCalledTimes(3);
    });

    it('should not register ListRootsRequestSchema handler when no roots provided', async () => {
      const config: UpstreamConfig = {
        name: 'server-no-roots',
        transport: 'sse',
        url: 'http://localhost:3000/sse',
      };

      await service.connect(config);

      const instance = MockedClient.mock.results[0].value;
      // Only sampling and elicitation handlers
      expect(instance.setRequestHandler).toHaveBeenCalledTimes(2);
    });
  });

  describe('task status notification passthrough', () => {
    it('registers setNotificationHandler when registry is provided', async () => {
      const mockRegistry = { broadcastNotification: vi.fn() };
      const serviceWithRegistry = new UpstreamManagerService(mockRegistry as never);
      const config: UpstreamConfig = {
        name: 'task-server',
        transport: 'sse',
        url: 'http://localhost:3000/sse',
      };

      await serviceWithRegistry.connect(config);

      const instance = MockedClient.mock.results[MockedClient.mock.results.length - 1].value;
      expect(instance.setNotificationHandler).toHaveBeenCalledOnce();
    });

    it('does not register setNotificationHandler when no registry is provided', async () => {
      // service is created without registry in beforeEach
      const config: UpstreamConfig = {
        name: 'no-registry-server',
        transport: 'sse',
        url: 'http://localhost:3000/sse',
      };

      await service.connect(config);

      const instance = MockedClient.mock.results[MockedClient.mock.results.length - 1].value;
      expect(instance.setNotificationHandler).not.toHaveBeenCalled();
    });

    it('prefixes taskId with upstream name and calls broadcastNotification', async () => {
      const broadcastNotification = vi.fn();
      const mockRegistry = { broadcastNotification };
      const serviceWithRegistry = new UpstreamManagerService(mockRegistry as never);
      const config: UpstreamConfig = {
        name: 'my-upstream',
        transport: 'sse',
        url: 'http://localhost:3000/sse',
      };

      await serviceWithRegistry.connect(config);

      const instance = MockedClient.mock.results[MockedClient.mock.results.length - 1].value;
      // Extract the registered notification handler
      const [, handler] = instance.setNotificationHandler.mock.calls[0] as [
        unknown,
        (n: unknown) => void,
      ];

      // Simulate the upstream emitting a task status notification
      handler({ params: { taskId: 't1', status: 'completed', progress: 1 } });

      expect(broadcastNotification).toHaveBeenCalledWith('notifications/tasks/status', {
        taskId: 'my-upstream::t1',
        status: 'completed',
        progress: 1,
      });
    });
  });
});
