import 'reflect-metadata';
import { AuthenticationError, McpTimeoutError } from '@btwld/mcp-common';
import { RetryService } from './retry.service';

describe('RetryService', () => {
  let service: RetryService;

  beforeEach(() => {
    service = new RetryService();
    vi.spyOn(
      RetryService.prototype as unknown as Record<string, unknown>,
      'sleep',
    ).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await service.execute('tool-a', { maxAttempts: 3, backoff: 'fixed' }, fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect((service as unknown as Record<string, unknown>).sleep).not.toHaveBeenCalled();
  });

  it('retries up to maxAttempts and throws last error', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fail'));
    await expect(
      service.execute('tool-a', { maxAttempts: 3, backoff: 'fixed' }, fn),
    ).rejects.toThrow('fail');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('uses fixed backoff with same delay each time', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fail'));
    const sleepSpy = (service as unknown as Record<string, unknown>).sleep as ReturnType<
      typeof vi.fn
    >;

    await expect(
      service.execute('tool-a', { maxAttempts: 4, backoff: 'fixed', initialDelay: 200 }, fn),
    ).rejects.toThrow('fail');

    // sleep called for attempts 1, 2, 3 (not after last attempt)
    expect(sleepSpy).toHaveBeenCalledTimes(3);
    expect(sleepSpy).toHaveBeenNthCalledWith(1, 200);
    expect(sleepSpy).toHaveBeenNthCalledWith(2, 200);
    expect(sleepSpy).toHaveBeenNthCalledWith(3, 200);
  });

  it('uses linear backoff with initialDelay * attempt', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fail'));
    const sleepSpy = (service as unknown as Record<string, unknown>).sleep as ReturnType<
      typeof vi.fn
    >;

    await expect(
      service.execute('tool-a', { maxAttempts: 4, backoff: 'linear', initialDelay: 100 }, fn),
    ).rejects.toThrow('fail');

    expect(sleepSpy).toHaveBeenCalledTimes(3);
    expect(sleepSpy).toHaveBeenNthCalledWith(1, 100); // 100 * 1
    expect(sleepSpy).toHaveBeenNthCalledWith(2, 200); // 100 * 2
    expect(sleepSpy).toHaveBeenNthCalledWith(3, 300); // 100 * 3
  });

  it('uses exponential backoff with full jitter capped at maxDelay', async () => {
    // Full jitter: delay = random * min(maxDelay, initialDelay * 2^(attempt-1))
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const fn = vi.fn().mockRejectedValue(new Error('fail'));
    const sleepSpy = (service as unknown as Record<string, unknown>).sleep as ReturnType<
      typeof vi.fn
    >;

    await expect(
      service.execute(
        'tool-a',
        { maxAttempts: 5, backoff: 'exponential', initialDelay: 100, maxDelay: 500 },
        fn,
      ),
    ).rejects.toThrow('fail');

    expect(sleepSpy).toHaveBeenCalledTimes(4);
    // attempt 1: 0.5 * min(500, 100 * 2^0) = 0.5 * 100 = 50
    expect(sleepSpy).toHaveBeenNthCalledWith(1, 50);
    // attempt 2: 0.5 * min(500, 100 * 2^1) = 0.5 * 200 = 100
    expect(sleepSpy).toHaveBeenNthCalledWith(2, 100);
    // attempt 3: 0.5 * min(500, 100 * 2^2) = 0.5 * 400 = 200
    expect(sleepSpy).toHaveBeenNthCalledWith(3, 200);
    // attempt 4: 0.5 * min(500, 100 * 2^3) = 0.5 * 500 = 250
    expect(sleepSpy).toHaveBeenNthCalledWith(4, 250);
  });

  it('does not sleep after last failed attempt', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fail'));
    const sleepSpy = (service as unknown as Record<string, unknown>).sleep as ReturnType<
      typeof vi.fn
    >;

    await expect(
      service.execute('tool-a', { maxAttempts: 2, backoff: 'fixed', initialDelay: 100 }, fn),
    ).rejects.toThrow('fail');

    // Only 1 sleep call (after attempt 1, not after attempt 2)
    expect(sleepSpy).toHaveBeenCalledTimes(1);
  });

  // --- Error discrimination ---

  describe('error discrimination', () => {
    it('throws immediately for non-retriable McpError without retrying', async () => {
      const fn = vi.fn().mockRejectedValue(new AuthenticationError('invalid token'));

      await expect(
        service.execute('tool-a', { maxAttempts: 3, backoff: 'fixed' }, fn),
      ).rejects.toThrow('invalid token');

      // Should not retry — only 1 call
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('retries retriable McpError (e.g. McpTimeoutError)', async () => {
      const fn = vi.fn().mockRejectedValue(new McpTimeoutError('op', 1000));

      await expect(
        service.execute('tool-a', { maxAttempts: 3, backoff: 'fixed' }, fn),
      ).rejects.toThrow(McpTimeoutError);

      // Should retry all 3 attempts
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('retries plain Error (non-McpError)', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('network failure'));

      await expect(
        service.execute('tool-a', { maxAttempts: 3, backoff: 'fixed' }, fn),
      ).rejects.toThrow('network failure');

      expect(fn).toHaveBeenCalledTimes(3);
    });
  });

  it('succeeds on retry after first failure', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('transient failure'))
      .mockResolvedValue('success');

    const result = await service.execute('tool-a', { maxAttempts: 3, backoff: 'fixed' }, fn);

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('maxAttempts=1 never retries', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fail'));

    await expect(
      service.execute('tool-a', { maxAttempts: 1, backoff: 'fixed' }, fn),
    ).rejects.toThrow('fail');

    expect(fn).toHaveBeenCalledTimes(1);
    const sleepSpy = (service as unknown as Record<string, unknown>).sleep as ReturnType<typeof vi.fn>;
    expect(sleepSpy).not.toHaveBeenCalled();
  });

  it('uses default initialDelay of 100ms when not provided', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fail'));
    const sleepSpy = (service as unknown as Record<string, unknown>).sleep as ReturnType<typeof vi.fn>;

    await expect(
      service.execute('tool-a', { maxAttempts: 2, backoff: 'fixed' }, fn),
    ).rejects.toThrow('fail');

    expect(sleepSpy).toHaveBeenCalledWith(100);
  });
});
