import 'reflect-metadata';
import { RetryService } from './retry.service';

describe('RetryService', () => {
  let service: RetryService;

  beforeEach(() => {
    service = new RetryService();
    vi.spyOn(RetryService.prototype as any, 'sleep').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await service.execute('tool-a', { maxAttempts: 3, backoff: 'fixed' }, fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect((service as any).sleep).not.toHaveBeenCalled();
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
    const sleepSpy = (service as any).sleep as ReturnType<typeof vi.fn>;

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
    const sleepSpy = (service as any).sleep as ReturnType<typeof vi.fn>;

    await expect(
      service.execute('tool-a', { maxAttempts: 4, backoff: 'linear', initialDelay: 100 }, fn),
    ).rejects.toThrow('fail');

    expect(sleepSpy).toHaveBeenCalledTimes(3);
    expect(sleepSpy).toHaveBeenNthCalledWith(1, 100); // 100 * 1
    expect(sleepSpy).toHaveBeenNthCalledWith(2, 200); // 100 * 2
    expect(sleepSpy).toHaveBeenNthCalledWith(3, 300); // 100 * 3
  });

  it('uses exponential backoff with delay capped at maxDelay', async () => {
    // Mock Math.random to remove jitter variability
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // jitter factor = 0.75 + 0.5*0.5 = 1.0

    const fn = vi.fn().mockRejectedValue(new Error('fail'));
    const sleepSpy = (service as any).sleep as ReturnType<typeof vi.fn>;

    await expect(
      service.execute(
        'tool-a',
        { maxAttempts: 5, backoff: 'exponential', initialDelay: 100, maxDelay: 500 },
        fn,
      ),
    ).rejects.toThrow('fail');

    expect(sleepSpy).toHaveBeenCalledTimes(4);
    // With random=0.5, jitter = 0.75 + 0.25 = 1.0
    // attempt 1: 100 * 2^0 * 1.0 = 100
    expect(sleepSpy).toHaveBeenNthCalledWith(1, 100);
    // attempt 2: 100 * 2^1 * 1.0 = 200
    expect(sleepSpy).toHaveBeenNthCalledWith(2, 200);
    // attempt 3: 100 * 2^2 * 1.0 = 400
    expect(sleepSpy).toHaveBeenNthCalledWith(3, 400);
    // attempt 4: 100 * 2^3 * 1.0 = 800 -> capped at 500
    expect(sleepSpy).toHaveBeenNthCalledWith(4, 500);
  });

  it('does not sleep after last failed attempt', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fail'));
    const sleepSpy = (service as any).sleep as ReturnType<typeof vi.fn>;

    await expect(
      service.execute('tool-a', { maxAttempts: 2, backoff: 'fixed', initialDelay: 100 }, fn),
    ).rejects.toThrow('fail');

    // Only 1 sleep call (after attempt 1, not after attempt 2)
    expect(sleepSpy).toHaveBeenCalledTimes(1);
  });
});
