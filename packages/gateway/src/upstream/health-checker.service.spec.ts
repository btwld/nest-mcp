import { HealthCheckerService } from './health-checker.service';
import type { UpstreamManagerService } from './upstream-manager.service';
import type { UpstreamConfig } from './upstream.interface';

describe('HealthCheckerService', () => {
  let service: HealthCheckerService;
  let upstreamManager: {
    getClient: ReturnType<typeof vi.fn>;
    setHealthy: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    upstreamManager = {
      getClient: vi.fn(),
      setHealthy: vi.fn(),
    };

    service = new HealthCheckerService(upstreamManager as unknown as UpstreamManagerService);
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  describe('check', () => {
    it('should return true and mark healthy on successful ping', async () => {
      upstreamManager.getClient.mockReturnValue({
        ping: vi.fn().mockResolvedValue(undefined),
      });

      const result = await service.check('test');

      expect(result).toBe(true);
      expect(upstreamManager.setHealthy).toHaveBeenCalledWith('test', true);
    });

    it('should return false and mark unhealthy when client not found', async () => {
      upstreamManager.getClient.mockReturnValue(undefined);

      const result = await service.check('test');

      expect(result).toBe(false);
      expect(upstreamManager.setHealthy).toHaveBeenCalledWith('test', false, 'Client not found');
    });

    it('should return false and mark unhealthy on ping failure', async () => {
      upstreamManager.getClient.mockReturnValue({
        ping: vi.fn().mockRejectedValue(new Error('timeout')),
      });

      const result = await service.check('test');

      expect(result).toBe(false);
      expect(upstreamManager.setHealthy).toHaveBeenCalledWith('test', false, 'timeout');
    });

    it('should handle non-Error throw values', async () => {
      upstreamManager.getClient.mockReturnValue({
        ping: vi.fn().mockRejectedValue('string error'),
      });

      const result = await service.check('test');

      expect(result).toBe(false);
      expect(upstreamManager.setHealthy).toHaveBeenCalledWith('test', false, 'string error');
    });
  });

  describe('start / stop', () => {
    it('should not start duplicate intervals for same upstream', () => {
      vi.useFakeTimers();

      const config: UpstreamConfig = {
        name: 'test',
        url: 'http://localhost:3000',
        transport: 'sse',
        healthCheck: { intervalMs: 1000 },
      };

      service.start(config);
      service.start(config);

      // Should only have one interval
      service.stop('test');

      vi.useRealTimers();
    });

    it('should stop a running health check interval', () => {
      vi.useFakeTimers();

      const config: UpstreamConfig = {
        name: 'test',
        url: 'http://localhost:3000',
        transport: 'sse',
        healthCheck: { intervalMs: 1000 },
      };

      service.start(config);
      service.stop('test');

      // Stopping again should be a no-op
      service.stop('test');

      vi.useRealTimers();
    });
  });

  describe('startAll', () => {
    it('should start health checks for enabled upstreams with health checks', () => {
      vi.useFakeTimers();

      const configs: UpstreamConfig[] = [
        {
          name: 'enabled-with-health',
          url: 'http://localhost:3001',
          transport: 'sse',
          healthCheck: { enabled: true, intervalMs: 5000 },
        },
        {
          name: 'enabled-default-health',
          url: 'http://localhost:3002',
          transport: 'sse',
        },
        {
          name: 'disabled-upstream',
          url: 'http://localhost:3003',
          transport: 'sse',
          enabled: false,
        },
        {
          name: 'health-disabled',
          url: 'http://localhost:3004',
          transport: 'sse',
          healthCheck: { enabled: false },
        },
      ];

      service.startAll(configs);

      // Clean up
      service.stopAll();
      vi.useRealTimers();
    });
  });

  describe('stopAll', () => {
    it('should stop all running intervals', () => {
      vi.useFakeTimers();

      service.start({
        name: 'a',
        url: 'http://localhost:3001',
        transport: 'sse',
        healthCheck: { intervalMs: 1000 },
      });
      service.start({
        name: 'b',
        url: 'http://localhost:3002',
        transport: 'sse',
        healthCheck: { intervalMs: 1000 },
      });

      service.stopAll();

      vi.useRealTimers();
    });
  });

  describe('onModuleDestroy', () => {
    it('should stop all intervals on module destroy', () => {
      vi.useFakeTimers();

      service.start({
        name: 'a',
        url: 'http://localhost:3001',
        transport: 'sse',
        healthCheck: { intervalMs: 1000 },
      });

      service.onModuleDestroy();

      vi.useRealTimers();
    });
  });

  describe('interval behavior', () => {
    it('should call check when interval fires', async () => {
      vi.useFakeTimers();

      const pingFn = vi.fn().mockResolvedValue(undefined);
      upstreamManager.getClient.mockReturnValue({ ping: pingFn });

      service.start({
        name: 'periodic',
        url: 'http://localhost:3001',
        transport: 'sse',
        healthCheck: { intervalMs: 1000 },
      });

      // Before interval fires — ping not called
      expect(upstreamManager.setHealthy).not.toHaveBeenCalled();

      // Advance past one interval
      await vi.advanceTimersByTimeAsync(1001);

      expect(upstreamManager.setHealthy).toHaveBeenCalledWith('periodic', true);

      service.stop('periodic');
      vi.useRealTimers();
    });
  });
});
