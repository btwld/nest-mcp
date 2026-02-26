import 'reflect-metadata';
import { HttpException, HttpStatus } from '@nestjs/common';
import type { McpAuthModuleOptions } from '../interfaces/auth-module-options.interface';
import { AuthRateLimitGuard } from './auth-rate-limit.guard';

function createMockContext(ip = '127.0.0.1') {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ ip }),
    }),
  } as unknown as import('@nestjs/common').ExecutionContext;
}

describe('AuthRateLimitGuard', () => {
  let guard: AuthRateLimitGuard;

  afterEach(() => {
    guard?.onModuleDestroy();
  });

  it('allows requests under the limit', () => {
    const options = { jwtSecret: 'x'.repeat(32), authRateLimit: { max: 5, window: '1m' } };
    guard = new AuthRateLimitGuard(options as McpAuthModuleOptions);

    for (let i = 0; i < 5; i++) {
      expect(guard.canActivate(createMockContext())).toBe(true);
    }
  });

  it('throws 429 when limit exceeded', () => {
    const options = { jwtSecret: 'x'.repeat(32), authRateLimit: { max: 3, window: '1m' } };
    guard = new AuthRateLimitGuard(options as McpAuthModuleOptions);

    // First 3 should pass
    for (let i = 0; i < 3; i++) {
      guard.canActivate(createMockContext());
    }

    // 4th should throw 429
    try {
      guard.canActivate(createMockContext());
      expect.unreachable('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      const response = (error as HttpException).getResponse() as Record<string, unknown>;
      expect(response.error).toBe('rate_limit_exceeded');
      expect(response.retry_after).toBeGreaterThan(0);
    }
  });

  it('tracks different IPs separately', () => {
    const options = { jwtSecret: 'x'.repeat(32), authRateLimit: { max: 2, window: '1m' } };
    guard = new AuthRateLimitGuard(options as McpAuthModuleOptions);

    guard.canActivate(createMockContext('1.1.1.1'));
    guard.canActivate(createMockContext('1.1.1.1'));

    // Different IP should not be affected
    expect(guard.canActivate(createMockContext('2.2.2.2'))).toBe(true);

    // Original IP should be blocked
    expect(() => guard.canActivate(createMockContext('1.1.1.1'))).toThrow(HttpException);
  });

  it('uses default config when authRateLimit is not set', () => {
    const options = { jwtSecret: 'x'.repeat(32) };
    guard = new AuthRateLimitGuard(options as McpAuthModuleOptions);

    // Default is 20 req/1m — should allow 20
    for (let i = 0; i < 20; i++) {
      expect(guard.canActivate(createMockContext())).toBe(true);
    }

    // 21st should fail
    expect(() => guard.canActivate(createMockContext())).toThrow(HttpException);
  });

  it('calls audit service when rate limited', () => {
    const options = { jwtSecret: 'x'.repeat(32), authRateLimit: { max: 1, window: '1m' } };
    const auditService = { logRateLimited: vi.fn() };
    guard = new AuthRateLimitGuard(
      options as McpAuthModuleOptions,
      auditService as unknown as import('../services/auth-audit.service').AuthAuditService,
    );

    guard.canActivate(createMockContext('10.0.0.1'));

    expect(() => guard.canActivate(createMockContext('10.0.0.1'))).toThrow(HttpException);
    expect(auditService.logRateLimited).toHaveBeenCalledWith('10.0.0.1');
  });
});
