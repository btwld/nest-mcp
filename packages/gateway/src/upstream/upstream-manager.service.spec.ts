import { UpstreamManagerService } from './upstream-manager.service';
import type { UpstreamConfig } from './upstream.interface';

// Mock the MCP SDK modules
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: vi.fn(),
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn(),
}));

const makeConfig = (overrides?: Partial<UpstreamConfig>): UpstreamConfig => ({
  name: 'test-upstream',
  url: 'http://localhost:3000',
  transport: 'streamable-http',
  ...overrides,
});

describe('UpstreamManagerService', () => {
  let service: UpstreamManagerService;

  beforeEach(() => {
    service = new UpstreamManagerService();
  });

  afterEach(async () => {
    await service.onModuleDestroy();
  });

  describe('connect', () => {
    it('should connect to an upstream and mark it healthy', async () => {
      const config = makeConfig();
      await service.connect(config);

      expect(service.isConnected('test-upstream')).toBe(true);
      expect(service.isHealthy('test-upstream')).toBe(true);
      expect(service.getClient('test-upstream')).toBeDefined();
    });

    it('should skip already-connected upstreams', async () => {
      const config = makeConfig();
      await service.connect(config);
      await service.connect(config);

      expect(service.getAllNames()).toHaveLength(1);
    });

    it('should handle connection errors gracefully', async () => {
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      vi.mocked(Client).mockImplementationOnce(
        () =>
          ({
            connect: vi.fn().mockRejectedValue(new Error('connection refused')),
            close: vi.fn().mockResolvedValue(undefined),
          }) as never,
      );

      const config = makeConfig();
      await service.connect(config);

      expect(service.isConnected('test-upstream')).toBe(false);
      expect(service.isHealthy('test-upstream')).toBe(false);
      const status = service.getStatus('test-upstream');
      expect(status?.error).toBe('connection refused');
    });

    it('should support SSE transport', async () => {
      const config = makeConfig({ transport: 'sse' });
      await service.connect(config);

      expect(service.isConnected('test-upstream')).toBe(true);
    });

    it('should throw for unsupported transport types', async () => {
      const config = makeConfig({ transport: 'stdio' });

      await service.connect(config);

      // stdio is not supported - should fail with error stored
      expect(service.isConnected('test-upstream')).toBe(false);
      const status = service.getStatus('test-upstream');
      expect(status?.error).toContain('Unsupported upstream transport');
    });
  });

  describe('connectAll', () => {
    it('should connect all enabled upstreams', async () => {
      const configs = [
        makeConfig({ name: 'a', transport: 'sse' }),
        makeConfig({ name: 'b', transport: 'streamable-http' }),
      ];

      await service.connectAll(configs);

      expect(service.getAllNames()).toHaveLength(2);
    });

    it('should skip disabled upstreams', async () => {
      const configs = [
        makeConfig({ name: 'enabled' }),
        makeConfig({ name: 'disabled', enabled: false }),
      ];

      await service.connectAll(configs);

      expect(service.getAllNames()).toEqual(['enabled']);
    });
  });

  describe('getters', () => {
    beforeEach(async () => {
      await service.connect(makeConfig());
    });

    it('should return undefined for unknown upstream client', () => {
      expect(service.getClient('unknown')).toBeUndefined();
    });

    it('should return config for connected upstream', () => {
      expect(service.getConfig('test-upstream')).toEqual(makeConfig());
    });

    it('should return undefined config for unknown upstream', () => {
      expect(service.getConfig('unknown')).toBeUndefined();
    });

    it('should return false for unknown upstream health', () => {
      expect(service.isHealthy('unknown')).toBe(false);
    });

    it('should return false for unknown upstream connection', () => {
      expect(service.isConnected('unknown')).toBe(false);
    });
  });

  describe('setHealthy', () => {
    it('should update health status and error', async () => {
      await service.connect(makeConfig());

      service.setHealthy('test-upstream', false, 'ping failed');

      expect(service.isHealthy('test-upstream')).toBe(false);
      const status = service.getStatus('test-upstream');
      expect(status?.error).toBe('ping failed');
      expect(status?.lastHealthCheck).toBeInstanceOf(Date);
    });

    it('should no-op for unknown upstream', () => {
      service.setHealthy('unknown', false);
      expect(service.isHealthy('unknown')).toBe(false);
    });
  });

  describe('getStatus / getAllStatuses', () => {
    it('should return undefined for unknown upstream', () => {
      expect(service.getStatus('unknown')).toBeUndefined();
    });

    it('should return status for connected upstream', async () => {
      await service.connect(makeConfig());

      const status = service.getStatus('test-upstream');
      expect(status).toEqual(
        expect.objectContaining({
          name: 'test-upstream',
          connected: true,
          healthy: true,
          toolCount: 0,
        }),
      );
    });

    it('should return all statuses', async () => {
      await service.connect(makeConfig({ name: 'a' }));
      await service.connect(makeConfig({ name: 'b' }));

      const statuses = service.getAllStatuses();
      expect(statuses).toHaveLength(2);
    });
  });

  describe('getAllConfigs', () => {
    it('should return all configs', async () => {
      await service.connect(makeConfig({ name: 'a' }));
      await service.connect(makeConfig({ name: 'b' }));

      const configs = service.getAllConfigs();
      expect(configs).toHaveLength(2);
      expect(configs.map((c) => c.name)).toEqual(['a', 'b']);
    });
  });

  describe('disconnect', () => {
    it('should remove upstream after disconnect', async () => {
      await service.connect(makeConfig());

      await service.disconnect('test-upstream');

      expect(service.getClient('test-upstream')).toBeUndefined();
      expect(service.getAllNames()).toHaveLength(0);
    });

    it('should no-op for unknown upstream', async () => {
      await service.disconnect('unknown');
      expect(service.getAllNames()).toHaveLength(0);
    });

    it('should handle close errors gracefully', async () => {
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      vi.mocked(Client).mockImplementationOnce(
        () =>
          ({
            connect: vi.fn().mockResolvedValue(undefined),
            close: vi.fn().mockRejectedValue(new Error('close failed')),
          }) as never,
      );

      await service.connect(makeConfig());
      await service.disconnect('test-upstream');

      expect(service.getAllNames()).toHaveLength(0);
    });
  });

  describe('disconnectAll', () => {
    it('should disconnect all upstreams', async () => {
      await service.connect(makeConfig({ name: 'a' }));
      await service.connect(makeConfig({ name: 'b' }));

      await service.disconnectAll();

      expect(service.getAllNames()).toHaveLength(0);
    });
  });
});
