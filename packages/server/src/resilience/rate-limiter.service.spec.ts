import 'reflect-metadata';
import { MCP_RATE_LIMIT_EXCEEDED, McpError } from '@btwld/mcp-common';
import { RateLimiterService } from './rate-limiter.service';

describe('RateLimiterService', () => {
  let service: RateLimiterService;

  beforeEach(() => {
    vi.useFakeTimers();
    service = new RateLimiterService();
  });

  afterEach(() => {
    service.onModuleDestroy();
    vi.useRealTimers();
  });

  it('allows requests within limit', async () => {
    const config = { max: 3, window: '10s' };
    await expect(service.checkLimit('tool-a', config)).resolves.toBeUndefined();
    await expect(service.checkLimit('tool-a', config)).resolves.toBeUndefined();
    await expect(service.checkLimit('tool-a', config)).resolves.toBeUndefined();
  });

  it('throws McpError with MCP_RATE_LIMIT_EXCEEDED when exceeded', async () => {
    const config = { max: 2, window: '10s' };
    await service.checkLimit('tool-a', config);
    await service.checkLimit('tool-a', config);

    try {
      await service.checkLimit('tool-a', config);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      const mcpErr = err as McpError;
      expect(mcpErr.code).toBe(MCP_RATE_LIMIT_EXCEEDED);
      expect(mcpErr.message).toContain("Rate limit exceeded for 'tool-a'");
      expect((mcpErr.data as Record<string, unknown>).retryAfter).toBeGreaterThan(0);
    }
  });

  it('resets after window expires', async () => {
    const config = { max: 1, window: '5s' };
    await service.checkLimit('tool-a', config);

    // Should fail before window expires
    await expect(service.checkLimit('tool-a', config)).rejects.toThrow(McpError);

    // Advance past the 5s window
    vi.advanceTimersByTime(5000);

    // Should succeed again after window resets
    await expect(service.checkLimit('tool-a', config)).resolves.toBeUndefined();
  });

  it('uses per-user bucketing when perUser is true', async () => {
    const config = { max: 1, window: '10s', perUser: true };

    await service.checkLimit('tool-a', config, 'user-1');
    await service.checkLimit('tool-a', config, 'user-2');

    // user-1 is now exhausted
    await expect(service.checkLimit('tool-a', config, 'user-1')).rejects.toThrow(McpError);
    // user-2 is also exhausted
    await expect(service.checkLimit('tool-a', config, 'user-2')).rejects.toThrow(McpError);
  });

  it('uses global bucket when perUser is false', async () => {
    const config = { max: 1, window: '10s', perUser: false };

    await service.checkLimit('tool-a', config, 'user-1');

    // Even a different user shares the same bucket
    await expect(service.checkLimit('tool-a', config, 'user-2')).rejects.toThrow(McpError);
  });

  describe('parseWindow (via checkLimit)', () => {
    it('parses "30s" as 30000ms', async () => {
      const config = { max: 1, window: '30s' };
      await service.checkLimit('tool-s', config);

      // At 29.9s should still be rate limited
      vi.advanceTimersByTime(29_900);
      await expect(service.checkLimit('tool-s', config)).rejects.toThrow(McpError);

      // At 30s window resets
      vi.advanceTimersByTime(100);
      await expect(service.checkLimit('tool-s', config)).resolves.toBeUndefined();
    });

    it('parses "5m" as 300000ms', async () => {
      const config = { max: 1, window: '5m' };
      await service.checkLimit('tool-m', config);

      vi.advanceTimersByTime(299_999);
      await expect(service.checkLimit('tool-m', config)).rejects.toThrow(McpError);

      vi.advanceTimersByTime(1);
      await expect(service.checkLimit('tool-m', config)).resolves.toBeUndefined();
    });

    it('parses "1h" as 3600000ms', async () => {
      const config = { max: 1, window: '1h' };
      await service.checkLimit('tool-h', config);

      vi.advanceTimersByTime(3_599_999);
      await expect(service.checkLimit('tool-h', config)).rejects.toThrow(McpError);

      vi.advanceTimersByTime(1);
      await expect(service.checkLimit('tool-h', config)).resolves.toBeUndefined();
    });

    it('falls back to default window on invalid format', async () => {
      const config = { max: 10, window: 'abc' };
      // Invalid window format falls back to 1s default — does not throw
      await expect(service.checkLimit('tool-bad', config)).resolves.toBeUndefined();
    });
  });

  it('different tools are counted independently', async () => {
    const config = { max: 1, window: '10s' };
    await service.checkLimit('tool-a', config);
    // tool-a exhausted
    await expect(service.checkLimit('tool-a', config)).rejects.toThrow(McpError);
    // tool-b is a separate bucket — unaffected
    await expect(service.checkLimit('tool-b', config)).resolves.toBeUndefined();
  });

  it('perUser:true without userId falls back to tool-level bucket', async () => {
    const config = { max: 1, window: '10s', perUser: true };
    await service.checkLimit('tool-a', config, undefined);
    // Second call without userId hits the same global tool bucket → rate limited
    await expect(service.checkLimit('tool-a', config, undefined)).rejects.toThrow(McpError);
    // Call with a userId uses a distinct per-user bucket → succeeds
    await expect(service.checkLimit('tool-a', config, 'user-1')).resolves.toBeUndefined();
  });
});
